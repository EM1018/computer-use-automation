/**
 * Routes discovery's two escalation triggers (model_stuck, no_progress)
 * through the SAME machinery replay uses — Session's RUNNING/
 * PENDING_INTERVENTION/HUMAN_CONTROL/RESUMING lifecycle, the shared
 * escalationRegistry, EvidenceWriter.writeIntervention through the
 * Redactor (see ../engine/escalation.ts). The enum values were already
 * wired for this when the escalation protocol was built.
 *
 * Two things are deliberately NOT reused, both flagged rather than forced:
 *
 * 1. replay's `deriveResumeContract` / `verifyResume`. Both are built
 *    around a declared artifact step's checkpoint, which discovery doesn't
 *    have — there is no artifact yet. Discovery's "re-verification" is
 *    structural rather than declarative: the agent loop always takes a
 *    fresh observation and lets the MODEL decide before doing anything
 *    else, every single turn, escalation or not. There is nothing for a
 *    separate page-state checkpoint to usefully re-check beyond that, so
 *    the resume contract below is intentionally trivial (always
 *    satisfied) — the real "never blindly continue" guarantee comes from
 *    the loop's own structure, not from a checkpoint assertion.
 *
 * 2. replay's fire-and-forget "return escalated immediately, keep going
 *    out-of-band" pattern. That exists because a production caller
 *    (an agent's request) can't be left holding a connection open for an
 *    hour. Discovery is a single CLI/script invocation with no such
 *    caller — nothing is waiting on a fast response — so the discovery
 *    loop just awaits `awaitDiscoveryEscalationResolution` directly.
 *    A human still acts through the same operator server, on the same
 *    live session, exactly as they would for a replay escalation.
 */
import {
  buildInterventionRecord,
  escalationRegistry,
  terminateAndCloseSession,
  type EscalationHandle,
} from "../engine/escalation.js";
import type { EvidenceWriter } from "../engine/evidence.js";
import type { Session } from "../engine/session.js";
import type { EscalationTtlConfig } from "../engine/config.js";
import type { ResumeContract } from "../schema/intervention.js";

export async function escalateDiscovery(params: {
  session: Session;
  evidence: EvidenceWriter;
  runId: string;
  goal: string;
  trigger: "model_stuck" | "no_progress";
  detail: string;
  currentTurnLabel: string;
  turnsCompleted: string[];
  currentUrl: string;
  screenshotPath: string;
}): Promise<EscalationHandle> {
  const resumeContract: ResumeContract = {
    expected_state:
      "a human has acted (or decided no action is needed); the agent will take a fresh observation and decide its next step from there, not resume a fixed plan",
    checkpoint: { kind: "url_matches", pattern: ".*" },
    next_step: "continue",
  };

  const record = buildInterventionRecord({
    session: params.session,
    runId: params.runId,
    capability: "discovery",
    goal: params.goal,
    trigger: params.trigger,
    detail: params.detail,
    currentStep: params.currentTurnLabel,
    stepsCompleted: params.turnsCompleted,
    currentUrl: params.currentUrl,
    screenshotPath: params.screenshotPath,
    resumeContract,
  });
  await params.evidence.writeIntervention(record);

  params.session.beginEscalation();
  const handle: EscalationHandle = { session: params.session, evidence: params.evidence, record };
  escalationRegistry.register(handle);
  return handle;
}

export type DiscoveryEscalationOutcome = "resumed" | "abandoned" | "pending_timeout" | "human_timeout";

/**
 * Blocks (via Session's own condition variables — no polling) until a
 * human resolves the intervention one way or another, or a TTL expires.
 * Mirrors the state-checking shape of replay's continueAfterEscalation in
 * ../engine/replay.ts, but returns a plain outcome instead of writing a
 * CapabilityResult — discovery's caller (the loop, in-process) constructs
 * its own DiscoveryResult from this directly.
 */
export async function awaitDiscoveryEscalationResolution(
  handle: EscalationHandle,
  ttl: EscalationTtlConfig,
): Promise<DiscoveryEscalationOutcome> {
  const session = handle.session;
  const interventionId = handle.record.intervention_id;

  await session.awaitClaim(ttl.pendingInterventionTtlMs);
  const afterClaim: typeof session.state = session.state;

  if (afterClaim === "terminated") {
    // Abandoned before anyone claimed it — abandonIntervention() already
    // wrote the record and closed the session.
    escalationRegistry.remove(interventionId);
    return "abandoned";
  }
  if (afterClaim === "pending_intervention") {
    handle.record = { ...handle.record, status: "timed_out" };
    await handle.evidence.writeIntervention(handle.record);
    escalationRegistry.remove(interventionId);
    await terminateAndCloseSession(session);
    return "pending_timeout";
  }

  // afterClaim === "human_control": claimed within the TTL.
  await session.awaitResume(ttl.humanControlTtlMs);
  const afterResume: typeof session.state = session.state;

  if (afterResume === "terminated") {
    // Abandoned while a human held control.
    escalationRegistry.remove(interventionId);
    return "abandoned";
  }
  if (afterResume === "human_control") {
    // awaitResume resolved "timed_out": claimed, but never handed back.
    session.reclaim();
    await terminateAndCloseSession(session);
    return "human_timeout";
  }

  // afterResume === "resuming": a human called resume().
  escalationRegistry.remove(interventionId);
  session.finishResume();
  return "resumed";
}
