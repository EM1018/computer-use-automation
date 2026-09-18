/**
 * The discovery loop: a model observes the live app, decides one action at
 * a time, and acts, until the goal is met or a stopping condition fires.
 * Produces a TRANSCRIPT (evidence/<run_id>/), not an artifact — compiling a
 * transcript into a replayable capability is a separate, later task.
 */
import { randomUUID } from "node:crypto";
import type { Locator } from "playwright";
import type { EscalationTtlConfig, PolicyConfig } from "../engine/config.js";
import { DEFAULT_ESCALATION_TTL } from "../engine/config.js";
import { EvidenceWriter } from "../engine/evidence.js";
import { Redactor } from "../engine/redactor.js";
import type { Session } from "../engine/session.js";
import type { DiscoveryResult, RefDescriptor, StoppingCondition, TurnResult } from "../schema/discovery.js";
import { findRefDescriptor, targetRef, executeDiscoveryAction } from "./execute.js";
import { awaitDiscoveryEscalationResolution, escalateDiscovery } from "./escalation.js";
import { DiscoveryHistory, summarizeTurn } from "./history.js";
import type { ModelClient, ModelDecision } from "./model.js";
import { observe, pageSignature, type Observation } from "./observe.js";
import { checkDiscoveryAction } from "./policy.js";

