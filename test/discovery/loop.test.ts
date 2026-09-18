import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { runDiscovery } from "../../src/discovery/loop.js";
import { DiscoveryHistory } from "../../src/discovery/history.js";
import { abandonIntervention, escalationRegistry } from "../../src/engine/escalation.js";
import { SessionFactory, type Session } from "../../src/engine/session.js";
import type { PolicyConfig, AppConfig } from "../../src/engine/config.js";
import type { DiscoveryAction } from "../../src/schema/discovery.js";
import type { ModelClient, NextActionParams, ModelDecision } from "../../src/discovery/model.js";
import { OPERATOR_PASS, OPERATOR_USER, startFlaskServer, type FlaskServer } from "../helpers/flask-server.js";

const PORT = 5062;

/**
 * A scripted, no-API-calls stand-in for the real model. Each entry can be a
 * fixed action or a function of the current turn's params (so a script can
 * pick a ref dynamically from whatever the real accessibility snapshot
 * produced, rather than hardcoding one). Indexed by TOTAL nextAction()
 * calls, which includes within-turn retries — that's what lets a script
 * simulate "the model named an unknown ref, then recovered on retry".
 */
class ScriptedModelClient implements ModelClient {
  readonly calls: NextActionParams[] = [];
  constructor(private readonly script: Array<DiscoveryAction | ((params: NextActionParams) => DiscoveryAction)>) {}

  async nextAction(params: NextActionParams): Promise<ModelDecision> {
    this.calls.push(params);
    const index = this.calls.length - 1;
    const entry = this.script[Math.min(index, this.script.length - 1)];
    if (!entry) {
      throw new Error("ScriptedModelClient: empty script");
    }
    const action = typeof entry === "function" ? entry(params) : entry;
    return { action, reasoning: `scripted call ${index}` };
  }
}

function mustFindRef(params: NextActionParams, role: string, name: string): string {
  const found = params.observation.refs.find((ref) => ref.role === role && ref.name === name);
  if (!found) {
    throw new Error(`test fixture: no ${role} "${name}" ref in observation:\n${params.observation.snapshotText}`);
  }
  return found.ref;
}

