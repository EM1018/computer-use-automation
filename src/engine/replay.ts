/**
 * The deterministic replay engine.
 *
 * This module is a GENERIC INTERPRETER over the capability artifact shapes
 * (steps, strategies, checkpoints, outcomes, recoverables). It contains no
 * knowledge of what any particular artifact's fields mean in the real
 * world — everything app-specific lives in the artifact, not here.
 *
 * Explicit non-goals, enforced by design, not by a flag:
 *   - No LLM calls anywhere.
 *   - No self-healing beyond the declared strategy ladder — a locator
 *     either resolves per the recorded rules, or the run stops.
 *   - No inference about unexpected page state — anything not covered by a
 *     step's own checkpoint, a declared outcome, or a declared recoverable
 *     is a hard failure.
 *   - No writing to artifacts. Replay only ever reads one; only discovery
 *     (not built here) writes one.
 *   - No fixed sleeps used as a substitute for checking a condition. The
 *     one deliberate delay in this file is the artifact-declared
 *     `backoff_ms` pause before a wait_and_retry attempt, which is data,
 *     not a guess.
 *
 * Caller-facing boundary for escalation: when a run can't safely continue
 * unattended, `replay()` returns `{ status: "escalated", ... }` immediately
 * — it does NOT block the caller for the duration of human work. The run
 * keeps going out-of-band: `startEscalation` writes the intervention record
 * and kicks off (without awaiting) `continueAfterEscalation`, which blocks
 * on the session's own condition variables (see Session.awaitClaim /
 * awaitResume — a real Promise a human's action resolves, not a polling
 * loop) until a human claims and resumes it, then re-verifies page state
 * and keeps interpreting the artifact from there. The eventual outcome is
 * only ever observable via evidence/<run_id>/result.json (rewritten when
 * the continuation finishes) — nothing about this design lets a caller
 * await it directly, which is the point: an agent that escalated is not
 * meant to sit there holding a request open for up to an hour.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Checkpoint, RecoveryAction, Step, Transform, Wait } from "../schema/capability.js";
import type { CapabilityArtifact } from "../schema/capability.js";
import type { EscalationTrigger } from "../schema/intervention.js";
import type { CapabilityResult, EscalationTimeoutResult, FailedResult } from "../schema/result.js";
import { AmbiguousTarget, NoTargetFound, StepUnmet } from "./errors.js";
import { checkpointMatches, describeObserved } from "./detect.js";
import { resolveFrameScope, resolveTarget, type AriaRole, type ResolvedTarget } from "./locate.js";
import { preflight, type InvocationInputs } from "./policy.js";
import type { EscalationTtlConfig, PolicyConfig } from "./config.js";
import { DEFAULT_ESCALATION_TTL, GLOBAL_RECOVERY_CAP } from "./config.js";
import { Redactor } from "./redactor.js";
import { EvidenceWriter, type StepLogEntry } from "./evidence.js";
import type { Session } from "./session.js";
import {
  buildInterventionRecord,
  deriveResumeContract,
  escalationRegistry,
  verifyResume,
  type EscalationHandle,
} from "./escalation.js";

export interface ReplayOptions {
  runId?: string;
  /** Directory evidence/<run_id>/ is created under. Defaults to "evidence". */
  evidenceRoot?: string;
  /** Overrides for the PENDING_INTERVENTION / HUMAN_CONTROL timeouts. Unset fields fall back to DEFAULT_ESCALATION_TTL. */
  escalation?: Partial<EscalationTtlConfig>;
}

interface RunContext {
  page: Page;
  artifact: CapabilityArtifact;
  runId: string;
  inputs: InvocationInputs;
  outputs: Record<string, string | number | boolean>;
  recoveryAttempts: Map<string, number>;
  globalRecoveryCount: { count: number };
  session: Session;
  /** Ids of steps that completed successfully so far, across the initial leg and any resumed continuation. */
  stepsCompleted: string[];
  startedAt: number;
}

/**
 * `getSession` is a lazy provider rather than an already-created Session:
 * creating one launches a real browser, and pre-flight (contract, then
 * policy, then approval) must be able to reject a run before any browser
 * work happens. It is only invoked once pre-flight has passed.
 */