export interface DiscoveryOptions {
  runId?: string;
  evidenceRoot?: string;
  maxSteps?: number;
  wallClockTimeoutMs?: number;
  escalation?: Partial<EscalationTtlConfig>;
  historyWindow?: number;
  /** How many times the loop will re-prompt the model within a single turn after a malformed call or an unknown ref, before giving up and treating it as stuck(). */
  maxRetriesPerTurn?: number;
  /** Fired once, only when an escalation actually happens — the CLI uses this to print the intervention id/URL without paying an operator-server cost on every non-escalating run. */
  onEscalation?: (interventionId: string) => void | Promise<void>;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES_PER_TURN = 2;

export async function runDiscovery(
  session: Session,
  goal: string,
  inputs: Record<string, string>,
  policy: PolicyConfig,
  model: ModelClient,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const runId = options.runId ?? randomUUID();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const wallClockTimeoutMs = options.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS;
  const maxRetriesPerTurn = options.maxRetriesPerTurn ?? DEFAULT_MAX_RETRIES_PER_TURN;
  const ttl: EscalationTtlConfig = { ...DEFAULT_ESCALATION_TTL, ...options.escalation };

  // Input values supplied at launch are sensitive by construction — there is
  // no artifact yet to declare which ones, so (unlike replay) every launch
  // input is treated as sensitive, not just ones tagged `sensitivity`.
  const redactor = new Redactor(
    Object.keys(inputs).map((name) => ({ name, sensitivity: "pii" as const })),
    inputs,
  );
  redactor.registerValue(process.env["FCU_OPERATOR_USER"]);
  redactor.registerValue(process.env["FCU_OPERATOR_PASS"]);
  const evidence = new EvidenceWriter(options.evidenceRoot ?? "evidence", runId, redactor);

  const history = new DiscoveryHistory(options.historyWindow);
  const outputs: Record<string, string> = {};
  const turnLabels: string[] = [];
  let noProgress = 0;
  const startedAt = Date.now();

  function finish(status: StoppingCondition, reason: string, turnsExecuted: number, interventionId?: string): DiscoveryResult {
    return {
      status,
      reason,
      runId,
      transcriptDir: evidence.runDir,
      turnsExecuted,
      outputs: { ...outputs },
      ...(interventionId !== undefined ? { interventionId } : {}),
    };
  }

  /**
   * Resolves the model's next action, re-prompting (bounded) on a malformed
   * tool call or a ref the current snapshot doesn't actually contain — the
   * model can only ever pick from refs that exist, and an attempt to name
   * one that doesn't is rejected here, never executed. Exhausting retries
   * synthesizes a stuck() so the caller has one uniform path to escalation.
   */
  async function resolveAction(
    observation: Observation,
    refMap: Map<string, Locator>,
  ): Promise<{ decision: ModelDecision; result: TurnResult; detail?: string }> {
    let retryFeedback: string | undefined;
    for (let attempt = 0; ; attempt += 1) {
      let decision: ModelDecision;
      try {
        decision = await model.nextAction({ goal, observation, historyText: history.render(), ...(retryFeedback !== undefined ? { retryFeedback } : {}) });
      } catch (err) {
        if (attempt < maxRetriesPerTurn) {
          retryFeedback = `Your previous response could not be used: ${err instanceof Error ? err.message : String(err)}. Try again with a single valid tool call.`;
          continue;
        }
        const reason = `model failed to produce a valid action after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`;
        return { decision: { action: { action: "stuck", reason }, reasoning: "" }, result: "error", detail: reason };
      }

      const ref = targetRef(decision.action);
      if (ref !== undefined && !refMap.has(ref)) {
        if (attempt < maxRetriesPerTurn) {
          retryFeedback = `The ref "${ref}" does not exist in the current snapshot. Choose one of the refs actually listed above — do not invent one.`;
          continue;
        }
        const reason = `model repeatedly targeted an unknown ref ("${ref}") after ${attempt + 1} attempts`;
        return { decision: { action: { action: "stuck", reason }, reasoning: decision.reasoning }, result: "invalid_ref", detail: ref };
      }

      return { decision, result: "ok" };
    }
  }

  /** Escalates and blocks until a human resolves it (see ../discovery/escalation.ts for why this awaits in-process rather than firing-and-forgetting like replay does). Returns "resumed" to let the loop continue, or a terminal DiscoveryResult. */
  async function handleEscalation(
    trigger: "model_stuck" | "no_progress",
    detail: string,
    turn: number,
  ): Promise<DiscoveryResult | "resumed"> {
    const handle = await escalateDiscovery({
      session,
      evidence,
      runId,
      goal,
      trigger,
      detail,
      currentTurnLabel: `turn_${turn}`,
      turnsCompleted: [...turnLabels],
      currentUrl: session.page.url(),
      screenshotPath: evidence.turnScreenshotPath(turn),
    });
    options.onEscalation?.(handle.record.intervention_id);

    const outcome = await awaitDiscoveryEscalationResolution(handle, ttl);
    switch (outcome) {
      case "resumed":
        return "resumed";
      case "abandoned":
        return finish("escalation_abandoned", "the intervention was abandoned by an operator", turn + 1, handle.record.intervention_id);
      case "pending_timeout":
        return finish("escalation_timeout", "nobody claimed the intervention before the timeout", turn + 1, handle.record.intervention_id);
      case "human_timeout":
        return finish("escalation_failed", "the intervention was claimed but never resumed before the timeout", turn + 1, handle.record.intervention_id);
    }
  }

  for (let turn = 0; turn < maxSteps; turn += 1) {
    if (Date.now() - startedAt > wallClockTimeoutMs) {
      return finish("wall_clock_timeout", `wall-clock timeout (${wallClockTimeoutMs}ms) exceeded after ${turn} turns`, turn);
    }

    session.assertControlled();
    // Captured BEFORE observe() deliberately: observe() is what creates this
    // turn's aria-refs (via Playwright's ariaSnapshot mode:"ai"), and any
    // OTHER ariaSnapshot call sitting between ref creation and ref use can
    // invalidate Playwright's internal aria-ref resolution, making the
    // eventual click/fill silently slow (retrying until its actionability
    // timeout) or wrong. So the no-progress "before" signature is taken
    // here, before refs exist, never after.
    const before = await pageSignature(session.page);
    const { observation, refMap } = await observe(session.page);
    await evidence.writeTurnScreenshot(turn, session.page);
    await evidence.writeRefs({ turn, refs: observation.refs });

    const { decision, result: resolveResult, detail: resolveDetail } = await resolveAction(observation, refMap);
    const action = decision.action;

    if (action.action === "stuck") {
      await evidence.writeTranscriptTurn({
        turn,
        observation_summary: observation.snapshotText,
        model_reasoning: decision.reasoning,
        action,
        result: resolveResult,
        page_changed: false,
        ...(resolveDetail !== undefined ? { detail: resolveDetail } : {}),
      });
      const settled = await handleEscalation("model_stuck", action.reason, turn);
      if (settled !== "resumed") {
        return settled;
      }
      noProgress = 0;
      continue;
    }

    if (action.action === "done") {
      await evidence.writeTranscriptTurn({
        turn,
        observation_summary: observation.snapshotText,
        model_reasoning: decision.reasoning,
        action,
        result: "ok",
        page_changed: false,
      });
      return finish("goal_reached", action.reason, turn + 1);
    }

    const ref = targetRef(action);
    const refDescriptor: RefDescriptor | undefined = ref !== undefined ? findRefDescriptor(observation.refs, ref) : undefined;

    const verdict = checkDiscoveryAction(action, refDescriptor, policy);
    if (!verdict.allowed) {
      // A real enforcement event, not a config file we describe: refused
      // BEFORE execution, logged, and the model told why on its next turn.
      await evidence.writePolicyEvent({ turn, action, reason: verdict.reason });
      const summary = summarizeTurn({ action, outcome: "blocked", detail: verdict.reason, pageChanged: false });
      history.push({ turn, summary });
      await evidence.writeTranscriptTurn({
        turn,
        observation_summary: observation.snapshotText,
        model_reasoning: decision.reasoning,
        action,
        result: "blocked",
        page_changed: false,
        detail: verdict.reason,
      });
      turnLabels.push(`turn_${turn}`);
      continue;
    }

    const outcome = await executeDiscoveryAction(session.page, action, refMap);
    const after = await pageSignature(session.page);
    const pageChanged = before !== after;

    if (outcome.ok && action.action === "extract") {
      outputs[action.output_name] = outcome.extractedValue ?? "";
    }

    await evidence.writeAction({ turn, action, ...(refDescriptor ? { ref_resolution: refDescriptor } : {}) });

    const turnResult: TurnResult = outcome.ok ? "ok" : "error";
    await evidence.writeTranscriptTurn({
      turn,
      observation_summary: observation.snapshotText,
      model_reasoning: decision.reasoning,
      action,
      result: turnResult,
      page_changed: pageChanged,
      ...(outcome.errorMessage !== undefined ? { detail: outcome.errorMessage } : {}),
    });
    history.push({
      turn,
      summary: summarizeTurn({ action, outcome: turnResult, pageChanged, ...(outcome.errorMessage !== undefined ? { detail: outcome.errorMessage } : {}) }),
    });
    turnLabels.push(`turn_${turn}`);

    // "Progress" for the no-progress counter is not literally "did the page
    // change" — a successful extract() is READ-ONLY BY DEFINITION and is
    // never supposed to change the page, yet it's exactly the intended
    // action for a model methodically reading several distinct values off
    // one already-loaded page (found via real use: a goal asking for
    // several related fields led to three consecutive, successful,
    // zero-page-change extracts — entirely correct behavior). Counting
    // that as "stuck" would escalate correct behavior. `page_changed` in
    // the transcript above stays the literal, honest signal; only the
    // escalation trigger treats a successful extract as progress on its
    // own terms.
    const countsAsProgress = pageChanged || (action.action === "extract" && outcome.ok);

    if (!countsAsProgress) {
      noProgress += 1;
      if (noProgress >= 3) {
        const settled = await handleEscalation("no_progress", `no visible page change after ${noProgress} consecutive non-extract actions`, turn);
        if (settled !== "resumed") {
          return settled;
        }
        noProgress = 0;
      }
    } else {
      noProgress = 0;
    }
  }

  return finish("max_steps_exhausted", `reached max_steps (${maxSteps}) without done() or stuck()`, maxSteps);
}
