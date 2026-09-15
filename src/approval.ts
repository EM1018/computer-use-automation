import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadArtifact } from "./loader.js";
import { computeContentHash } from "./content-hash.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema/capability.js";

export interface ApprovalOptions {
  /** Directory drafts are read from. Defaults to "artifacts/drafts". */
  draftsDir?: string;
  /** Directory an approved artifact is moved into. Defaults to "artifacts". */
  artifactsDir?: string;
  /** Injectable for tests; defaults to the real current time. */
  now?: () => Date;
}

export type ApproveResult =
  | { ok: true; path: string; contentHash: string }
  | { ok: false; error: string };

/**
 * Promotes a draft to approved. Approved versions are immutable: this is
 * the only code path that may set status "approved", and it refuses unless
 * the draft has a passing verification record and no step's first strategy
 * is a "coordinates" fallback (which may not run unattended). The file
 * move from artifacts/drafts/ to artifacts/ IS the promotion — the
 * directory a version lives in is the authority on its state, not metadata
 * inside the file.
 */
export function approveCapability(
  id: string,
  major: number,
  minor: number,
  approver: string,
  options: ApprovalOptions = {},
): ApproveResult {
  const draftsDir = options.draftsDir ?? join("artifacts", "drafts");
  const artifactsDir = options.artifactsDir ?? "artifacts";
  const now = options.now ?? (() => new Date());

  const filename = `${id}.v${major}.${minor}.yaml`;
  const draftPath = join(draftsDir, filename);
  const label = `capability "${id}"@${major}.${minor}`;

  if (!existsSync(draftPath)) {
    return { ok: false, error: `${label} is not currently in ${draftsDir}` };
  }

  const loaded = loadArtifact(draftPath);
  if (!loaded.ok) {
    return { ok: false, error: `${label} failed to load: ${loaded.error.message}` };
  }
  const artifact = loaded.artifact;

  if (!artifact.verification || artifact.verification.status === "failed") {
    return { ok: false, error: `${label} has no passing verification record` };
  }

  const hasUnattendedUnsafeTarget = artifact.steps.some(
    (step) => step.target && step.target.strategies[0]?.kind === "coordinates",
  );
  if (hasUnattendedUnsafeTarget) {
    return {
      ok: false,
      error: `${label} has a step whose first strategy is "coordinates"; coordinate-first steps may not run unattended`,
    };
  }

  // Hash the artifact in its FINAL state (status already flipped) since
  // status is part of what gets hashed — hashing before the flip would
  // record a value that could never match on reload.
  const withApprovedStatus: CapabilityArtifact = { ...artifact, capability: { ...artifact.capability, status: "approved" } };
  const contentHash = computeContentHash(withApprovedStatus);
  const approvedArtifact: CapabilityArtifact = {
    ...withApprovedStatus,
    approval: {
      approver,
      approved_at: now().toISOString(),
      verification_run: artifact.verification.run,
      content_hash: contentHash,
    },
  };

  const revalidated = CapabilityArtifactSchema.safeParse(approvedArtifact);
  if (!revalidated.success) {
    return {
      ok: false,
      error: `${label}: assembled approval failed schema validation: ${revalidated.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  writeFileSync(draftPath, yaml.dump(revalidated.data), "utf8");
  const targetPath = join(artifactsDir, filename);
  renameSync(draftPath, targetPath);

  return { ok: true, path: targetPath, contentHash };
}
