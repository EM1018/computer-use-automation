import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import { ControlViolation } from "./errors.js";

export type Controller = "automation" | "human";

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

  constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.id = randomUUID();
    this.browser = browser;
    this.context = context;
    this.page = page;
    this._controller = "automation";
  }

  get controller(): Controller {
    return this._controller;
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
