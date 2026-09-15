import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { replay } from "../../src/engine/replay.js";
import { SessionFactory, type Session } from "../../src/engine/session.js";
import type { AppConfig, PolicyConfig } from "../../src/engine/config.js";
import type { CapabilityArtifact } from "../../src/schema/capability.js";
import { loadExampleArtifact } from "../helpers/fixture.js";
import { OPERATOR_PASS, OPERATOR_USER, startFlaskServer, type FlaskServer } from "../helpers/flask-server.js";

const PORT = 5057;

function tmpEvidenceRoot(): string {
  return mkdtempSync(join(tmpdir(), "evidence-"));
}

function withOverriddenSearchQuery(artifact: CapabilityArtifact, query: string): CapabilityArtifact {
  const clone = structuredClone(artifact);
  const firstStep = clone.steps[0];
  if (!firstStep) {
    throw new Error("fixture has no steps");
  }
  firstStep.value = `/search?${query}`;
  return clone;
}

describe("replay engine (against the real local app)", () => {
  let server: FlaskServer;
  let browser: Browser;
  let policy: PolicyConfig;
  let appConfig: AppConfig;
  // Each test that touches the browser gets its own freshly-logged-in
  // session (own context, own cookies) sharing one underlying browser
  // process: some scenarios here (session expiry) deliberately invalidate
  // the server-side login, which must never leak into another test.
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
    // The fixture is a draft (no legitimate approval record backs it), so
    // these mechanics tests need the dev-only escape hatch — approval-gate
    // behavior itself is covered separately in test/approval.test.ts.
    policy = { allowedBaseUrls: [server.baseUrl], unattended: true, allowDraft: true };
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  afterEach(async () => {
    await activeSession?.close();
    activeSession = undefined;
  });

  const getSession = async (): Promise<Session> => {
    activeSession = await SessionFactory.createInBrowser(browser, appConfig);
    return activeSession;
  };

  it("happy path: a normal member returns a numeric balance with status success", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const evidenceRoot = tmpEvidenceRoot();
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId: "happy-path",
      evidenceRoot,
    });

    expect(result.status).toBe("success");
    if (!("outputs" in result)) return;
    expect(typeof result.outputs["balance"]).toBe("number");
    expect(result.outputs["balance"]).toBeCloseTo(2450.1);
    expect(result.outputs["currency"]).toBe("USD");

    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  it("business outcome: an unknown id returns the declared not-found outcome, not a failure", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const result = await replay(artifact, { member_id: "99999" }, getSession, policy, {
      runId: "not-found",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).not.toBe("failed");
    expect(result.status).not.toBe("escalated");
    expect(result.status).toBe("member_not_found");
    expect("outcome_id" in result && result.outcome_id).toBe("member_not_found");
  });

  it("business outcome: a permission-restricted id returns permission_denied", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const result = await replay(artifact, { member_id: "10002" }, getSession, policy, {
      runId: "permission-denied",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("permission_denied");
    expect("outcome_id" in result && result.outcome_id).toBe("permission_denied");
  });

  it("recoverable: a maintenance interstitial is dismissed and the run still succeeds", async () => {
    const artifact = withOverriddenSearchQuery(loadExampleArtifact(server.baseUrl), "interstitial=1");
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId: "interstitial",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("success");
  }, 20000);

  it("recoverable: a slow-responding member succeeds via wait_and_retry", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const result = await replay(artifact, { member_id: "10003" }, getSession, policy, {
      runId: "slow-load",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("success");
    if (!("outputs" in result)) return;
    expect(typeof result.outputs["balance"]).toBe("number");
  }, 30000);

  it("escalation: an expired session returns status escalated with resumable true", async () => {
    const artifact = withOverriddenSearchQuery(loadExampleArtifact(server.baseUrl), "expire=1");
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId: "escalated",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("escalated");
    expect("resumable" in result && result.resumable).toBe(true);
  }, 20000);

  it("hard failure: a server error returns status failed with a useful observed value", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const result = await replay(artifact, { member_id: "10004" }, getSession, policy, {
      runId: "hard-failure",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("failed");
    if (!("observed" in result)) return;
    expect(result.observed).not.toMatch(/^\s*Error:/); // not a raw stack trace
    expect(result.observed.length).toBeGreaterThan(0);
  });

  it("invalid input: a malformed id fails pre-flight without launching a browser", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const sessionSpy = vi.fn(getSession);

    const result = await replay(artifact, { member_id: "abc" }, sessionSpy, policy, {
      runId: "invalid-input",
      evidenceRoot: tmpEvidenceRoot(),
    });

    expect(result.status).toBe("invalid_input");
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("redaction: the pii-tagged input value never appears anywhere in evidence", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "redaction-check";
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, { runId, evidenceRoot });
    expect(result.status).toBe("success");

    const stepsLog = readFileSync(join(evidenceRoot, runId, "steps.jsonl"), "utf8");
    const resultJson = readFileSync(join(evidenceRoot, runId, "result.json"), "utf8");

    expect(stepsLog).not.toContain("10001");
    expect(resultJson).not.toContain("10001");
    // Confirms the fill step really would have logged the raw value had the
    // Redactor not scrubbed it — otherwise the assertions above would pass
    // vacuously.
    expect(stepsLog).toContain("[REDACTED]");
  });
});
