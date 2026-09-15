import { canonicalize } from "./canonical.js";
import type { CapabilityArtifact } from "./schema/capability.js";

export type ChangeClass = "major" | "minor" | "none";

/**
 * Version semantics (see src/schema/capability.ts):
 *   - "major": inputs or outputs changed — breaking for callers.
 *   - "minor": steps, locators, outcomes, or recoverables changed, but the
 *     input/output contract is unchanged.
 *   - "none": nothing that affects behavior changed.
 *
 * Identity/provenance/approval/verification fields are deliberately excluded
 * from the comparison: bumping metadata alone is not a functional change.
 */
export function classifyChange(oldArtifact: CapabilityArtifact, newArtifact: CapabilityArtifact): ChangeClass {
  const contractChanged =
    !deepEqual(oldArtifact.inputs, newArtifact.inputs) || !deepEqual(oldArtifact.outputs, newArtifact.outputs);
  if (contractChanged) {
    return "major";
  }

  const behaviorChanged =
    !deepEqual(oldArtifact.steps, newArtifact.steps) ||
    !deepEqual(oldArtifact.outcomes, newArtifact.outcomes) ||
    !deepEqual(oldArtifact.recoverables, newArtifact.recoverables);
  if (behaviorChanged) {
    return "minor";
  }

  return "none";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
