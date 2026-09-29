import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAndWriteDraft } from "../../src/compiler/verify.js";
import type { CapabilityArtifact } from "../../src/schema/capability.js";
import type { AppConfig, PolicyConfig } from "../../src/engine/config.js";

function draftArtifact(): CapabilityArtifact {
  return {
    schema_version: 1,
    capability: { id: "unreachable_cap", version: { major: 1, minor: 0 }, title: "T", description: "D", status: "draft" },
    recorded_against: { app: "legacy-app", app_version: "1.0.0", tenant: "default", base_url: "http://127.0.0.1:5001" },
    provenance: { discovered_at: "2026-01-01T00:00:00Z", model: "claude-sonnet-5", run_id: "run1", transcript_ref: "evidence/run1/transcript.jsonl" },
    inputs: [],
    outputs: [],
    steps: [{ id: "s1", action: "navigate", value: "/search", risk: "safe" }],
    outcomes: [],
    recoverables: [],
  };
}

describe("verifyAndWriteDraft", () => {
  let draftsDir: string | undefined;

  afterEach(() => {
    if (draftsDir) {
      rmSync(draftsDir, { recursive: true, force: true });
    }
    draftsDir = undefined;
  });

  it("still writes the artifact to drafts/ (with failure details) when verification fails, and reports passed: false", async () => {
    draftsDir = mkdtempSync(join(tmpdir(), "compiler-verify-test-"));

    const artifact = draftArtifact();
    // A policy that does not allow the artifact's own base_url makes
    // preflight fail immediately — no browser session is ever launched, so
    // this exercises the "failed verification" path deterministically and
    // fast, without needing a live target app.
    const policy: PolicyConfig = { allowedBaseUrls: ["http://127.0.0.1:1"] };
    const appConfig: AppConfig = {
      baseUrl: artifact.recorded_against.base_url,
      loginPath: "/login",
      usernameSelector: "#u",
      passwordSelector: "#p",
      submitSelector: "#s",
    };

    const result = await verifyAndWriteDraft(artifact, {}, draftsDir, { appConfig, policy });

    expect(result.passed).toBe(false);
    expect(result.artifact.verification?.status).toBe("failed");
    expect(result.artifact.verification?.expected).toContain("allowlist");

    const writtenPath = join(draftsDir, "unreachable_cap.v1.0.yaml");
    expect(existsSync(writtenPath)).toBe(true);
    const written = readFileSync(writtenPath, "utf8");
    expect(written).toContain("status: failed");
  });
});
