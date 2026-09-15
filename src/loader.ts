import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { ZodIssue } from "zod";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema/capability.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationError {
  message: string;
  issues: ValidationIssue[];
}

export type LoadArtifactResult = { ok: true; artifact: CapabilityArtifact } | { ok: false; error: ValidationError };

function toValidationError(message: string, issues: ZodIssue[]): ValidationError {
  return {
    message,
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** Parses a YAML artifact file at `path` and validates it against the capability schema. */
export function loadArtifact(path: string): LoadArtifactResult {
  let raw: unknown;
  try {
    const contents = readFileSync(path, "utf8");
    raw = yaml.load(contents);
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `failed to read or parse YAML at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
      },
    };
  }

  const result = CapabilityArtifactSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: toValidationError(`artifact at ${path} failed schema validation`, result.error.issues),
    };
  }

  return { ok: true, artifact: result.data };
}

const ARTIFACT_FILENAME_PATTERN = /^(.+)\.v(\d+)\.(\d+)\.yaml$/;

export type ResolveCapabilityResult =
  | { ok: true; artifact: CapabilityArtifact }
  | { ok: false; error: { message: string } };

/**
 * Resolves a capability id + pinned major version to the highest APPROVED
 * minor version found directly under `artifactsDir`. Never reads
 * `artifactsDir/drafts` — drafts are excluded by construction, since this
 * only lists the top-level directory.
 */
export function resolveCapability(
  id: string,
  major: number,
  artifactsDir = "artifacts",
): ResolveCapabilityResult {
  let filenames: string[];
  try {
    filenames = readdirSync(artifactsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    return {
      ok: false,
      error: { message: `failed to read artifacts directory ${artifactsDir}: ${error instanceof Error ? error.message : String(error)}` },
    };
  }

  let bestMinor = -1;
  let bestArtifact: CapabilityArtifact | undefined;

  for (const filename of filenames) {
    const match = ARTIFACT_FILENAME_PATTERN.exec(filename);
    if (!match) {
      continue;
    }
    const [, fileId, fileMajorStr, fileMinorStr] = match as unknown as [string, string, string, string];
    if (fileId !== id) {
      continue;
    }
    const fileMajor = Number.parseInt(fileMajorStr, 10);
    if (fileMajor !== major) {
      continue;
    }
    const fileMinor = Number.parseInt(fileMinorStr, 10);

    const loaded = loadArtifact(join(artifactsDir, filename));
    if (!loaded.ok) {
      continue;
    }
    if (loaded.artifact.capability.status !== "approved") {
      continue;
    }
    if (fileMinor > bestMinor) {
      bestMinor = fileMinor;
      bestArtifact = loaded.artifact;
    }
  }

  if (!bestArtifact) {
    return {
      ok: false,
      error: { message: `no approved artifact found for capability "${id}" major version ${major}` },
    };
  }

  return { ok: true, artifact: bestArtifact };
}
