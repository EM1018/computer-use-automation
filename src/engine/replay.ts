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
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { CapabilityArtifact, RecoveryAction, Step, Transform, Wait } from "../schema/capability.js";
import type { CapabilityResult } from "../schema/result.js";
import { AmbiguousTarget, NoTargetFound, StepUnmet } from "./errors.js";
import { checkpointMatches, describeObserved } from "./detect.js";
import { resolveFrameScope, resolveTarget, type AriaRole, type ResolvedTarget } from "./locate.js";
import { preflight, type InvocationInputs } from "./policy.js";
import type { PolicyConfig } from "./config.js";
import { GLOBAL_RECOVERY_CAP } from "./config.js";
import { Redactor } from "./redactor.js";
import { EvidenceWriter, type StepLogEntry } from "./evidence.js";
import type { Session } from "./session.js";

export interface ReplayOptions {
  runId?: string;
  /** Directory evidence/<run_id>/ is created under. Defaults to "evidence". */
  evidenceRoot?: string;
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

  const ctx: RunContext = {
    page: session.page,
    artifact,
    runId,
    inputs: pre.values,
    outputs: {},
    recoveryAttempts: new Map(),
    globalRecoveryCount: { count: 0 },
    session,
  };

  await session.context.tracing.start({ screenshots: true, snapshots: true });

  const startedAt = Date.now();
  let stepsExecuted = 0;
  let terminal: CapabilityResult | undefined;

  for (const step of artifact.steps) {
    const stepStart = Date.now();
    try {
      const outcome = await runStep(ctx, step);
      if (outcome.type === "terminal") {
        terminal = outcome.result;
        await evidence.writeStep(
          baseLogEntry(ctx, step, stepStart, outcome.result.status, describeObservedFailure(outcome.result)),
        );
        break;
      }

      stepsExecuted += 1;
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
      terminal = {
        status: "failed",
        failed_step: step.id,
        expected: "step to execute without an unrecoverable engine error",
        observed: err instanceof Error ? err.message : String(err),
        evidence: {},
        run_id: runId,
      };
      await evidence.writeStep(baseLogEntry(ctx, step, stepStart, "failed", terminal.observed));
      break;
    }
  }

  terminal ??= {
    status: "success",
    outputs: finalizeOutputs(artifact, ctx.outputs),
    run_id: runId,
    steps_executed: stepsExecuted,
    duration_ms: Date.now() - startedAt,
  };

  // `status` alone cannot discriminate this union (a business outcome's
  // status is an artifact-defined string, not a literal) — narrow on a
  // field unique to each reserved branch instead.
  if ("evidence" in terminal) {
    const screenshotPath = await evidence.writeScreenshot(ctx.page).catch(() => undefined);
    await session.context.tracing.stop({ path: evidence.tracePath() }).catch(() => undefined);
    if (screenshotPath) {
      terminal = { ...terminal, evidence: { ...terminal.evidence, screenshot: screenshotPath } };
    }
  } else if ("resumable" in terminal) {
    await evidence.writeScreenshot(ctx.page).catch(() => undefined);
    await session.context.tracing.stop({ path: evidence.tracePath() }).catch(() => undefined);
  } else {
    await session.context.tracing.stop().catch(() => undefined);
  }

  await evidence.writeResult(terminal);
  return terminal;
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

type StepRunOutcome = { type: "done"; resolved: ResolvedTarget | undefined } | { type: "terminal"; result: CapabilityResult };

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

type FailureDecision = { type: "retry"; skipAction: boolean } | { type: "terminal"; result: CapabilityResult };

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
        type: "terminal",
        result: {
          status: "escalated",
          intervention_id: randomUUID(),
          reason: recoverable.recover.reason,
          resumable: true,
          run_id: ctx.runId,
        },
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
