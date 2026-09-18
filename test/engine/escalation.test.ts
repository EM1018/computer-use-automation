import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { replay } from "../../src/engine/replay.js";
import { SessionFactory, type Session } from "../../src/engine/session.js";
import { ControlViolation } from "../../src/engine/errors.js";
import { EvidenceWriter } from "../../src/engine/evidence.js";
import { Redactor } from "../../src/engine/redactor.js";
import {
  abandonIntervention,
  claimIntervention,
  escalationRegistry,
  resumeIntervention,
} from "../../src/engine/escalation.js";
import type { AppConfig, PolicyConfig } from "../../src/engine/config.js";
import type { CapabilityArtifact } from "../../src/schema/capability.js";
import { InterventionRecordSchema, type InterventionRecord } from "../../src/schema/intervention.js";
import type { CapabilityResult } from "../../src/schema/result.js";
import { loadExampleArtifact } from "../helpers/fixture.js";
import { OPERATOR_PASS, OPERATOR_USER, startFlaskServer, type FlaskServer } from "../helpers/flask-server.js";

const PORT = 5059;

function tmpEvidenceRoot(): string {
  return mkdtempSync(join(tmpdir(), "evidence-esc-"));
}

/** Forces the same session_expired escalation exercised by the demo script and by test/engine/replay.test.ts's "escalation" case. */
function withExpireQuery(artifact: CapabilityArtifact): CapabilityArtifact {
  const clone = structuredClone(artifact);
  const firstStep = clone.steps[0];
  if (!firstStep) {
    throw new Error("fixture has no steps");
  }
  firstStep.value = "/search?expire=1";
  return clone;
}

function readIntervention(evidenceRoot: string, runId: string, interventionId: string): InterventionRecord {
  const raw = readFileSync(join(evidenceRoot, runId, "interventions", `${interventionId}.yaml`), "utf8");
  return InterventionRecordSchema.parse(yaml.load(raw));
}

