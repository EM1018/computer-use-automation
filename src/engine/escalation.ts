/**
 * The human-in-the-loop escalation protocol, built around the primitives
 * already on Session (controller, and now the RUNNING/PENDING_INTERVENTION/
 * HUMAN_CONTROL/RESUMING lifecycle). This module contains:
 *   - the intervention record shape and how to derive a resume contract
 *     for it (declared-checkpoint-first, generic fallback second)
 *   - an in-memory registry linking live intervention ids to the session
 *     and evidence writer a human operator surface needs to act on them
 *   - re-verification on resume: never blindly continue at "next step",
 *     always check the page is actually in the state the contract expects
 *   - coarse-grained capture of what a human did while driving
 *
 * Nothing here is specific to any target app — same generic-interpreter
 * discipline as the rest of the engine. It knows about steps, checkpoints,
 * and targets as shapes, never what any artifact's fields mean.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { CapabilityArtifact, Checkpoint, Step, Target } from "../schema/capability.js";
import type {
  EscalationTrigger,
  InterventionContext,
  InterventionRecord,
  ResumeContract,
} from "../schema/intervention.js";
import { checkpointMatches, describeObserved } from "./detect.js";
import type { EvidenceWriter } from "./evidence.js";
import type { Session } from "./session.js";
import type { FailedResult } from "../schema/result.js";

// ---------------------------------------------------------------------------
// Resume contract derivation
// ---------------------------------------------------------------------------

/**
 * Best-effort translation of a target's highest-confidence, checkpoint-
 * expressible strategy into a Checkpoint. This is a fallback, not a
 * substitute for an artifact author declaring `resume_checkpoint` on an
 * escalate recoverable: `text_anchored` and `coordinates` strategies have no
 * equivalent in the Checkpoint schema, and even for the strategies handled
 * below this is a guess about what "ready to retry" looks like, not a
 * verified one.
 */
function checkpointFromTarget(target: Target | undefined): Checkpoint | undefined {
  if (!target) {
    return undefined;
  }
  for (const strategy of target.strategies) {
    if (strategy.kind === "role_name") {
      return { kind: "element_present", role: strategy.role, name: strategy.name };
    }
    if (strategy.kind === "attribute") {
      return { kind: "element_present", within: strategy.selector };
    }
  }
  return undefined;
}

function nextStepAfter(artifact: CapabilityArtifact, step: Step): Step | undefined {
  const index = artifact.steps.findIndex((candidate) => candidate.id === step.id);
  return index >= 0 ? artifact.steps[index + 1] : undefined;
}

function describeCheckpoint(checkpoint: Checkpoint): string {
  switch (checkpoint.kind) {
    case "url_matches":
      return `URL matches ${checkpoint.pattern}`;
    case "text_present":
      return `text matching ${checkpoint.pattern} is present${checkpoint.within ? ` within ${checkpoint.within}` : ""}`;
    case "element_present":
      return `an element is present${checkpoint.role ? ` (role ${checkpoint.role})` : ""}${checkpoint.name ? ` named "${checkpoint.name}"` : ""}${checkpoint.within ? ` within ${checkpoint.within}` : ""}`;
  }
}

/**
 * Builds the resume contract for one escalation. `declared_escalation` and
 * `policy_block` disagree about what "next step" means because they leave
 * the run in different places:
 *   - declared_escalation: the stuck step's own action never completed, so
 *     resuming means retrying THAT step.
 *   - policy_block: the engine refused to perform an irreversible action at
 *     all; a human either performs it live or the run doesn't proceed, so
 *     resuming means moving on to whatever comes after it.
 */