describe("discovery loop (mocked model, real app and browser)", () => {
  let server: FlaskServer;
  let policy: PolicyConfig;
  let appConfig: AppConfig;
  let activeSession: Session | undefined;

  beforeAll(async () => {
    process.env["FCU_OPERATOR_USER"] = OPERATOR_USER;
    process.env["FCU_OPERATOR_PASS"] = OPERATOR_PASS;
    server = await startFlaskServer(PORT);
    appConfig = {
      baseUrl: server.baseUrl,
      loginPath: "/login",
      usernameSelector: "#txtUser",
      passwordSelector: "#txtPass",
      submitSelector: "input[type=submit]",
      headless: true,
    };
    policy = {
      allowedBaseUrls: [server.baseUrl],
      irreversibleTargets: [{ role: "button", namePattern: "^Close Account$" }],
    };
  }, 30000);

  afterAll(async () => {
    await server?.stop();
  });

  afterEach(async () => {
    if (activeSession) {
      await activeSession.close().catch(() => undefined);
      await activeSession.browser.close().catch(() => undefined);
    }
    activeSession = undefined;
    for (const handle of escalationRegistry.list()) {
      escalationRegistry.remove(handle.record.intervention_id);
    }
  });

  const getSession = async (): Promise<Session> => {
    activeSession = await SessionFactory.create(appConfig);
    return activeSession;
  };

  it("a scripted action sequence ending in done() completes normally", async () => {
    const session = await getSession();
    // SessionFactory login lands on /search already — no navigate needed.
    const model = new ScriptedModelClient([
      (params) => ({ action: "fill", ref: mustFindRef(params, "textbox", "Member ID"), value: "10001" }),
      (params) => ({ action: "click", ref: mustFindRef(params, "button", "Search") }),
      () => ({ action: "done", reason: "member located" }),
    ]);

    const result = await runDiscovery(session, "Look up a member's accounts", {}, policy, model, {
      runId: "scripted-done",
      evidenceRoot: "evidence-test-tmp",
      maxSteps: 10,
    });

    expect(result.status).toBe("goal_reached");
    expect(result.reason).toBe("member located");
    expect(result.turnsExecuted).toBe(3);
  }, 20000);

  it("stuck() triggers escalation with trigger model_stuck", async () => {
    const session = await getSession();
    const model = new ScriptedModelClient([{ action: "stuck", reason: "cannot tell which control to use" }]);
    let observedTrigger: string | undefined;

    const result = await runDiscovery(session, "An intentionally impossible goal", {}, policy, model, {
      runId: "stuck-escalation",
      evidenceRoot: "evidence-test-tmp",
      escalation: { pendingInterventionTtlMs: 10000, humanControlTtlMs: 10000 },
      onEscalation: (interventionId) => {
        const handle = escalationRegistry.get(interventionId);
        if (!handle) return;
        observedTrigger = handle.record.reason.trigger;
        void abandonIntervention(handle);
      },
    });

    expect(observedTrigger).toBe("model_stuck");
    expect(result.status).toBe("escalation_abandoned");
    expect(result.interventionId).toBeDefined();
  }, 20000);

  it("three consecutive no-change actions trigger escalation with trigger no_progress", async () => {
    const session = await getSession();
    // navigate() to the CURRENT url is a genuine no-op — unlike extract(),
    // which is read-only by design and is exempted from this counter (see
    // the "extract() calls never count against no_progress" test below):
    // three of THOSE in a row correctly represent thrashing, not progress.
    const model = new ScriptedModelClient([
      (params) => ({ action: "navigate", url: params.observation.url }),
      (params) => ({ action: "navigate", url: params.observation.url }),
      (params) => ({ action: "navigate", url: params.observation.url }),
    ]);
    let observedTrigger: string | undefined;
    let observedStepsCompleted: string[] | undefined;

    const result = await runDiscovery(session, "Repeatedly do nothing useful", {}, policy, model, {
      runId: "no-progress-escalation",
      evidenceRoot: "evidence-test-tmp",
      escalation: { pendingInterventionTtlMs: 10000, humanControlTtlMs: 10000 },
      onEscalation: (interventionId) => {
        const handle = escalationRegistry.get(interventionId);
        if (!handle) return;
        observedTrigger = handle.record.reason.trigger;
        observedStepsCompleted = handle.record.context.steps_completed;
        void abandonIntervention(handle);
      },
    });

    expect(observedTrigger).toBe("no_progress");
    // All three no-op extracts ran (and were logged) before escalation fired.
    expect(observedStepsCompleted).toEqual(["turn_0", "turn_1", "turn_2"]);
    expect(result.status).toBe("escalation_abandoned");
  }, 20000);

  // Regression test: found via real use, not written speculatively. A real
  // run asked for a member's "account information" and the model correctly
  // called extract() three times in a row — name, then savings, then
  // checking — off one already-loaded page. That's directed, useful work
  // with zero page changes by nature, but the no_progress counter didn't
  // know the difference and escalated a perfectly healthy run.
  it("consecutive successful extract() calls never count against no_progress", async () => {
    const session = await getSession();
    await session.page.goto(`${server.baseUrl}/member/10001`);

    let escalated = false;
    const model = new ScriptedModelClient([
      (params) => ({ action: "extract", ref: mustFindRef(params, "cell", "Jane A. Whitfield"), output_name: "name" }),
      (params) => ({ action: "extract", ref: mustFindRef(params, "cell", "Jane A. Whitfield"), output_name: "name_again" }),
      (params) => ({ action: "extract", ref: mustFindRef(params, "cell", "Jane A. Whitfield"), output_name: "name_yet_again" }),
      () => ({ action: "done", reason: "gathered account information" }),
    ]);

    const result = await runDiscovery(session, "Gather this member's account information", {}, policy, model, {
      runId: "extract-no-progress-regression",
      evidenceRoot: "evidence-test-tmp",
      onEscalation: () => {
        escalated = true;
      },
    });

    expect(escalated).toBe(false);
    expect(result.status).toBe("goal_reached");
    expect(result.turnsExecuted).toBe(4);
  }, 20000);

  it("a policy-blocked action is logged and never executed, and the model is told why on its next turn", async () => {
    const session = await getSession();
    await session.page.goto(`${server.baseUrl}/member/10001`);

    const model = new ScriptedModelClient([
      (params) => ({ action: "click", ref: mustFindRef(params, "button", "Close Account") }),
      () => ({ action: "done", reason: "acknowledged the refusal" }),
    ]);

    const result = await runDiscovery(session, "Close this member's account", {}, policy, model, {
      runId: "policy-blocked",
      evidenceRoot: "evidence-test-tmp",
      maxSteps: 10,
    });

    expect(result.status).toBe("goal_reached");
    // Never actually navigated to the close-confirmation flow.
    expect(session.page.url()).toContain("/member/10001");
    expect(session.page.url()).not.toContain("/close");

    // The second call is a genuinely separate model turn (a fresh
    // observation was taken), and its history includes the refusal.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.historyText).toContain("blocked");
  }, 20000);

  it("refs are stable within a turn, and an action naming an unknown ref is rejected rather than executed", async () => {
    const session = await getSession();
    const model = new ScriptedModelClient([
      { action: "click", ref: "e_this_ref_does_not_exist" },
      () => ({ action: "done", reason: "recovered after the ref was rejected" }),
    ]);

    const result = await runDiscovery(session, "Try an invalid ref, then recover", {}, policy, model, {
      runId: "invalid-ref",
      evidenceRoot: "evidence-test-tmp",
      maxSteps: 10,
    });

    expect(result.status).toBe("goal_reached");
    expect(model.calls).toHaveLength(2);
    // The retry within the SAME turn reused the SAME observation — refs are
    // stable within a turn, not regenerated per attempt.
    expect(model.calls[1]?.observation).toBe(model.calls[0]?.observation);
    expect(model.calls[1]?.retryFeedback).toContain("e_this_ref_does_not_exist");
  }, 20000);
});

