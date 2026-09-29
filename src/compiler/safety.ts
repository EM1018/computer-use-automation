/**
 * The final safety net before anything gets written to disk: no raw value
 * observed or supplied during this compile (an input's actual value, a
 * probe's alternate input, a sample text extracted for type inference)
 * should ever appear literally inside the compiled artifact. Contract
 * CONSTANTS (e.g. `currency: const "USD"`) are legitimate and untouched —
 * this only checks values the caller registers as having come from a
 * sensitive field, never the whole serialized artifact against itself.
 */
import { canonicalize } from "../canonical.js";
import type { CapabilityArtifact } from "../schema/capability.js";

export function assertNoObservedValues(artifact: CapabilityArtifact, sensitiveValues: Iterable<string>): void {
  const serialized = canonicalize(artifact);
  for (const value of sensitiveValues) {
    if (value.length === 0) {
      continue;
    }
    if (serialized.includes(value)) {
      const masked = value.length > 4 ? `${value.slice(0, 2)}***` : "***";
      throw new Error(
        `compiled artifact contains a raw value observed during discovery/probing ("${masked}") — refusing to write it. ` +
          `This means a step, an outcome detector, or a note leaked a concrete input/output value instead of a ` +
          `{{placeholder}} or a discarded sample; treat this as a compiler bug, not something to work around.`,
      );
    }
  }
}
