import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import { ControlViolation } from "./errors.js";

export type Controller = "automation" | "human";

/**
 * The session's coarser lifecycle, layered on top of `controller`.
 * `controller` is the fine-grained mutual-exclusion gate every engine action
 * asserts before touching the browser; `state` is the escalation protocol
 * built around it. PENDING_INTERVENTION is deliberately its own state,
 * distinct from HUMAN_CONTROL: between "automation stopped" and "a human is
 * actually at the keyboard" there is a gap where nobody is driving, and that
 * gap needs its own timeout.
 */
export type SessionState = "running" | "pending_intervention" | "human_control" | "resuming" | "terminated";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Races `promise` against a `timeoutMs` timer, resolving to `onTimeout` if the timer wins. Always clears the timer — never leaves a dangling handle. */
async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A live browser session. The engine does not own this — a Session outlives
 * any single replay run so that a human can later take over the exact same
 * browser (cede/reclaim), rather than automation always owning its own
 * throwaway browser.
 *
 * `assertControlled` is the mutual-exclusion guarantee: every engine code
 * path that is about to touch the browser calls it first, and it throws
 * rather than proceeding whenever control has been ceded to a human.
 */
export class Session {
  readonly id: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  private _controller: Controller;
  private _state: SessionState;
  private claimSignal: ReturnType<typeof deferred<void>> | undefined;
  private resumeSignal: ReturnType<typeof deferred<void>> | undefined;

  constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.id = randomUUID();
    this.browser = browser;
    this.context = context;
    this.page = page;
    this._controller = "automation";
    this._state = "running";
  }

  get controller(): Controller {
    return this._controller;
  }

  get state(): SessionState {
    return this._state;
  }

  cede(): void {
    this._controller = "human";
  }

  reclaim(): void {
    this._controller = "automation";
  }

  /** Throws ControlViolation unless automation currently holds control. */
  assertControlled(): void {
    if (this._controller !== "automation") {
      throw new ControlViolation(this.id);
    }
  }

  private requireState(expected: SessionState, action: string): void {
    if (this._state !== expected) {
      throw new Error(`session "${this.id}": cannot ${action} from state "${this._state}" (expected "${expected}")`);
    }
  }

  /**
   * RUNNING -> PENDING_INTERVENTION. Called by the engine the moment it
   * decides a run can't safely continue unattended. Arms the condition
   * variable `awaitClaim` blocks on.
   */
  beginEscalation(): void {
    this.requireState("running", "beginEscalation");
    this._state = "pending_intervention";
    this.claimSignal = deferred<void>();
  }

  /**
   * Blocks (no polling) until a human calls `claim()`, or `timeoutMs`
   * elapses. Resolves to "timed_out" in the latter case — the caller is
   * responsible for terminating the run and closing the session.
   */
  async awaitClaim(timeoutMs: number): Promise<"claimed" | "timed_out"> {
    this.requireState("pending_intervention", "awaitClaim");
    const signal = this.claimSignal;
    if (!signal) {
      throw new Error(`session "${this.id}": awaitClaim called with no armed claim signal`);
    }
    return raceTimeout(signal.promise.then((): "claimed" => "claimed"), timeoutMs, "timed_out");
  }

  /**
   * PENDING_INTERVENTION -> HUMAN_CONTROL. Called by the operator surface
   * when a human claims the intervention. Cedes control to the human and
   * arms the condition variable `awaitResume` blocks on.
   */
  claim(): void {
    this.requireState("pending_intervention", "claim");
    this._state = "human_control";
    this.cede();
    this.resumeSignal = deferred<void>();
    this.claimSignal?.resolve();
  }

  /**
   * Blocks (no polling) until a human calls `resume()`, or `timeoutMs`
   * elapses. Resolves to "timed_out" in the latter case — the caller is
   * responsible for reclaiming, failing the run, and closing the session.
   */
  async awaitResume(timeoutMs: number): Promise<"resumed" | "timed_out"> {
    this.requireState("human_control", "awaitResume");
    const signal = this.resumeSignal;
    if (!signal) {
      throw new Error(`session "${this.id}": awaitResume called with no armed resume signal`);
    }
    return raceTimeout(signal.promise.then((): "resumed" => "resumed"), timeoutMs, "timed_out");
  }

  /**
   * HUMAN_CONTROL -> RESUMING. Called by the operator surface when a human
   * signals they're done. Reclaims control immediately so automation may
   * re-verify page state (never blindly continue), but the engine must
   * still call `finishResume()` once that re-verification passes before the
   * run is considered back in RUNNING.
   */
  resume(): void {
    this.requireState("human_control", "resume");
    this._state = "resuming";
    this.reclaim();
    this.resumeSignal?.resolve();
  }

  /** RESUMING -> RUNNING, once the engine's re-verification against `resume_contract` has passed. */
  finishResume(): void {
    this.requireState("resuming", "finishResume");
    this._state = "running";
  }

  /**
   * Terminal, from any non-terminated state — including while a
   * PENDING_INTERVENTION or HUMAN_CONTROL wait is in flight, which is what
   * lets `abandon` and TTL expiry wake a blocked `awaitClaim`/`awaitResume`
   * immediately rather than leaving it hanging until its own timeout.
   */
  terminate(): void {
    this._state = "terminated";
    this.claimSignal?.resolve();
    this.resumeSignal?.resolve();
  }

  /** Closes this session's own context. The browser may be shared by other sessions, and outlives this call. */
  async close(): Promise<void> {
    await this.context.close();
  }
}

export class SessionFactory {
  /**
   * Launches a dedicated browser, logs in against `appConfig` using
   * operator credentials read from the environment, and returns a Session
   * sitting on the post-login screen. Login is not part of any capability
   * artifact: credentials never enter artifact data, and this is the only
   * place they are read.
   */
  static async create(appConfig: AppConfig): Promise<Session> {
    const browser = await chromium.launch({
      headless: appConfig.headless ?? false,
      ...(appConfig.slowMoMs ? { slowMo: appConfig.slowMoMs } : {}),
    });
    return SessionFactory.createInBrowser(browser, appConfig);
  }

  /** Same login flow as `create`, but against a caller-supplied, possibly shared, browser instance. */
  static async createInBrowser(browser: Browser, appConfig: AppConfig): Promise<Session> {
    const username = process.env["FCU_OPERATOR_USER"];
    const password = process.env["FCU_OPERATOR_PASS"];
    if (!username || !password) {
      throw new Error("FCU_OPERATOR_USER and FCU_OPERATOR_PASS must both be set in the environment");
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(new URL(appConfig.loginPath, appConfig.baseUrl).toString(), { waitUntil: "load" });
    await page.locator(appConfig.usernameSelector).fill(username);
    await page.locator(appConfig.passwordSelector).fill(password);
    await Promise.all([page.waitForLoadState("load"), page.locator(appConfig.submitSelector).click()]);

    return new Session(browser, context, page);
  }
}
