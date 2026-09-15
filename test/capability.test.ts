import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it, afterEach } from "vitest";
import { CapabilityArtifactSchema, type CapabilityArtifact, type Action } from "../src/schema/capability.js";
import { loadArtifact, resolveCapability } from "../src/loader.js";
import { classifyChange } from "../src/version.js";

const EXAMPLE_ARTIFACT_PATH = join(process.cwd(), "artifacts", "lookup_savings_balance.v1.0.yaml");

function baseArtifact(): CapabilityArtifact {
  const loaded = loadArtifact(EXAMPLE_ARTIFACT_PATH);
  if (!loaded.ok) {
    throw new Error(`fixture failed to load: ${loaded.error.message}`);
  }
  // Deep clone so mutations in one test don't leak into another.
  return JSON.parse(JSON.stringify(loaded.artifact)) as CapabilityArtifact;
}

describe("example artifact", () => {
  it("loads and validates", () => {
    const result = loadArtifact(EXAMPLE_ARTIFACT_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.artifact.capability.id).toBe("lookup_savings_balance");
    expect(result.artifact.capability.status).toBe("approved");
    expect(result.artifact.inputs).toHaveLength(1);
    expect(result.artifact.outputs.map((o) => o.name)).toEqual(["balance", "currency"]);
    expect(result.artifact.steps.length).toBeGreaterThan(0);
  });
});

describe("schema validation", () => {
  it("rejects an unknown action type with a clear error", () => {
    const artifact = baseArtifact();
    const firstStep = artifact.steps[0];
    if (!firstStep) {
      throw new Error("fixture has no steps");
    }
    firstStep.action = "hover" as unknown as Action;

    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const actionIssue = result.error.issues.find((issue) => issue.path.join(".") === "steps.0.action");
    expect(actionIssue).toBeDefined();
    expect(actionIssue?.message).toMatch(/invalid enum value/i);
  });

  it("rejects a 'coordinates' strategy that isn't the final entry", () => {
    const artifact = baseArtifact();
    const extractStep = artifact.steps.find((step) => step.action === "extract");
    if (!extractStep || !extractStep.target) {
      throw new Error("fixture is missing its extract step's target");
    }

    extractStep.target.strategies = [
      {
        kind: "coordinates",
        x: 100,
        y: 100,
        viewport: { width: 1280, height: 800 },
        confidence: "low",
      },
      {
        kind: "label",
        text: "Savings",
        confidence: "high",
      },
    ];

    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    expect(message).toMatch(/coordinates.*last/i);
  });
});

describe("classifyChange", () => {
  it("returns 'major' when an output is removed", () => {
    const oldArtifact = baseArtifact();
    const newArtifact = baseArtifact();
    newArtifact.outputs = newArtifact.outputs.filter((output) => output.name !== "currency");

    expect(classifyChange(oldArtifact, newArtifact)).toBe("major");
  });

  it("returns 'minor' when only a locator changes", () => {
    const oldArtifact = baseArtifact();
    const newArtifact = baseArtifact();
    const extractStep = newArtifact.steps.find((step) => step.action === "extract");
    if (!extractStep || !extractStep.target) {
      throw new Error("fixture is missing its extract step's target");
    }
    const firstStrategy = extractStep.target.strategies[0];
    if (firstStrategy && firstStrategy.kind === "text_anchored") {
      firstStrategy.anchor = "Savings Balance";
    }

    expect(classifyChange(oldArtifact, newArtifact)).toBe("minor");
  });

  it("returns 'none' when nothing behavior-relevant changed", () => {
    const oldArtifact = baseArtifact();
    const newArtifact = baseArtifact();

    expect(classifyChange(oldArtifact, newArtifact)).toBe("none");
  });
});

describe("resolveCapability", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeArtifactFile(dirPath: string, filename: string, artifact: CapabilityArtifact): void {
    writeFileSync(join(dirPath, filename), yaml.dump(artifact));
  }

  it("skips drafts and returns the highest approved minor", () => {
    dir = mkdtempSync(join(tmpdir(), "capability-artifacts-"));
    mkdirSync(join(dir, "drafts"));

    const approvedV1 = baseArtifact();
    approvedV1.capability.version = { major: 1, minor: 0 };
    approvedV1.capability.status = "approved";
    writeArtifactFile(dir, "lookup_savings_balance.v1.0.yaml", approvedV1);

    const approvedV2 = baseArtifact();
    approvedV2.capability.version = { major: 1, minor: 2 };
    approvedV2.capability.status = "approved";
    writeArtifactFile(dir, "lookup_savings_balance.v1.2.yaml", approvedV2);

    const draftV3 = baseArtifact();
    draftV3.capability.version = { major: 1, minor: 3 };
    draftV3.capability.status = "draft";
    writeArtifactFile(dir, "lookup_savings_balance.v1.3.yaml", draftV3);

    // Approved but stashed under drafts/ with a higher minor than any
    // top-level file: if the resolver ever recursed into drafts/, this
    // would win and the assertion below would fail.
    const shouldNeverBeReturned = baseArtifact();
    shouldNeverBeReturned.capability.version = { major: 1, minor: 9 };
    shouldNeverBeReturned.capability.status = "approved";
    writeArtifactFile(join(dir, "drafts"), "lookup_savings_balance.v1.9.yaml", shouldNeverBeReturned);

    const result = resolveCapability("lookup_savings_balance", 1, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.artifact.capability.version).toEqual({ major: 1, minor: 2 });
  });

  it("reports an error when no approved artifact exists for the major version", () => {
    dir = mkdtempSync(join(tmpdir(), "capability-artifacts-"));

    const draftOnly = baseArtifact();
    draftOnly.capability.version = { major: 1, minor: 0 };
    draftOnly.capability.status = "draft";
    writeArtifactFile(dir, "lookup_savings_balance.v1.0.yaml", draftOnly);

    const result = resolveCapability("lookup_savings_balance", 1, dir);
    expect(result.ok).toBe(false);
  });
});
