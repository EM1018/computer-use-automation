import { z } from "zod";
import { CheckpointSchema } from "./capability.js";

/**
 * The typed record of one human escalation, written to
 * evidence/<run_id>/interventions/<intervention_id>.yaml.
 *
 * `model_stuck` and `no_progress` are discovery-only triggers: nothing in
 * the replay path produces them yet (discovery — the agent loop that runs
 * an LLM against the live app — isn't built). They're wired into the enum
 * now, per spec, so the intervention record shape doesn't need to change
 * again when discovery lands.
 */
export const EscalationTriggerSchema = z.enum(["declared_escalation", "policy_block", "model_stuck", "no_progress"]);
export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>;

export const InterventionReasonSchema = z.object({
  trigger: EscalationTriggerSchema,
  detail: z.string().min(1),
});
export type InterventionReason = z.infer<typeof InterventionReasonSchema>;

export const InterventionContextSchema = z.object({
  capability: z.string().min(1),
  goal: z.string().min(1),
  current_step: z.string().min(1),
  steps_completed: z.array(z.string()),
  current_url: z.string().min(1),
  screenshot_path: z.string().min(1),
});
export type InterventionContext = z.infer<typeof InterventionContextSchema>;

/**
 * What "resumable" means in machine-checkable terms, not just "fix it":
 * `checkpoint` is evaluated against the live page on resume (the same
 * Checkpoint shape a step/outcome/recoverable uses, so the existing
 * `checkpointMatches` detector covers this for free), and `next_step` is
 * the step id the engine should (re)start from once it holds.
 */
export const ResumeContractSchema = z.object({
  expected_state: z.string().min(1),
  checkpoint: CheckpointSchema,
  next_step: z.string().min(1),
});
export type ResumeContract = z.infer<typeof ResumeContractSchema>;

export const InterventionStatusSchema = z.enum(["pending", "claimed", "resumed", "abandoned", "timed_out"]);
export type InterventionStatus = z.infer<typeof InterventionStatusSchema>;

export const InterventionRecordSchema = z.object({
  intervention_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  created_at: z.string().datetime(),
  reason: InterventionReasonSchema,
  context: InterventionContextSchema,
  resume_contract: ResumeContractSchema,
  status: InterventionStatusSchema,
});
export type InterventionRecord = z.infer<typeof InterventionRecordSchema>;
