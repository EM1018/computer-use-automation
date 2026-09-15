import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CapabilityArtifact } from "./schema/capability.js";

/**
 * SHA-256 of the canonicalized artifact, excluding the approval block
 * itself (the hash lives inside that block, so it can't cover its own
 * value — and re-approving shouldn't change what's being attested to).
 * Canonicalizing first means reformatting the YAML (key order, indentation)
 * never changes the hash; only a real content change does.
 */
export function computeContentHash(artifact: CapabilityArtifact): string {
  const { approval: _approval, ...rest } = artifact;
  return createHash("sha256").update(canonicalize(rest)).digest("hex");
}