export async function replay(
  artifact: CapabilityArtifact,
  rawInputs: InvocationInputs,
  getSession: () => Promise<Session>,
  policy: PolicyConfig,
  options: ReplayOptions = {},
): Promise<CapabilityResult> {
  const runId = options.runId ?? randomUUID();

  const pre = preflight(artifact, rawInputs, policy, runId);
  if (!pre.ok) {
    // Nothing here has touched the browser; nothing here writes evidence.
    return pre.result;
  }

  const session = await getSession();
  const redactor = new Redactor(artifact, pre.values);
  redactor.registerValue(process.env["FCU_OPERATOR_USER"]);
  redactor.registerValue(process.env["FCU_OPERATOR_PASS"]);
  const evidence = new EvidenceWriter(options.evidenceRoot ?? "evidence", runId, redactor);
  if (pre.warning) {
    await evidence.writeWarning(runId, pre.warning);
  }

  const ttl: EscalationTtlConfig = { ...DEFAULT_ESCALATION_TTL, ...options.escalation };

  const ctx: RunContext = {
    page: session.page,
    artifact,
    runId,
    inputs: pre.values,
    outputs: {},
    recoveryAttempts: new Map(),
    globalRecoveryCount: { count: 0 },
    session,
    stepsCompleted: [],
    startedAt: Date.now(),
  };

  await session.context.tracing.start({ screenshots: true, snapshots: true });

  const terminal = await executeSteps(ctx, evidence, policy, ttl, 0);

  if ("resumable" in terminal) {
    // See the module doc comment: this is the deliberate caller-facing
    // boundary. Tracing stays running and evidence stays open — a
    // background continuation (already started inside executeSteps) owns
    // finishing the run and finalizing evidence once a human acts.
    return terminal;
  }

  return finalizeTerminal(ctx, evidence, terminal);
}

/**
 * Finalizes a run's TRUE terminal outcome (success, business outcome,
 * failed, or escalation_timeout) by stopping tracing and writing
 * result.json. Never called for a plain "escalated" result — that leaves
 * tracing running for the continuation. May be called twice for one run_id
 * (once with "escalated" is never true, but a timeout/failure reached after
 * a resume rewrites result.json over the initial "escalated" write) —
 * result.json reflects the latest known outcome, which is what a caller
 * checking it later wants.
 */
async function finalizeTerminal(ctx: RunContext, evidence: EvidenceWriter, terminal: CapabilityResult): Promise<CapabilityResult> {
  let result = terminal;
  const wantsTraceFile = "evidence" in result || result.status === "escalation_timeout";

  if ("evidence" in result) {
    const screenshotPath = await evidence.writeScreenshot(ctx.page).catch(() => undefined);
    if (screenshotPath) {
      result = { ...result, evidence: { ...result.evidence, screenshot: screenshotPath } };
    }
  }

  if (wantsTraceFile) {
    await ctx.session.context.tracing.stop({ path: evidence.tracePath() }).catch(() => undefined);
  } else {
    await ctx.session.context.tracing.stop().catch(() => undefined);
  }

  await evidence.writeResult(result);
  return result;
}

function baseLogEntry(ctx: RunContext, step: Step, stepStart: number, outcome: string, detail: string): StepLogEntry {
  return {
    run_id: ctx.runId,
    step: step.id,
    action: step.action,
    duration_ms: Date.now() - stepStart,
    outcome,
    actor: ctx.session.controller,
    detail,
  };
}

function describeObservedFailure(result: CapabilityResult): string {
  if ("observed" in result) {
    return result.observed;
  }
  if ("resumable" in result) {
    return result.reason;
  }
  if ("errors" in result) {
    return result.errors.map((e: { path: string; message: string }) => `${e.path}: ${e.message}`).join("; ");
  }
  if ("outcome_id" in result) {
    return result.message ?? result.status;
  }
  return result.status;
}

type StepRunOutcome =
  | { type: "done"; resolved: ResolvedTarget | undefined }
  | { type: "terminal"; result: CapabilityResult }
  | { type: "escalate"; trigger: EscalationTrigger; detail: string; resumeCheckpoint: Checkpoint | undefined };

