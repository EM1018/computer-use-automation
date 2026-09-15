import { join } from "node:path";
import { loadArtifact } from "../../src/loader.js";
import type { CapabilityArtifact } from "../../src/schema/capability.js";

const ARTIFACT_PATH = join(process.cwd(), "artifacts", "drafts", "lookup_savings_balance.v1.0.yaml");

/** Loads the hand-written example artifact, pointed at the given test server instead of its recorded base_url. */
export function loadExampleArtifact(baseUrl: string): CapabilityArtifact {
  const result = loadArtifact(ARTIFACT_PATH);
  if (!result.ok) {
    throw new Error(`fixture artifact failed to load: ${result.error.message}`);
  }
  return {
    ...result.artifact,
    recorded_against: { ...result.artifact.recorded_against, base_url: baseUrl },
  };
}
