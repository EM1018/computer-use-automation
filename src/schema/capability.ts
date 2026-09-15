import { z } from "zod";

/**
 * The capability artifact schema: the recorded, replayable description of a
 * single UI flow ("capability") that an agent can invoke by name.
 *
 * Version semantics (enforced by `classifyChange` in ../version.ts, not by
 * this schema):
 *   - MAJOR bump: inputs or outputs changed. This is breaking for callers,
 *     since it changes the capability's contract.
 *   - MINOR bump: steps, locators, outcomes, or recoverables changed, but
 *     the input/output contract is unchanged. Safe for callers pinned to a
 *     major version.
 * Callers pin to a major version; resolution (see ../loader.ts) returns the
 * highest APPROVED minor within that major.
 */

// ---------------------------------------------------------------------------
// 1. Identity and provenance
// ---------------------------------------------------------------------------

export const VersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});
export type Version = z.infer<typeof VersionSchema>;

export const CapabilityStatusSchema = z.enum(["draft", "approved", "deprecated"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityIdentitySchema = z.object({
  id: z.string().min(1),
  version: VersionSchema,
  title: z.string().min(1),
  // Read by a calling agent to decide whether this capability applies to
  // its task.
  description: z.string().min(1),
  status: CapabilityStatusSchema,
});
export type CapabilityIdentity = z.infer<typeof CapabilityIdentitySchema>;

export const RecordedAgainstSchema = z.object({
  app: z.string().min(1),
  app_version: z.string().min(1),
  tenant: z.string().min(1),
  base_url: z.string().url(),
});
export type RecordedAgainst = z.infer<typeof RecordedAgainstSchema>;

export const ProvenanceSchema = z.object({
  discovered_at: z.string().datetime(),
  model: z.string().min(1),
  run_id: z.string().min(1),
  transcript_ref: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ApprovalSchema = z.object({
  approver: z.string().min(1),
  approved_at: z.string().datetime(),
  verification_run: z.string().min(1),
  // SHA-256 of the canonicalized artifact, excluding this approval block
  // itself. Approved versions are immutable: the loader recomputes and
  // compares this on every load of an artifact with status "approved", and
  // refuses to load it on a mismatch.
  content_hash: z.string().min(1),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// 2. Contract
// ---------------------------------------------------------------------------

// Drives redaction elsewhere in the system. This is a declaration only —
// nothing in this schema implements redaction.
export const SensitivitySchema = z.enum(["pii", "secret"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const ValueTypeSchema = z.enum(["string", "number", "boolean"]);
export type ValueType = z.infer<typeof ValueTypeSchema>;

export const InputSchema = z.object({
  name: z.string().min(1),
  type: ValueTypeSchema,
  required: z.boolean(),
  pattern: z.string().optional(),
  description: z.string().min(1),
  sensitivity: SensitivitySchema.optional(),
});
export type Input = z.infer<typeof InputSchema>;

const ConstValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const OutputSchema = z.object({
  name: z.string().min(1),
  type: ValueTypeSchema,
  description: z.string().min(1),
  const: ConstValueSchema.optional(),
  sensitivity: SensitivitySchema.optional(),
});
export type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// 3. Steps
// ---------------------------------------------------------------------------

export const ActionSchema = z.enum(["navigate", "click", "fill", "select", "assert", "extract"]);
export type Action = z.infer<typeof ActionSchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Where a text-anchored element sits relative to its anchor text.
export const SpatialRelationSchema = z.enum(["above", "below", "left_of", "right_of", "inside", "near"]);
export type SpatialRelation = z.infer<typeof SpatialRelationSchema>;

// Strategies are ORDERED: index 0 is tried first, and every stored strategy
// must have been verified at record time to resolve to exactly ONE element.
// `coordinates` is a last-resort fallback and may only ever appear as the
// final entry in a strategy list (enforced by TargetSchema below).
export const StrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role_name"),
    role: z.string().min(1),
    name: z.string().min(1),
    confidence: ConfidenceSchema,
  }),
  z.object({
    kind: z.literal("label"),
    text: z.string().min(1),
    confidence: ConfidenceSchema,
  }),
  z.object({
    kind: z.literal("attribute"),
    selector: z.string().min(1),
    confidence: ConfidenceSchema,
  }),
  z.object({
    kind: z.literal("text_anchored"),
    anchor: z.string().min(1),
    relation: SpatialRelationSchema,
    confidence: ConfidenceSchema,
  }),
  z.object({
    kind: z.literal("coordinates"),
    x: z.number(),
    y: z.number(),
    viewport: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    confidence: ConfidenceSchema,
  }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const TargetSchema = z
  .object({
    frame: z.string().min(1),
    strategies: z.array(StrategySchema).min(1),
  })
  .superRefine((target, ctx) => {
    const coordinateIndexes = target.strategies
      .map((strategy, index) => (strategy.kind === "coordinates" ? index : -1))
      .filter((index) => index >= 0);

    if (coordinateIndexes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at most one 'coordinates' strategy is allowed per target",
        path: ["strategies"],
      });
      return;
    }

    const [coordinateIndex] = coordinateIndexes;
    if (coordinateIndex !== undefined && coordinateIndex !== target.strategies.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'coordinates' strategy may only appear as the last (lowest-priority) entry",
        path: ["strategies", coordinateIndex],
      });
    }
  });
export type Target = z.infer<typeof TargetSchema>;

// `within` scopes checkpoint detection to a container so patterns don't
// match against the whole page.
export const CheckpointSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("element_present"),
    role: z.string().optional(),
    name: z.string().optional(),
    name_pattern: z.string().optional(),
    within: z.string().optional(),
  }),
  z.object({
    kind: z.literal("text_present"),
    pattern: z.string().min(1),
    within: z.string().optional(),
  }),
  z.object({
    kind: z.literal("url_matches"),
    pattern: z.string().min(1),
  }),
]);
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const WaitForSchema = z.enum(["element_actionable", "navigation", "element_present"]);
export type WaitFor = z.infer<typeof WaitForSchema>;

