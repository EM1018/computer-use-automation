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
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