/** True when a step is blocked by policy rather than page state — checked before the step is attempted at all, never mid-action. */
function checkIrreversiblePolicy(step: Step, policy: PolicyConfig): string | undefined {
  if (step.risk !== "irreversible" || policy.confirmIrreversible) {
    return undefined;
  }
  return `step "${step.id}" is risk:"irreversible" and policy.confirmIrreversible was not set; unattended automation refuses to perform it without a human present`;
}

/**
 * Runs artifact steps from `startIndex` to completion (or a terminal
 * result). Resumable by construction — `ctx` is shared and mutated across
 * calls, so a continuation invoked after a human resumes a run picks up
 * `stepsCompleted`/`outputs`/recovery counters exactly where the interrupted
 * call left them, rather than starting a fresh run context.
 */
async function executeSteps(
  ctx: RunContext,
  evidence: EvidenceWriter,
  policy: PolicyConfig,
  ttl: EscalationTtlConfig,
  startIndex: number,
): Promise<CapabilityResult> {
  for (let index = startIndex; index < ctx.artifact.steps.length; index += 1) {
    const step = ctx.artifact.steps[index];
    if (!step) {
      continue;
    }
    const stepStart = Date.now();

    const policyBlockDetail = checkIrreversiblePolicy(step, policy);
    if (policyBlockDetail) {
      return await startEscalation(ctx, evidence, policy, ttl, step, "policy_block", policyBlockDetail, undefined);
    }

    try {
      const outcome = await runStep(ctx, step);

      if (outcome.type === "escalate") {
        return await startEscalation(ctx, evidence, policy, ttl, step, outcome.trigger, outcome.detail, outcome.resumeCheckpoint);
      }

      if (outcome.type === "terminal") {
        await evidence.writeStep(
          baseLogEntry(ctx, step, stepStart, outcome.result.status, describeObservedFailure(outcome.result)),
        );
        return outcome.result;
      }

      ctx.stepsCompleted.push(step.id);
      const entry = baseLogEntry(ctx, step, stepStart, "ok", describeStepDetail(step, ctx));
      if (outcome.resolved?.kind === "locator") {
        entry.strategy_index_used = outcome.resolved.strategyIndex;
        entry.strategy_kind = outcome.resolved.strategyKind;
      }
      await evidence.writeStep(entry);
    } catch (err) {
      // AmbiguousTarget, ControlViolation, or anything unforeseen: an
      // immediate hard stop that bypasses outcome/recoverable evaluation
      // entirely, since these are not "which page state are we in?"
      // questions — they are broken recordings or illegal session use.
      const terminal: FailedResult = {
        status: "failed",
        failed_step: step.id,
        expected: "step to execute without an unrecoverable engine error",
        observed: err instanceof Error ? err.message : String(err),
        evidence: {},
        run_id: ctx.runId,
      };
      await evidence.writeStep(baseLogEntry(ctx, step, stepStart, "failed", terminal.observed));
      return terminal;
    }
  }

  return {
    status: "success",
    outputs: finalizeOutputs(ctx.artifact, ctx.outputs),
    run_id: ctx.runId,
    steps_executed: ctx.stepsCompleted.length,
    duration_ms: Date.now() - ctx.startedAt,
  };
}

/**
 * Writes the intervention record, arms the session's PENDING_INTERVENTION
 * wait, and kicks off (without awaiting) the out-of-band continuation.
 * Returns the "escalated" result immediately — see the module doc comment.
 */
async function startEscalation(
  ctx: RunContext,
  evidence: EvidenceWriter,
  policy: PolicyConfig,
  ttl: EscalationTtlConfig,
  step: Step,
  trigger: EscalationTrigger,
  detail: string,
  declaredCheckpoint: Checkpoint | undefined,
): Promise<CapabilityResult> {
  const screenshotPath = (await evidence.writeScreenshot(ctx.page).catch(() => undefined)) ?? "";
  const resumeContract = deriveResumeContract(ctx.artifact, step, trigger, declaredCheckpoint);
  const record = buildInterventionRecord({
    session: ctx.session,
    runId: ctx.runId,
    artifact: ctx.artifact,
    trigger,
    detail,
    currentStep: step.id,
    stepsCompleted: [...ctx.stepsCompleted],
    currentUrl: ctx.page.url(),
    screenshotPath,
    resumeContract,
  });
  await evidence.writeIntervention(record);
  await evidence.writeStep({
    run_id: ctx.runId,
    step: step.id,
    action: step.action,
    duration_ms: 0,
    outcome: "escalated",
    actor: ctx.session.controller,
    detail: `escalated (${trigger}): ${detail}`,
  });

  ctx.session.beginEscalation();
  const handle: EscalationHandle = { session: ctx.session, evidence, artifact: ctx.artifact, record };
  escalationRegistry.register(handle);

  void continueAfterEscalation(ctx, evidence, policy, handle, ttl).catch((err: unknown) => {
    // A defensive backstop only: every branch inside continueAfterEscalation
    // already resolves to a terminal write or an intentional early return.
    // Reaching here means something broke outside that control flow (e.g.
    // disk I/O), and there is no caller left waiting to report it to.
    console.error(`escalation continuation for run "${ctx.runId}" failed unexpectedly:`, err);
  });

  return {
    status: "escalated",
    intervention_id: record.intervention_id,
    reason: detail,
    resumable: true,
    run_id: ctx.runId,
  };
}

