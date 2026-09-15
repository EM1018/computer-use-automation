import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approveCapability } from "../src/approval.js";
import { loadArtifact } from "../src/loader.js";
import { preflight } from "../src/engine/policy.js";
import { replay } from "../src/engine/replay.js";
import { SessionFactory, type Session } from "../src/engine/session.js";
import type { AppConfig, PolicyConfig } from "../src/engine/config.js";
import type { CapabilityArtifact } from "../src/schema/capability.js";
import { OPERATOR_PASS, OPERATOR_USER, startFlaskServer, type FlaskServer } from "./helpers/flask-server.js";
import { loadExampleArtifact } from "./helpers/fixture.js";

const DRAFT_FIXTURE_PATH = join(process.cwd(), "artifacts", "drafts", "lookup_savings_balance.v1.0.yaml");

function loadDraftObject(): CapabilityArtifact {
  const result = loadArtifact(DRAFT_FIXTURE_PATH);
  if (!result.ok) {
    throw new Error(`fixture failed to load: ${result.error.message}`);
  }
  return structuredClone(result.artifact);
}

function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([key, val]) => [key, reorderKeysDeep(val)]));
  }
  return value;
}

describe("approval gate", () => {
  let dir: string;
  let draftsDir: string;
  let artifactsDir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDirs(): void {
    dir = mkdtempSync(join(tmpdir(), "approval-"));
    draftsDir = join(dir, "drafts");
    artifactsDir = dir;
    mkdirSync(draftsDir, { recursive: true });
  }

  function writeDraft(overrides: (artifact: CapabilityArtifact) => CapabilityArtifact = (a) => a): string {
    const artifact = overrides(loadDraftObject());
    const filename = `${artifact.capability.id}.v${artifact.capability.version.major}.${artifact.capability.version.minor}.yaml`;
    const path = join(draftsDir, filename);
    writeFileSync(path, yaml.dump(artifact), "utf8");
    return path;
  }

  it("refuses when no verification record exists", () => {
    freshDirs();
    writeDraft(); // the real fixture has no verification block at all

    const result = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/verification/i);
  });

  it("refuses when the last verification failed", () => {
    freshDirs();
    writeDraft((a) => ({ ...a, verification: { status: "failed", run: "run_bad" } }));

    const result = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/verification/i);
  });

  it("refuses an artifact already outside drafts/", () => {
    freshDirs();
    // Placed directly under artifactsDir, never under draftsDir.
    const artifact = loadDraftObject();
    writeFileSync(join(artifactsDir, "lookup_savings_balance.v1.0.yaml"), yaml.dump(artifact), "utf8");

    const result = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not currently in/i);
  });

  it("moves the file and stamps approver, timestamp, and hash", () => {
    freshDirs();
    const draftPath = writeDraft((a) => ({ ...a, verification: { status: "passed", run: "run_good" } }));
    const fixedNow = new Date("2026-02-01T00:00:00.000Z");

    const result = approveCapability("lookup_savings_balance", 1, 0, "alice", {
      draftsDir,
      artifactsDir,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(draftPath)).toBe(false);
    const targetPath = join(artifactsDir, "lookup_savings_balance.v1.0.yaml");
    expect(result.path).toBe(targetPath);

    const loaded = loadArtifact(targetPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.artifact.capability.status).toBe("approved");
    expect(loaded.artifact.approval?.approver).toBe("alice");
    expect(loaded.artifact.approval?.approved_at).toBe(fixedNow.toISOString());
    expect(loaded.artifact.approval?.verification_run).toBe("run_good");
    expect(loaded.artifact.approval?.content_hash).toBe(result.contentHash);
  });

  it("refuses a draft whose first strategy is 'coordinates' on any step", () => {
    freshDirs();
    writeDraft((a) => {
      const clone = structuredClone(a);
      clone.verification = { status: "passed", run: "run_good" };
      const extractStep = clone.steps.find((step) => step.action === "extract");
      if (extractStep?.target) {
        extractStep.target.strategies = [
          { kind: "coordinates", x: 1, y: 1, viewport: { width: 800, height: 600 }, confidence: "low" },
        ];
      }
      return clone;
    });

    const result = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/coordinates/i);
  });

  it("fails to load with a clear error once an approved artifact's content is edited by one character", () => {
    freshDirs();
    writeDraft((a) => ({ ...a, verification: { status: "passed", run: "run_good" } }));
    const approveResult = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(approveResult.ok).toBe(true);
    if (!approveResult.ok) return;

    const raw = readFileSync(approveResult.path, "utf8");
    // One character changed in a field that isn't the approval block.
    const edited = raw.replace("Look up member savings balance", "Look up member savings balancd");
    expect(edited).not.toBe(raw);
    writeFileSync(approveResult.path, edited, "utf8");

    const reloaded = loadArtifact(approveResult.path);
    expect(reloaded.ok).toBe(false);
    if (reloaded.ok) return;
    expect(reloaded.error.message).toMatch(/lookup_savings_balance/);
    expect(reloaded.error.message).toMatch(/1\.0/);
    expect(reloaded.error.message).toMatch(/edited|hash/i);
  });

  it("is not invalidated by reformatting (reordered keys, different indentation)", () => {
    freshDirs();
    writeDraft((a) => ({ ...a, verification: { status: "passed", run: "run_good" } }));
    const approveResult = approveCapability("lookup_savings_balance", 1, 0, "alice", { draftsDir, artifactsDir });
    expect(approveResult.ok).toBe(true);
    if (!approveResult.ok) return;

    const approvedLoaded = loadArtifact(approveResult.path);
    expect(approvedLoaded.ok).toBe(true);
    if (!approvedLoaded.ok) return;

    const reformatted = reorderKeysDeep(approvedLoaded.artifact);
    const reformattedPath = join(artifactsDir, "reformatted.yaml");
    writeFileSync(reformattedPath, yaml.dump(reformatted, { indent: 4, sortKeys: false }), "utf8");

    const reloaded = loadArtifact(reformattedPath);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.artifact.approval?.content_hash).toBe(approvedLoaded.artifact.approval?.content_hash);
  });
});