/** Polls result.json for a final (non-"escalated") outcome — black-box observation of the out-of-band continuation from the test's side, not a stand-in for the engine's own condition-variable waits. */
async function waitForResultFile(evidenceRoot: string, runId: string, timeoutMs: number): Promise<CapabilityResult> {
  const path = join(evidenceRoot, runId, "result.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = JSON.parse(readFileSync(path, "utf8")) as CapabilityResult;
      if (!("resumable" in result)) {
        return result;
      }
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for a final result for run "${runId}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("human-in-the-loop escalation", () => {
  let server: FlaskServer;
  let policy: PolicyConfig;
  let appConfig: AppConfig;
  // Each test gets its own dedicated browser (unlike replay.test.ts's shared
  // one): escalation teardown (abandon, TTL expiry) legitimately closes the
  // whole browser, which would take out a shared instance from under other
  // tests.
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
    policy = { allowedBaseUrls: [server.baseUrl], unattended: true, allowDraft: true };
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

  it("a declared_escalation recoverable produces an intervention record with a populated resume_contract", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "intervention-record";
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, { runId, evidenceRoot });

    expect(result.status).toBe("escalated");
    if (!("intervention_id" in result)) return;

    const record = readIntervention(evidenceRoot, runId, result.intervention_id);
    expect(record.reason.trigger).toBe("declared_escalation");
    expect(record.status).toBe("pending");
    expect(record.context.current_step).toBe("s2");
    expect(record.context.steps_completed).toEqual(["s1"]);
    expect(record.resume_contract.next_step).toBe("s2");
    // Declared on the fixture's session_expired recoverable — the authored
    // path, not the generic fallback derivation.
    expect(record.resume_contract.checkpoint).toEqual({ kind: "element_present", within: "#f_mbr_id" });
    expect(record.resume_contract.expected_state.length).toBeGreaterThan(0);

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 20000);

  it("policy_block escalates before performing an irreversible step, never after", async () => {
    const artifact = structuredClone(loadExampleArtifact(server.baseUrl));
    const fillStep = artifact.steps.find((step) => step.id === "s2");
    if (!fillStep) {
      throw new Error("fixture is missing step s2");
    }
    fillStep.risk = "irreversible";

    const evidenceRoot = tmpEvidenceRoot();
    const runId = "policy-block";
    const blockedPolicy: PolicyConfig = { ...policy, confirmIrreversible: false };
    const result = await replay(artifact, { member_id: "10001" }, getSession, blockedPolicy, { runId, evidenceRoot });

    expect(result.status).toBe("escalated");
    if (!("intervention_id" in result)) return;

    const record = readIntervention(evidenceRoot, runId, result.intervention_id);
    expect(record.reason.trigger).toBe("policy_block");
    expect(record.context.current_step).toBe("s2");
    // s2 was blocked, not attempted — only s1 completed.
    expect(record.context.steps_completed).toEqual(["s1"]);
    // policy_block resumes AFTER the blocked step: a human who performs an
    // irreversible action manually shouldn't have automation redo it.
    expect(record.resume_contract.next_step).toBe("s3");

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 20000);

  it("the intervention record is redacted before being written to disk", async () => {
    const artifact = loadExampleArtifact(server.baseUrl);
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "intervention-redaction";
    const redactor = new Redactor(artifact.inputs, { member_id: "10001" });
    const evidence = new EvidenceWriter(evidenceRoot, runId, redactor);

    const record: InterventionRecord = {
      intervention_id: "test-intervention",
      session_id: "test-session",
      run_id: runId,
      created_at: new Date().toISOString(),
      reason: { trigger: "declared_escalation", detail: "member 10001's session expired mid-lookup" },
      context: {
        capability: "lookup_savings_balance@1.0",
        goal: artifact.capability.description,
        current_step: "s2",
        steps_completed: ["s1"],
        current_url: `${server.baseUrl}/member/10001`,
        screenshot_path: join(evidenceRoot, runId, "failure.png"),
      },
      resume_contract: {
        expected_state: "ready to retry step s2",
        checkpoint: { kind: "element_present", within: "#f_mbr_id" },
        next_step: "s2",
      },
      status: "pending",
    };

    await evidence.writeIntervention(record);
    const raw = readFileSync(join(evidenceRoot, runId, "interventions", "test-intervention.yaml"), "utf8");

    expect(raw).not.toContain("10001");
    // Confirms the pii-tagged value really would have appeared had the
    // Redactor not scrubbed it — otherwise the assertion above passes vacuously.
    expect(raw).toContain("[REDACTED]");

    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  it("claim cedes control to human; a subsequent automation action throws ControlViolation", async () => {
    const session = await getSession();
    const artifact = loadExampleArtifact(server.baseUrl);
    const evidenceRoot = tmpEvidenceRoot();
    const evidence = new EvidenceWriter(evidenceRoot, "claim-test", new Redactor(artifact.inputs, {}));

    session.beginEscalation();
    const handle = {
      session,
      evidence,
      record: {
        intervention_id: "claim-test-intervention",
        session_id: session.id,
        run_id: "claim-test",
        created_at: new Date().toISOString(),
        reason: { trigger: "declared_escalation" as const, detail: "test" },
        context: {
          capability: "lookup_savings_balance@1.0",
          goal: "test",
          current_step: "s2",
          steps_completed: ["s1"],
          current_url: session.page.url(),
          screenshot_path: "n/a",
        },
        resume_contract: {
          expected_state: "test",
          checkpoint: { kind: "element_present" as const, within: "#f_mbr_id" },
          next_step: "s2",
        },
        status: "pending" as const,
      },
    };

    expect(session.controller).toBe("automation");
    await claimIntervention(handle);
    expect(session.controller).toBe("human");
    expect(() => session.assertControlled()).toThrow(ControlViolation);

    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  it("resume with the contract satisfied re-verifies and continues from next_step to success", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "resume-success";
    const escalated = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 5000, humanControlTtlMs: 5000 },
    });
    expect(escalated.status).toBe("escalated");
    if (!("intervention_id" in escalated)) return;

    const handle = escalationRegistry.get(escalated.intervention_id);
    expect(handle).toBeDefined();
    if (!handle) return;

    await claimIntervention(handle);
    expect(handle.session.controller).toBe("human");

    // The human logs back in, in the SAME live page the automation left on
    // the expired-session login screen.
    await handle.session.page.locator(appConfig.usernameSelector).fill(OPERATOR_USER);
    await handle.session.page.locator(appConfig.passwordSelector).fill(OPERATOR_PASS);
    await Promise.all([
      handle.session.page.waitForLoadState("load"),
      handle.session.page.locator(appConfig.submitSelector).click(),
    ]);

    await resumeIntervention(handle);

    const final = await waitForResultFile(evidenceRoot, runId, 10000);
    expect(final.status).toBe("success");
    if ("outputs" in final) {
      expect(final.outputs["balance"]).toBeCloseTo(2450.1);
    }

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 30000);

  it("resume with the page in an unexpected state hard-fails instead of blindly continuing", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "resume-unexpected";
    const escalated = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 5000, humanControlTtlMs: 5000 },
    });
    if (!("intervention_id" in escalated)) throw new Error("expected an escalation");
    const handle = escalationRegistry.get(escalated.intervention_id);
    if (!handle) throw new Error("no handle registered for the escalation");

    // The human claims but does nothing useful — still sitting on the
    // expired-session login page — then hits resume anyway.
    await claimIntervention(handle);
    await resumeIntervention(handle);

    const final = await waitForResultFile(evidenceRoot, runId, 10000);
    expect(final.status).toBe("failed");
    if ("expected" in final && "observed" in final) {
      expect(final.expected).toBe(handle.record.resume_contract.expected_state);
      expect(final.observed.length).toBeGreaterThan(0);
    }

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 20000);

  it("PENDING_INTERVENTION TTL expiry terminates the run and closes the session", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "pending-ttl";
    const escalated = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 300, humanControlTtlMs: 60000 },
    });
    if (!("intervention_id" in escalated)) throw new Error("expected an escalation");

    const final = await waitForResultFile(evidenceRoot, runId, 5000);
    expect(final.status).toBe("escalation_timeout");
    expect(escalationRegistry.get(escalated.intervention_id)).toBeUndefined();
    expect(activeSession?.state).toBe("terminated");
    expect(activeSession?.browser.isConnected()).toBe(false);

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 15000);

  it("human actions are logged with actor \"human\" at coarse granularity, never field values", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "human-action-log";
    const escalated = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 10000, humanControlTtlMs: 10000 },
    });
    if (!("intervention_id" in escalated)) throw new Error("expected an escalation");
    const handle = escalationRegistry.get(escalated.intervention_id);
    if (!handle) throw new Error("no handle registered for the escalation");

    await claimIntervention(handle);
    await handle.session.page.locator(appConfig.usernameSelector).fill(OPERATOR_USER);
    await handle.session.page.locator(appConfig.passwordSelector).fill(OPERATOR_PASS);
    await Promise.all([
      handle.session.page.waitForLoadState("load"),
      handle.session.page.locator(appConfig.submitSelector).click(),
    ]);
    await resumeIntervention(handle);
    await waitForResultFile(evidenceRoot, runId, 10000);

    const stepsLog = readFileSync(join(evidenceRoot, runId, "steps.jsonl"), "utf8");
    const entries = stepsLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { actor: string; action: string; detail?: string });
    const humanEntries = entries.filter((entry) => entry.actor === "human");

    expect(humanEntries.length).toBeGreaterThan(0);
    expect(humanEntries.some((entry) => entry.action === "fill")).toBe(true);
    expect(humanEntries.some((entry) => entry.action === "click")).toBe(true);
    // Coarse: which field, never what was typed into it.
    expect(stepsLog).not.toContain(OPERATOR_PASS);
    for (const entry of humanEntries) {
      expect(entry.detail ?? "").not.toContain(OPERATOR_PASS);
    }

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 20000);

  it("the caller-facing escalated result returns immediately, not after the human-control wait", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "immediate-return";

    const start = Date.now();
    const result = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 5000, humanControlTtlMs: 5000 },
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe("escalated");
    // Well under either TTL — proves replay() did not block waiting on a
    // human, even though the run is still live and continuing out-of-band.
    expect(elapsed).toBeLessThan(3000);

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 15000);

  it("abandon terminates the run and closes the session without a blind continue", async () => {
    const artifact = withExpireQuery(loadExampleArtifact(server.baseUrl));
    const evidenceRoot = tmpEvidenceRoot();
    const runId = "abandon";
    const escalated = await replay(artifact, { member_id: "10001" }, getSession, policy, {
      runId,
      evidenceRoot,
      escalation: { pendingInterventionTtlMs: 10000, humanControlTtlMs: 10000 },
    });
    if (!("intervention_id" in escalated)) throw new Error("expected an escalation");
    const handle = escalationRegistry.get(escalated.intervention_id);
    if (!handle) throw new Error("no handle registered for the escalation");

    await abandonIntervention(handle);
    escalationRegistry.remove(escalated.intervention_id);

    expect(handle.record.status).toBe("abandoned");
    expect(handle.session.state).toBe("terminated");
    expect(handle.session.browser.isConnected()).toBe(false);

    // Regression check: abandon must write a real terminal result, not just
    // update the intervention record — otherwise anything polling
    // result.json (a caller, the demo script) blocks forever since it never
    // moves off "escalated".
    const final = JSON.parse(readFileSync(join(evidenceRoot, runId, "result.json"), "utf8")) as CapabilityResult;
    expect(final.status).toBe("failed");
    expect("resumable" in final).toBe(false);

    rmSync(evidenceRoot, { recursive: true, force: true });
  }, 15000);
});