/**
 * The out-of-band continuation: blocks on the session's condition
 * variables (no polling) through PENDING_INTERVENTION and HUMAN_CONTROL,
 * then re-verifies and resumes stepping through the artifact. Every branch
 * either returns having already written the run's final outcome, or
 * returns having intentionally left it alone (abandoned mid-wait — the
 * intervention record's status is the audit trail for that, not a
 * synthesized result).
 */
async function continueAfterEscalation(
  ctx: RunContext,
  evidence: EvidenceWriter,
  policy: PolicyConfig,
  handle: EscalationHandle,
  ttl: EscalationTtlConfig,
): Promise<void> {
  const session = ctx.session;
  const interventionId = handle.record.intervention_id;

  await session.awaitClaim(ttl.pendingInterventionTtlMs);
  // Read the CURRENT state fresh into a local: `session.state` is a getter
  // over mutable private state, so each read after an await can legitimately
  // differ from the last (TypeScript narrows getter reads like readonly
  // properties, which is unsound here across an await — the local snapshot
  // sidesteps that instead of fighting it with casts at every check).
  const afterClaim: typeof session.state = session.state;

  if (afterClaim === "terminated") {
    // Abandoned before anyone claimed it. abandonIntervention() already
    // wrote the record and closed the session.
    escalationRegistry.remove(interventionId);
    return;
  }

  if (afterClaim === "pending_intervention") {
    // awaitClaim resolved "timed_out": nobody claimed it in time.
    handle.record = { ...handle.record, status: "timed_out" };
    await evidence.writeIntervention(handle.record);
    escalationRegistry.remove(interventionId);
    const terminal: EscalationTimeoutResult = { status: "escalation_timeout", intervention_id: interventionId, run_id: ctx.runId };
    await finalizeTerminal(ctx, evidence, terminal);
    session.terminate();
    await session.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    return;
  }

  // afterClaim === "human_control": claimed within the TTL.
  await session.awaitResume(ttl.humanControlTtlMs);
  const afterResume: typeof session.state = session.state;

  if (afterResume === "terminated") {
    // Abandoned while a human held control.
    escalationRegistry.remove(interventionId);
    return;
  }

  if (afterResume === "human_control") {
    // awaitResume resolved "timed_out": claimed, but never handed back.
    const terminal: FailedResult = {
      status: "failed",
      failed_step: handle.record.context.current_step,
      expected: "a human to resume the run within the human-control timeout",
      observed: `session "${session.id}" was claimed but never resumed before the timeout`,
      evidence: {},
      run_id: ctx.runId,
    };
    await finalizeTerminal(ctx, evidence, terminal);
    session.reclaim();
    session.terminate();
    await session.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    return;
  }

  // session.state === "resuming": a human called resume(). Re-verify —
  // never assume the human did exactly what the contract expected.
  escalationRegistry.remove(interventionId);
  const verification = await verifyResume(ctx.page, ctx.artifact, handle.record);

  if (verification.type === "hard_fail") {
    const terminal: FailedResult = {
      status: "failed",
      failed_step: handle.record.context.current_step,
      expected: verification.expected,
      observed: verification.observed,
      evidence: {},
      run_id: ctx.runId,
    };
    await finalizeTerminal(ctx, evidence, terminal);
    return;
  }

  session.finishResume();
  const resumeIndex = ctx.artifact.steps.findIndex((candidate) => candidate.id === verification.fromStepId);
  const terminal = await executeSteps(ctx, evidence, policy, ttl, resumeIndex >= 0 ? resumeIndex : 0);

  if ("resumable" in terminal) {
    // The resumed run hit another escalation; that call already registered
    // its own continuation and evidence. Tracing must keep running for it,
    // so there is nothing further to finalize here.
    return;
  }

  await finalizeTerminal(ctx, evidence, terminal);
}