describe("unattended replay and the approval gate", () => {
  it("rejects a draft without touching a browser", () => {
    const artifact = loadDraftObject();
    const policy: PolicyConfig = { allowedBaseUrls: [artifact.recorded_against.base_url], unattended: true };
    const pre = preflight(artifact, { member_id: "10001" }, policy, "run-reject-draft");

    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.result.status).toBe("failed");
    if (!("failed_step" in pre.result)) return;
    expect(pre.result.failed_step).toBe("preflight:approval");
  });

  it("--allow-draft permits it and surfaces a warning", () => {
    const artifact = loadDraftObject();
    const policy: PolicyConfig = {
      allowedBaseUrls: [artifact.recorded_against.base_url],
      unattended: true,
      allowDraft: true,
    };
    const pre = preflight(artifact, { member_id: "10001" }, policy, "run-allow-draft");

    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.warning).toMatch(/draft/i);
  });

  describe("logged to evidence", () => {
    const PORT = 5058;
    let server: FlaskServer;
    let browser: Browser;
    let appConfig: AppConfig;
    let activeSession: Session | undefined;

    beforeAll(async () => {
      process.env["FCU_OPERATOR_USER"] = OPERATOR_USER;
      process.env["FCU_OPERATOR_PASS"] = OPERATOR_PASS;
      server = await startFlaskServer(PORT);
      appConfig = {
        baseUrl: server.baseUrl,
        loginPath: "/login",
        usernameSelector: "#txtUser",
        passwordSelector: "#txtPass",
        submitSelector: "input[type=submit]",
        headless: true,
      };
      browser = await chromium.launch({ headless: true });
    }, 30000);

    afterAll(async () => {
      await browser?.close();
      await server?.stop();
    });

    afterEach(async () => {
      await activeSession?.close();
      activeSession = undefined;
    });

    it("writes the draft warning into evidence/<run_id>/warnings.jsonl", async () => {
      const artifact = loadExampleArtifact(server.baseUrl); // still a draft on disk
      const policy: PolicyConfig = { allowedBaseUrls: [server.baseUrl], unattended: true, allowDraft: true };
      const evidenceRoot = mkdtempSync(join(tmpdir(), "evidence-"));
      const runId = "allow-draft-evidence";

      const getSession = async (): Promise<Session> => {
        activeSession = await SessionFactory.createInBrowser(browser, appConfig);
        return activeSession;
      };

      const result = await replay(artifact, { member_id: "10001" }, getSession, policy, { runId, evidenceRoot });
      expect(result.status).toBe("success");

      const warningsPath = join(evidenceRoot, runId, "warnings.jsonl");
      expect(existsSync(warningsPath)).toBe(true);
      const warnings = readFileSync(warningsPath, "utf8");
      expect(warnings).toMatch(/draft/i);

      rmSync(evidenceRoot, { recursive: true, force: true });
    }, 20000);
  });
});
