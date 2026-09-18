import { z } from "zod";

/**
 * The discovery action space. Deliberately small, and deliberately ref-only
 * — never a CSS selector, XPath, or coordinate. A ref (e.g. "e3") names an
 * element that actually exists in the CURRENT turn's trimmed accessibility
 * snapshot (see src/discovery/observe.ts); the model can only ever pick one
 * of those, which removes a whole class of hallucination by construction
 * rather than by validation after the fact.
 *
 * Every action here must also be expressible by the replay engine's own
 * action set (navigate/click/fill/select/assert/extract — see
 * src/schema/capability.ts) EXCEPT done/stuck, which are discovery-loop
 * control signals with no replay equivalent: nothing about "the goal is met"
 * or "I don't know what to do" survives into a deterministic artifact.
 */
export const DiscoveryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: z.string().min(1) }),
  z.object({ action: z.literal("fill"), ref: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal("select"), ref: z.string().min(1), option: z.string() }),
  z.object({ action: z.literal("navigate"), url: z.string().min(1) }),
  // "This value is something the capability returns" — the model marks
  // outputs explicitly rather than the compiler inferring them later from
  // the transcript.
  z.object({ action: z.literal("extract"), ref: z.string().min(1), output_name: z.string().min(1) }),
  z.object({ action: z.literal("done"), reason: z.string().min(1) }),
  // Required, not optional-nice-to-have: without an explicit escape hatch a
  // model thrashes — clicking randomly until max_steps. This is what lets
  // discovery escalate cleanly instead.
  z.object({ action: z.literal("stuck"), reason: z.string().min(1) }),
]);
export type DiscoveryAction = z.infer<typeof DiscoveryActionSchema>;

export type RefTargetingAction = Extract<DiscoveryAction, { ref: string }>;

/** True for the three action kinds that name a ref and so need it validated/resolved before executing. */
export function isRefTargetingAction(action: DiscoveryAction): action is RefTargetingAction {
  return action.action === "click" || action.action === "fill" || action.action === "select" || action.action === "extract";
}

/** Serializable metadata for one ref, independent of any live Playwright handle — what refs.jsonl records and what the policy check matches against. */
export interface RefDescriptor {
  ref: string;
  role: string;
  name?: string;
  /** Playwright's own aria-ref locator string (e.g. "f2e28") this ref resolves to — an implementation detail, but worth keeping for debugging. */
  playwrightRef: string;
}

export type StoppingCondition =
  | "goal_reached"
  | "model_stuck"
  | "no_progress"
  | "max_steps_exhausted"
  | "wall_clock_timeout"
  | "escalation_abandoned"
  | "escalation_timeout"
  | "escalation_failed";

export interface DiscoveryResult {
  status: StoppingCondition;
  reason: string;
  runId: string;
  transcriptDir: string;
  turnsExecuted: number;
  outputs: Record<string, string>;
  interventionId?: string;
}

// ---------------------------------------------------------------------------
// Transcript entry shapes — one evidence/<run_id>/ file each, all written
// through EvidenceWriter (and so through the Redactor) same as replay's own
// evidence. See ../engine/evidence.ts.
// ---------------------------------------------------------------------------

export type TurnResult = "ok" | "blocked" | "invalid_ref" | "error";

/** transcript.jsonl — one line per turn, the primary evidence record. */
export interface TranscriptTurnEntry {
  turn: number;
  observation_summary: string;
  model_reasoning: string;
  action: DiscoveryAction;
  result: TurnResult;
  page_changed: boolean;
  detail?: string;
}

/** actions.jsonl — the executed actions with their ref -> element resolution. */
export interface ActionLogEntry {
  turn: number;
  action: DiscoveryAction;
  ref_resolution?: RefDescriptor;
}

/** policy_events.jsonl — every refused action with its reason. */
export interface PolicyEventEntry {
  turn: number;
  action: DiscoveryAction;
  reason: string;
}

/** refs.jsonl — per turn, the full ref -> element descriptor map (what the compiler will need later to derive locators). */
export interface RefsLogEntry {
  turn: number;
  refs: RefDescriptor[];
}