/** Runs one artifact step to completion, including any recoverable-driven retries. */
async function runStep(ctx: RunContext, step: Step): Promise<StepRunOutcome> {
  let skipAction = false;
  let resolved: ResolvedTarget | undefined;

  for (;;) {
    try {
      ctx.session.assertControlled();

      if (!skipAction) {
        resolved = await safelyResolveTarget(ctx.page, step);
        await executeStepAction(ctx, step, resolved);
      } else {
        await waitFor(ctx.page, step.wait, resolved, step.checkpoint);
      }

      if (step.checkpoint && !(await checkpointMatches(ctx.page, step.checkpoint))) {
        throw new StepUnmet("checkpoint_mismatch", await describeObserved(ctx.page));
      }

      return { type: "done", resolved };
    } catch (err) {
      if (!(err instanceof StepUnmet)) {
        throw err; // AmbiguousTarget, ControlViolation, or unforeseen — propagate.
      }

      if (step.on_fail === "hard_fail") {
        return { type: "terminal", result: hardFailResult(ctx, step, err) };
      }

      const decision = await evaluateFailure(ctx, step, err);
      if (decision.type === "escalate") {
        return { type: "escalate", trigger: decision.trigger, detail: decision.detail, resumeCheckpoint: decision.resumeCheckpoint };
      }
      if (decision.type !== "retry") {
        return { type: "terminal", result: decision.result };
      }
      skipAction = decision.skipAction;
    }
  }
}

async function safelyResolveTarget(page: Page, step: Step): Promise<ResolvedTarget | undefined> {
  if (!step.target) {
    return undefined;
  }
  const scope = resolveFrameScope(page, step.target.frame);
  try {
    return await resolveTarget(scope, step.target, step.id);
  } catch (err) {
    if (err instanceof NoTargetFound) {
      throw new StepUnmet("no_target", await describeObserved(page));
    }
    throw err; // AmbiguousTarget propagates as an immediate hard stop.
  }
}

async function executeStepAction(ctx: RunContext, step: Step, resolved: ResolvedTarget | undefined): Promise<void> {
  const { page, artifact } = ctx;
  try {
    switch (step.action) {
      case "navigate": {
        const target = new URL(substitute(step.value ?? "/", ctx.inputs), artifact.recorded_against.base_url).toString();
        await page.goto(target, { waitUntil: "load", ...(step.wait ? { timeout: step.wait.timeout_ms } : {}) });
        return;
      }
      case "click": {
        const target = requireResolved(resolved, step.id);
        if (step.wait?.for === "navigation") {
          await Promise.all([page.waitForLoadState("load", { timeout: step.wait.timeout_ms }), performClick(page, target)]);
        } else {
          await performClick(page, target);
          if (step.wait) {
            await waitFor(page, step.wait, target, step.checkpoint);
          }
        }
        return;
      }
      case "fill": {
        const target = requireResolved(resolved, step.id);
        await performFill(target, substitute(step.value ?? "", ctx.inputs));
        if (step.wait) {
          await waitFor(page, step.wait, target, step.checkpoint);
        }
        return;
      }
      case "select": {
        const target = requireResolved(resolved, step.id);
        await performSelect(target, substitute(step.value ?? "", ctx.inputs));
        if (step.wait) {
          await waitFor(page, step.wait, target, step.checkpoint);
        }
        return;
      }
      case "assert": {
        if (step.wait) {
          await waitFor(page, step.wait, resolved, step.checkpoint);
        }
        return;
      }
      case "extract": {
        const target = requireResolved(resolved, step.id);
        if (step.wait) {
          await waitFor(page, step.wait, target, step.checkpoint);
        }
        const raw = await readText(page, target);
        const value = applyTransform(raw, step.transform);
        if (step.into) {
          ctx.outputs[step.into] = value;
        }
        return;
      }
    }
  } catch (err) {
    if (err instanceof StepUnmet) {
      throw err;
    }
    throw new StepUnmet("timeout", await describeObserved(page));
  }
}