export const WaitSchema = z.object({
  for: WaitForSchema,
  timeout_ms: z.number().int().positive(),
});
export type Wait = z.infer<typeof WaitSchema>;

export const TransformSchema = z.enum(["parse_currency", "trim", "parse_int"]);
export type Transform = z.infer<typeof TransformSchema>;

export const RiskSchema = z.enum(["safe", "write", "irreversible"]);
export type Risk = z.infer<typeof RiskSchema>;

export const OnFailSchema = z.enum(["evaluate_outcomes", "hard_fail"]);
export type OnFail = z.infer<typeof OnFailSchema>;

export const StepSchema = z.object({
  id: z.string().min(1),
  action: ActionSchema,
  target: TargetSchema.optional(),
  // May contain {{input_name}} placeholders, substituted at replay time.
  value: z.string().optional(),
  // For extract steps: names the output this step populates.
  into: z.string().optional(),
  transform: TransformSchema.optional(),
  wait: WaitSchema.optional(),
  checkpoint: CheckpointSchema.optional(),
  risk: RiskSchema,
  on_fail: OnFailSchema.optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// 4. Outcomes and recoverables
// ---------------------------------------------------------------------------

// Outcomes are LEGITIMATE results the caller needs, not failures — e.g.
// "no such member" is a business outcome, not an automation error.
export const OutcomeSchema = z.object({
  id: z.string().min(1),
  class: z.literal("business_outcome"),
  detect: CheckpointSchema,
  returns: z.object({
    status: z.string().min(1),
    message: z.string().optional(),
  }),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

// Recoverables are declared here — not hardcoded into the replay engine —
// so the engine stays generic and contains zero app-specific knowledge.
export const RecoveryActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    role: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    action: z.literal("wait_and_retry"),
    backoff_ms: z.array(z.number().int().nonnegative()).min(1),
  }),
  z.object({
    action: z.literal("escalate"),
    reason: z.string().min(1),
  }),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const RecoverableSchema = z.object({
  id: z.string().min(1),
  detect: CheckpointSchema,
  recover: RecoveryActionSchema,
  max_attempts: z.number().int().positive(),
});
export type Recoverable = z.infer<typeof RecoverableSchema>;

// ---------------------------------------------------------------------------
// 5. Verification
// ---------------------------------------------------------------------------

export const VerificationStatusSchema = z.enum(["passed", "failed"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  run: z.string().min(1),
  failed_step: z.string().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

// ---------------------------------------------------------------------------
// Top-level artifact
// ---------------------------------------------------------------------------

export const CapabilityArtifactSchema = z.object({
  schema_version: z.number().int().positive(),
  capability: CapabilityIdentitySchema,
  recorded_against: RecordedAgainstSchema,
  provenance: ProvenanceSchema,
  approval: ApprovalSchema.optional(),
  inputs: z.array(InputSchema),
  outputs: z.array(OutputSchema),
  steps: z.array(StepSchema).min(1),
  outcomes: z.array(OutcomeSchema),
  recoverables: z.array(RecoverableSchema),
  verification: VerificationSchema.optional(),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