export function deriveResumeContract(
  artifact: CapabilityArtifact,
  step: Step,
  trigger: EscalationTrigger,
  declaredCheckpoint: Checkpoint | undefined,
): ResumeContract {
  if (trigger === "policy_block") {
    const after = nextStepAfter(artifact, step);
    const checkpoint = step.checkpoint ?? after?.checkpoint ?? checkpointFromTarget(step.target) ?? checkpointFromTarget(after?.target) ?? {
      kind: "url_matches" as const,
      pattern: escapeRegExp(artifact.recorded_against.base_url),
    };
    return {
      expected_state: `step "${step.id}" (${step.action}, risk: irreversible) has been performed by a human and ${describeCheckpoint(checkpoint)}`,
      checkpoint,
      next_step: after?.id ?? step.id,
    };
  }

  // declared_escalation
  const checkpoint = declaredCheckpoint ?? step.checkpoint ?? checkpointFromTarget(step.target) ?? {
    kind: "url_matches" as const,
    pattern: escapeRegExp(artifact.recorded_against.base_url),
  };
  return {
    expected_state: `ready to retry step "${step.id}": ${describeCheckpoint(checkpoint)}`,
    checkpoint,
    next_step: step.id,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Resume verification — re-verify, never assume
// ---------------------------------------------------------------------------

export type ResumeVerification =
  | { type: "continue"; fromStepId: string }
  | { type: "hard_fail"; expected: string; observed: string };

/**
 * Implements the resume algorithm: the human may have done more, less, or
 * something different than the resume contract expects, so the engine never
 * simply continues at "next step". In order:
 *   1. the contract's own checkpoint holds -> continue from its next_step
 *   2. the PREVIOUS step's checkpoint still holds -> retry the stuck step
 *      (only available when that step declared one)
 *   3. neither -> hard failure with expected vs. observed, never a blind
 *      continue — that is how automation clicks the wrong thing next.
 */
export async function verifyResume(
  page: Page,
  artifact: CapabilityArtifact,
  record: InterventionRecord,
): Promise<ResumeVerification> {
  const contract = record.resume_contract;
  if (await checkpointMatches(page, contract.checkpoint)) {
    return { type: "continue", fromStepId: contract.next_step };
  }

  const stuckIndex = artifact.steps.findIndex((candidate) => candidate.id === record.context.current_step);
  const previousStep = stuckIndex > 0 ? artifact.steps[stuckIndex - 1] : undefined;
  if (previousStep?.checkpoint && (await checkpointMatches(page, previousStep.checkpoint))) {
    return { type: "continue", fromStepId: record.context.current_step };
  }

  return { type: "hard_fail", expected: contract.expected_state, observed: await describeObserved(page) };
}

// ---------------------------------------------------------------------------
// Intervention record construction
// ---------------------------------------------------------------------------

export function buildInterventionRecord(params: {
  session: Session;
  runId: string;
  /** e.g. "<capability_id>@<major>.<minor>" for a replay run, or "discovery" before any artifact exists. */
  capability: string;
  /** The artifact's description for replay; the operator-stated goal for discovery. */
  goal: string;
  trigger: EscalationTrigger;
  detail: string;
  currentStep: string;
  stepsCompleted: string[];
  currentUrl: string;
  screenshotPath: string;
  resumeContract: ResumeContract;
  now?: () => Date;
}): InterventionRecord {
  const now = params.now ?? (() => new Date());
  const context: InterventionContext = {
    capability: params.capability,
    goal: params.goal,
    current_step: params.currentStep,
    steps_completed: params.stepsCompleted,
    current_url: params.currentUrl,
    screenshot_path: params.screenshotPath,
  };
  return {
    intervention_id: randomUUID(),
    session_id: params.session.id,
    run_id: params.runId,
    created_at: now().toISOString(),
    reason: { trigger: params.trigger, detail: params.detail },
    context,
    resume_contract: params.resumeContract,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Registry — links a live intervention id to what the operator surface
// needs to act on it. Deliberately in-memory only: an intervention that
// outlives this process has no live session or browser behind it anyway,
// so there is nothing a claim/resume/abandon call could do with it. The
// YAML file under evidence/ is the durable, human-readable record; this is
// just the live coordination handle.
// ---------------------------------------------------------------------------

export interface EscalationHandle {
  session: Session;
  evidence: EvidenceWriter;
  record: InterventionRecord;
}

export class EscalationRegistry {
  private readonly handles = new Map<string, EscalationHandle>();

  register(handle: EscalationHandle): void {
    this.handles.set(handle.record.intervention_id, handle);
  }

  get(interventionId: string): EscalationHandle | undefined {
    return this.handles.get(interventionId);
  }

  remove(interventionId: string): void {
    this.handles.delete(interventionId);
  }

  /** Pending list for the operator surface — only interventions still awaiting a claim. */
  listPending(): EscalationHandle[] {
    return [...this.handles.values()].filter((handle) => handle.record.status === "pending");
  }

  list(): EscalationHandle[] {
    return [...this.handles.values()];
  }
}

/** One registry per process — the operator HTTP server and the replay engine both need to reach the same live handles. */
export const escalationRegistry = new EscalationRegistry();

/** Shared teardown for every path that ends a session for good (abandon, either TTL expiry) — one definition of "closed", not three copies of the same three calls. */
export async function terminateAndCloseSession(session: Session): Promise<void> {
  session.terminate();
  await session.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Operator actions — the only code paths allowed to mutate a handle's
// record status, so "what does status X actually do" has one definition.
// ---------------------------------------------------------------------------

export async function claimIntervention(handle: EscalationHandle): Promise<void> {
  handle.session.claim();
  handle.record = { ...handle.record, status: "claimed" };
  await handle.evidence.writeIntervention(handle.record);
  await attachHumanActionListeners(handle.session, handle.evidence, handle.record.run_id);
}

/**
 * Signals the engine to resume; it does not wait for the run to finish
 * re-verifying and continuing — that happens out-of-band in the
 * continuation already blocked on `session.awaitResume`. `status: "resumed"`
 * describes the intervention's own lifecycle (a human said "go"), not the
 * eventual run outcome, which lands in evidence/result.json separately.
 */
export async function resumeIntervention(handle: EscalationHandle): Promise<void> {
  handle.session.resume();
  handle.record = { ...handle.record, status: "resumed" };
  await handle.evidence.writeIntervention(handle.record);
}

/**
 * Terminates the run outright. This has to write a real terminal result —
 * not just update the intervention record's own status — because a
 * fire-and-forget caller's only externally-visible signal is
 * evidence/result.json, and it was still sitting at the initial "escalated"
 * write. Leaving it there would mean anything waiting on this run (a caller
 * polling result.json, the demo script) blocks forever with no way to learn
 * the run is actually over.
 *
 * Deliberately generic and shared across replay AND discovery — the
 * operator surface calls this against whatever's in the registry without
 * knowing which produced it, so this writes a best-effort "abandoned"
 * breadcrumb in replay's CapabilityResult shape either way. A discovery run
 * additionally builds its own richer DiscoveryResult directly (it awaits
 * this in-process rather than firing-and-forgetting), so for discovery this
 * write is a generic marker for external tooling, not the authoritative
 * outcome the way it is for replay.
 */
export async function abandonIntervention(handle: EscalationHandle): Promise<void> {
  handle.record = { ...handle.record, status: "abandoned" };
  await handle.evidence.writeIntervention(handle.record);

  const terminal: FailedResult = {
    status: "failed",
    failed_step: handle.record.context.current_step,
    expected: "the run to be resumed by a human, or to complete via some other outcome",
    observed: "the intervention was abandoned by an operator",
    evidence: handle.record.context.screenshot_path ? { screenshot: handle.record.context.screenshot_path } : {},
    run_id: handle.record.run_id,
  };
  // First terminal write for this run's tracing — it was deliberately left
  // running through PENDING_INTERVENTION/HUMAN_CONTROL (see the module doc
  // comment on continueAfterEscalation in ../engine/replay.ts) rather than
  // stopped at the initial escalation, so it captures whatever the human
  // did before abandoning too.
  await handle.session.context.tracing.stop({ path: handle.evidence.tracePath() }).catch(() => undefined);
  await handle.evidence.writeResult(terminal);

  await terminateAndCloseSession(handle.session);
}

// ---------------------------------------------------------------------------
// Human action capture — while controller === "human", log coarse actions
// through the same evidence stream automation uses, at the same coarse
// level (never field values), so a reader can reconstruct where the
// machine stopped, what the person did, and where it resumed.
// ---------------------------------------------------------------------------

const HUMAN_ACTION_BRIDGE = "__legacyHumanAction";

interface HumanActionPayload {
  kind: "click" | "fill";
  descriptor: string;
}

const listenersAttached = new WeakSet<Session>();

/**
 * Attaches a framenavigated listener and an injected DOM listener (clicks,
 * field changes) to the session's page, logging through the evidence writer
 * with actor "human". Idempotent per session: Playwright's exposeFunction
 * may only be registered once per page, so a second claim on the same
 * session (e.g. after a resumed run escalates again) does not re-attach.
 *
 * `addInitScript` alone only covers documents loaded AFTER it's called — it
 * does nothing for the page the human is already looking at (which is
 * exactly the page they were just handed control of), so this also
 * `evaluate`s the same listener into the current document immediately.
 */
export async function attachHumanActionListeners(session: Session, evidence: EvidenceWriter, runId: string): Promise<void> {
  if (listenersAttached.has(session)) {
    return;
  }
  listenersAttached.add(session);

  const page = session.page;

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || session.state !== "human_control") {
      return;
    }
    void evidence.writeStep({
      run_id: runId,
      step: "human_action",
      action: "navigate",
      duration_ms: 0,
      outcome: "ok",
      actor: "human",
      detail: `navigated to ${frame.url()}`,
    });
  });

  await page
    .exposeFunction(HUMAN_ACTION_BRIDGE, (payload: HumanActionPayload) => {
      if (session.state !== "human_control") {
        return;
      }
      void evidence.writeStep({
        run_id: runId,
        step: "human_action",
        action: payload.kind === "click" ? "click" : "fill",
        duration_ms: 0,
        outcome: "ok",
        actor: "human",
        detail: payload.kind === "click" ? `clicked ${payload.descriptor}` : `filled field "${payload.descriptor}"`,
      });
    })
    .catch(() => undefined); // page/context already closed by the time this ran — nothing to attach to.

  await page.addInitScript(injectedListenerSource, HUMAN_ACTION_BRIDGE).catch(() => undefined);
  await page.evaluate(injectedListenerSource, HUMAN_ACTION_BRIDGE).catch(() => undefined);
}

/**
 * Runs inside the page. Deliberately coarse and value-free: it reports that
 * a field was filled and which one identifies it (name/id/aria-label),
 * never what was typed into it, and a short label for clicked elements —
 * never their surrounding text content, which can carry account data in
 * this app's table-heavy layout.
 */
function injectedListenerSource(bridgeName: string): void {
  const describeTarget = (el: Element): string => {
    const id = el.getAttribute("id");
    const name = el.getAttribute("name");
    const ariaLabel = el.getAttribute("aria-label");
    const label = ariaLabel ?? name ?? id;
    return label ? `${el.tagName.toLowerCase()}[${label}]` : el.tagName.toLowerCase();
  };

  const send = (
    window as unknown as { [key: string]: ((payload: { kind: "click" | "fill"; descriptor: string }) => void) | undefined }
  )[bridgeName];

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      send?.({ kind: "click", descriptor: describeTarget(target) });
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
        return;
      }
      send?.({ kind: "fill", descriptor: describeTarget(target) });
    },
    true,
  );
}