function requireResolved(resolved: ResolvedTarget | undefined, stepId: string): ResolvedTarget {
  if (!resolved) {
    throw new Error(`step "${stepId}" requires a resolved target but none was available`);
  }
  return resolved;
}

/**
 * Applies a step's declared wait condition. When a target is already
 * resolved, this waits on that locator directly (Playwright's own
 * actionability/attachment wait — a real condition check, not a sleep).
 * When there is no resolved target (an assert step, or a wait_and_retry
 * re-poll that intentionally skipped re-resolving), navigation waits fall
 * back to page load state, and everything else polls the step's own
 * checkpoint on a short interval up to the declared timeout.
 */
async function waitFor(
  page: Page,
  wait: Wait | undefined,
  resolved: ResolvedTarget | undefined,
  checkpoint: Step["checkpoint"],
): Promise<void> {
  if (!wait) {
    return;
  }
  try {
    if (resolved?.kind === "locator") {
      if (wait.for === "navigation") {
        await page.waitForLoadState("load", { timeout: wait.timeout_ms });
      } else {
        const state = wait.for === "element_present" ? "attached" : "visible";
        await resolved.locator.waitFor({ state, timeout: wait.timeout_ms });
      }
      return;
    }
    if (wait.for === "navigation") {
      await page.waitForLoadState("load", { timeout: wait.timeout_ms });
      return;
    }
    if (checkpoint) {
      await pollUntil(() => checkpointMatches(page, checkpoint), wait.timeout_ms);
    }
  } catch {
    throw new StepUnmet("timeout", await describeObserved(page));
  }
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before the declared timeout");
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FailureDecision =
  | { type: "retry"; skipAction: boolean }
  | { type: "terminal"; result: CapabilityResult }
  | { type: "escalate"; trigger: "declared_escalation"; detail: string; resumeCheckpoint: Checkpoint | undefined };

/**
 * Phase 3. Order matters: outcomes before recoverables, because a
 * legitimate "not found"-style page might also just be slow to fully
 * render, and reading that as a timeout would return the wrong answer.
 */
async function evaluateFailure(ctx: RunContext, step: Step, failure: StepUnmet): Promise<FailureDecision> {
  const { page, artifact } = ctx;

  for (const outcome of artifact.outcomes) {
    if (await checkpointMatches(page, outcome.detect)) {
      const result: CapabilityResult = {
        status: outcome.returns.status,
        outcome_id: outcome.id,
        run_id: ctx.runId,
        ...(outcome.returns.message !== undefined ? { message: outcome.returns.message } : {}),
      };
      return { type: "terminal", result };
    }
  }

  for (const recoverable of artifact.recoverables) {
    if (!(await checkpointMatches(page, recoverable.detect))) {
      continue;
    }

    const attemptsSoFar = ctx.recoveryAttempts.get(recoverable.id) ?? 0;
    if (attemptsSoFar >= recoverable.max_attempts) {
      return {
        type: "terminal",
        result: hardFailResult(
          ctx,
          step,
          new StepUnmet(failure.reason, `recoverable "${recoverable.id}" exceeded max_attempts (${recoverable.max_attempts})`),
        ),
      };
    }
    if (ctx.globalRecoveryCount.count >= GLOBAL_RECOVERY_CAP) {
      return {
        type: "terminal",
        result: hardFailResult(ctx, step, new StepUnmet(failure.reason, `global recovery cap (${GLOBAL_RECOVERY_CAP}) exceeded`)),
      };
    }
    if (recoverable.recover.action === "escalate") {
      return {
        type: "escalate",
        trigger: "declared_escalation",
        detail: recoverable.recover.reason,
        resumeCheckpoint: recoverable.recover.resume_checkpoint,
      };
    }

    ctx.recoveryAttempts.set(recoverable.id, attemptsSoFar + 1);
    ctx.globalRecoveryCount.count += 1;

    if (recoverable.recover.action === "click") {
      await performRecoveryClick(page, recoverable.recover, recoverable.id);
      return { type: "retry", skipAction: false };
    }

    // wait_and_retry: this is the one deliberate, data-driven delay in the
    // engine. Retrying the step's own action here would not help — an
    // action whose downstream latency is fixed does not get faster for
    // being repeated — so this retries only the wait/checkpoint check,
    // never the action.
    const backoffIndex = Math.min(attemptsSoFar, recoverable.recover.backoff_ms.length - 1);
    await sleep(recoverable.recover.backoff_ms[backoffIndex] ?? 0);
    return { type: "retry", skipAction: true };
  }

  return { type: "terminal", result: hardFailResult(ctx, step, failure) };
}

function hardFailResult(ctx: RunContext, step: Step, failure: StepUnmet): CapabilityResult {
  return {
    status: "failed",
    failed_step: step.id,
    expected: describeExpectation(step),
    observed: failure.observedText,
    evidence: {},
    run_id: ctx.runId,
  };
}

function describeExpectation(step: Step): string {
  if (step.checkpoint) {
    return `checkpoint to hold: ${JSON.stringify(step.checkpoint)}`;
  }
  if (step.wait) {
    return `wait condition to be met: ${step.wait.for} within ${step.wait.timeout_ms}ms`;
  }
  return `step "${step.id}" (${step.action}) to complete`;
}

async function performRecoveryClick(
  page: Page,
  recover: Extract<RecoveryAction, { action: "click" }>,
  recoverableId: string,
): Promise<void> {
  const role = (recover.role ?? "button") as AriaRole;
  const locator = recover.name ? page.getByRole(role, { name: recover.name }) : page.getByRole(role);
  const count = await locator.count();
  if (count === 0) {
    throw new NoTargetFound(`recover:${recoverableId}`);
  }
  if (count > 1) {
    throw new AmbiguousTarget(`recover:${recoverableId}`, 0, count);
  }
  await locator.click();
}

async function performClick(page: Page, target: ResolvedTarget): Promise<void> {
  if (target.kind === "locator") {
    await target.locator.click();
    return;
  }
  await page.mouse.click(target.x, target.y);
}

async function performFill(target: ResolvedTarget, value: string): Promise<void> {
  if (target.kind === "locator") {
    await target.locator.fill(value);
    return;
  }
  throw new Error("fill is not supported against a coordinates-resolved target");
}

async function performSelect(target: ResolvedTarget, value: string): Promise<void> {
  if (target.kind === "locator") {
    await target.locator.selectOption(value);
    return;
  }
  throw new Error("select is not supported against a coordinates-resolved target");
}

async function readText(page: Page, target: ResolvedTarget): Promise<string> {
  if (target.kind === "locator") {
    return await target.locator.innerText();
  }
  return await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.textContent ?? "",
    { x: target.x, y: target.y },
  );
}