describe("DiscoveryHistory", () => {
  it("stays summarized: rendered size plateaus past the window instead of growing linearly with turns", () => {
    const history = new DiscoveryHistory(5);
    const sizes: number[] = [];
    for (let turn = 0; turn < 30; turn += 1) {
      history.push({ turn, summary: `clicked e${turn} -> page changed (a reasonably typical one-line summary)` });
      sizes.push(history.render().length);
    }

    const sizeAtTurn10 = sizes[9];
    const sizeAtTurn29 = sizes[29];
    expect(sizeAtTurn10).toBeDefined();
    expect(sizeAtTurn29).toBeDefined();
    // Past the window, adding more turns must not keep growing the
    // rendered history in proportion to how many more turns happened — this
    // is the concrete, testable form of "does not grow linearly with turns"
    // (a naive unbounded log of one-liners WOULD still grow linearly, just
    // with a small constant; a bounded window does not, past its cap). The
    // small residual growth here is just decimal digit width creeping in
    // turn numbers ("turn 9" -> "turn 29") and the omitted-count marker —
    // not more CONTENT, which is what actually costs tokens.
    const growth = (sizeAtTurn29 ?? 0) - (sizeAtTurn10 ?? 0);
    expect(growth).toBeLessThan(20);
    // For contrast: 19 more turns of un-windowed history at this line
    // length would have added roughly 19 * 70 =~ 1330 characters.
    expect(growth).toBeLessThan(19 * 70);

    // And it is dramatically smaller than what feeding back a FULL
    // observation every turn would cost — the thing the prompt actually
    // warns against ("turn 10 would cost 10x turn 1").
    const typicalFullObservationSize = 4000; // a real trimmed snapshot for this app's pages runs well above this
    expect(sizeAtTurn29 ?? 0).toBeLessThan(typicalFullObservationSize);
  });

  it("omits older turns with a running counter once past the window", () => {
    const history = new DiscoveryHistory(3);
    for (let turn = 0; turn < 10; turn += 1) {
      history.push({ turn, summary: `action ${turn}` });
    }
    const rendered = history.render();
    expect(rendered).toContain("7 earlier turns omitted");
    expect(rendered).toContain("turn 9: action 9");
    expect(rendered).not.toContain("turn 0:");
  });
});
