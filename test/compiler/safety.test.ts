import { describe, expect, it } from "vitest";
import { assertNoObservedValues } from "../../src/compiler/safety.js";
import type { CapabilityArtifact } from "../../src/schema/capability.js";

function baseArtifact(overrides: Partial<CapabilityArtifact["steps"][number]>): CapabilityArtifact {
  return {
    schema_version: 1,
    capability: { id: "test_cap", version: { major: 1, minor: 0 }, title: "Test", description: "Test capability", status: "draft" },
    recorded_against: { app: "legacy-app", app_version: "1.0.0", tenant: "default", base_url: "http://127.0.0.1:5001" },
    provenance: { discovered_at: "2026-01-01T00:00:00Z", model: "claude-sonnet-5", run_id: "run1", transcript_ref: "evidence/run1/transcript.jsonl" },
    inputs: [{ name: "member_id", type: "string", required: true, description: "id", sensitivity: "pii" }],
    outputs: [
      { name: "balance", type: "number", description: "balance" },
      { name: "currency", type: "string", description: "currency code", const: "USD" },
    ],
    steps: [
      {
        id: "s1",
        action: "fill",
        target: { frame: "top", strategies: [{ kind: "attribute", selector: "#f_mbr_id", confidence: "high" }] },
        value: "{{member_id}}",
        risk: "safe",
        ...overrides,
      },
    ],
    outcomes: [],
    recoverables: [],
  };
}

describe("assertNoObservedValues", () => {
  it("passes for a properly parameterized artifact with only contract constants", () => {
    const artifact = baseArtifact({});
    expect(() => assertNoObservedValues(artifact, ["10001"])).not.toThrow();
  });

  it("does not flag a legitimate contract constant (e.g. currency: const \"USD\")", () => {
    const artifact = baseArtifact({});
    expect(() => assertNoObservedValues(artifact, ["10001"])).not.toThrow();
  });

  it("fails the compile when a raw sensitive value leaked into the artifact", () => {
    // Simulates a bug: the step's value never got parameterized.
    const artifact = baseArtifact({ value: "10001" });
    expect(() => assertNoObservedValues(artifact, ["10001"])).toThrow(/raw value observed/);
  });

  // Named to match the spec's required test name verbatim.
  it("test_artifact_contains_no_observed_values", () => {
    const clean = baseArtifact({});
    expect(() => assertNoObservedValues(clean, ["10001", "99999", "10002"])).not.toThrow();

    const leaky = baseArtifact({ value: "10001" });
    expect(() => assertNoObservedValues(leaky, ["10001", "99999", "10002"])).toThrow();
  });

  it("fails when a sensitive value leaked into an outcome's detected message text", () => {
    const artifact = baseArtifact({});
    artifact.outcomes.push({
      id: "leak",
      class: "business_outcome",
      detect: { kind: "text_present", pattern: "x", within: "div" },
      returns: { status: "leak", message: "member 10001 was not found" },
    });
    expect(() => assertNoObservedValues(artifact, ["10001"])).toThrow();
  });
});