function substitute(template: string, inputs: InvocationInputs): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in inputs)) {
      throw new Error(`step references undeclared input "${name}"`);
    }
    return String(inputs[name]);
  });
}

function applyTransform(raw: string, transform: Transform | undefined): string | number {
  const trimmed = raw.trim();
  switch (transform) {
    case "parse_currency":
      return Number.parseFloat(trimmed.replace(/[^0-9.-]/g, ""));
    case "parse_int":
      return Number.parseInt(trimmed, 10);
    case "trim":
      return trimmed;
    default:
      return trimmed;
  }
}

function finalizeOutputs(
  artifact: CapabilityArtifact,
  collected: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const output of artifact.outputs) {
    if (output.const !== undefined) {
      result[output.name] = output.const;
      continue;
    }
    const value = collected[output.name];
    if (value === undefined) {
      throw new Error(`output "${output.name}" was declared but never populated by an extract step`);
    }
    result[output.name] = value;
  }
  return result;
}

function describeStepDetail(step: Step, ctx: RunContext): string {
  switch (step.action) {
    case "navigate":
      return "navigated";
    case "fill":
      return `filled target with "${substitute(step.value ?? "", ctx.inputs)}"`;
    case "select":
      return `selected "${substitute(step.value ?? "", ctx.inputs)}" on target`;
    case "click":
      return "clicked target";
    case "assert":
      return "checkpoint verified";
    case "extract":
      return step.into ? `extracted into output "${step.into}": ${String(ctx.outputs[step.into])}` : "extracted";
  }
}
