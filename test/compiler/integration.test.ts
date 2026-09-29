/**
 * End-to-end sanity check: a HAND-AUTHORED (mocked, no LLM) transcript that
 * mimics exactly what discovery would have produced for "look up a member's
 * savings balance" with member_id=10001, fed through the real compiler
 * pipeline against the real target app. This is the one test that exercises
 * every transformation together (prune, parameterize, derive+verify
 * locators, derive contract, probe outcomes, mandatory verification) rather
 * than each in isolation.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileArtifact } from "../../src/compiler/compile.js";
import { replay } from "../../src/engine/replay.js";
import { SessionFactory } from "../../src/engine/session.js";
import type { AppConfig, PolicyConfig } from "../../src/engine/config.js";
import { OPERATOR_PASS, OPERATOR_USER, startFlaskServer, type FlaskServer } from "../helpers/flask-server.js";
import type { ActionLogEntry, TranscriptTurnEntry } from "../../src/schema/discovery.js";

const PORT = 5075;
const RUN_ID = "integration-lookup-balance";

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""), "utf8");
}

describe("compiler end-to-end against the real target app", () => {
  let server: FlaskServer;
  let evidenceRoot: string;
  let draftsDir: string;
  let appConfig: AppConfig;
  let policy: PolicyConfig;

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
    policy = { allowedBaseUrls: [server.baseUrl] };
  }, 30000);

  afterAll(async () => {
    await server?.stop();
  });

  afterEach(() => {
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(draftsDir, { recursive: true, force: true });
  });

  /**
   * Writes a hand-authored (mocked, no LLM) transcript mimicking exactly
   * what discovery would have produced for "look up a member's savings
   * balance" with member_id=10001 — shared by both the full (probing on)
   * and --no-probe tests below.
   */
  function writeFixtureTranscript(runId: string): string {
    const runDir = join(evidenceRoot, runId);
    mkdirSync(runDir, { recursive: true });

    // SessionFactory logs in and lands on /search already, so the mocked
    // transcript starts there directly — same as a real discovery run
    // would (login is not part of any capability, see README.md).
    const memberIdFieldRef = {
      ref: "e1",
      role: "textbox",
      name: "Member ID",
      playwrightRef: "f1e1",
      tag: "input",
      attributes: { id: "f_mbr_id", name: "f_mbr_id", type: "text" },
      hasLabel: true,
      labelText: "Member ID",
    };
    const searchButtonRef = {
      ref: "e2",
      role: "button",
      name: "Search",
      playwrightRef: "f1e2",
      tag: "input",
      attributes: { type: "submit" },
    };
    const balanceCellRef = {
      ref: "e3",
      role: "cell",
      playwrightRef: "f1e3",
      tag: "td",
      nearbyText: { rowFirstCell: "Savings" },
      // Mirrors what real evidence actually contains post-redaction: the id
      // segment of the live iframe URL is a registered secret and would
      // have been scrubbed before this ever reached disk (see
      // src/engine/redactor.ts) — frameSelectorFor only ever looks at the
      // LAST path segment ("panel") anyway, so this is functionally
      // identical to the raw URL for derivation purposes.
      frame: { name: "", url: `${server.baseUrl}/member/[REDACTED:member_id]/panel`, index: 1 },
    };

    const actions: ActionLogEntry[] = [
      { turn: 0, action: { action: "fill", ref: "e1", value: "[REDACTED:member_id]" }, ref_resolution: memberIdFieldRef },
      { turn: 1, action: { action: "click", ref: "e2" }, ref_resolution: searchButtonRef },
      { turn: 2, action: { action: "extract", ref: "e3", output_name: "balance" }, ref_resolution: balanceCellRef },
    ];
    writeJsonl(join(runDir, "actions.jsonl"), actions);

    // Turns 2-3's URL is written the way real evidence actually contains it:
    // the id segment is a registered secret and gets scrubbed by the
    // Redactor before writeTranscriptTurn ever reaches disk (every field is
    // scrubbed, url included) — this fixture mirrors that rather than
    // writing the raw URL EvidenceWriter would never actually persist.
    const turns: TranscriptTurnEntry[] = [
      { turn: 0, url: `${server.baseUrl}/search`, observation_summary: "search form (empty)", model_reasoning: "", action: actions[0]!.action, result: "ok", page_changed: false },
      { turn: 1, url: `${server.baseUrl}/search`, observation_summary: "search form (filled)", model_reasoning: "", action: actions[1]!.action, result: "ok", page_changed: true },
      { turn: 2, url: `${server.baseUrl}/member/[REDACTED:member_id]`, observation_summary: "member detail page", model_reasoning: "", action: actions[2]!.action, result: "ok", page_changed: false },
      { turn: 3, url: `${server.baseUrl}/member/[REDACTED:member_id]`, observation_summary: "member detail page (after extract)", model_reasoning: "", action: { action: "done", reason: "balance found" }, result: "ok", page_changed: false },
    ];
    writeJsonl(join(runDir, "transcript.jsonl"), turns);

    // launch.json as EvidenceWriter.writeLaunchInfo actually produces it now:
    // goal and input NAMES survive, values come out as labeled placeholders.
    // Real values reach the compiler only via the `launch` override below —
    // never read back from this file (see transcript.ts's readLaunch).
    writeFileSync(join(runDir, "launch.json"), JSON.stringify({ goal: "Look up a member's savings balance", inputs: { member_id: "[REDACTED:member_id]" } }), "utf8");

    return runDir;
  }

  it("compiles a hand-authored transcript into a verified, reusable artifact", async () => {
    evidenceRoot = mkdtempSync(join(tmpdir(), "compiler-integration-evidence-"));
    draftsDir = mkdtempSync(join(tmpdir(), "compiler-integration-drafts-"));
    const runDir = writeFixtureTranscript(RUN_ID);

    const result = await compileArtifact({
      runId: RUN_ID,
      evidenceRoot,
      draftsDir,
      probe: true,
      appConfig,
      policy,
      launch: { goal: "Look up a member's savings balance", inputs: { member_id: "10001" } },
      target: {
        capabilityId: "lookup_savings_balance_test",
        title: "Look up member savings balance",
        description: "Test-compiled capability",
        app: "legacy-cu-back-office",
        appVersion: "1.0.0",
        tenant: "first_credit_union",
        model: "claude-sonnet-5",
      },
    });

    expect(result.artifact.verification?.status, JSON.stringify(result.artifact.verification)).toBe("passed");
    expect(result.passed).toBe(true);
    expect(existsSync(result.artifactPath)).toBe(true);

    // Every step targets via a VERIFIED strategy, not the unverified fallback.
    expect(result.artifact.compiler_notes ?? []).toEqual([]);

    // Parameterization: the artifact must reference {{member_id}}, never "10001" literally.
    const fillStep = result.artifact.steps.find((s) => s.action === "fill");
    expect(fillStep?.value).toBe("{{member_id}}");

    // Contract derivation.
    expect(result.artifact.inputs).toEqual([expect.objectContaining({ name: "member_id", type: "string", sensitivity: "pii" })]);
    expect(result.artifact.outputs).toEqual([expect.objectContaining({ name: "balance", type: "number" })]);

    // Outcome probing found at least the not-found/permission-denied business outcomes.
    const outcomeIds = result.artifact.outcomes.map((o) => o.id);
    expect(outcomeIds).toContain("not_found");
    expect(result.artifact.outcomes.every((o) => o.provenance === "probed")).toBe(true);

    // A synthesized assert step sits immediately before the extract step,
    // scoped (not a page-wide match), and routes a failed checkpoint into
    // outcome evaluation rather than a hard failure.
    const extractIndex = result.artifact.steps.findIndex((s) => s.action === "extract");
    const assertStep = result.artifact.steps[extractIndex - 1];
    expect(assertStep?.action).toBe("assert");
    expect(assertStep?.checkpoint).toBeDefined();
    expect(assertStep?.on_fail).toBe("evaluate_outcomes");
    if (assertStep?.checkpoint?.kind === "text_present") {
      expect(assertStep.checkpoint.within).toBeTruthy();
    }

    // The defining behavior this feature exists for: replaying the
    // COMPILED artifact against member_id=99999 must hit the synthesized
    // checkpoint and return the not_found business outcome — never fail
    // one step later at the extract's own locator.
    let replaySession: Awaited<ReturnType<typeof SessionFactory.create>> | undefined;
    const replayResult = await replay(
      result.artifact,
      { member_id: "99999" },
      async () => {
        replaySession = await SessionFactory.create(appConfig);
        return replaySession;
      },
      { ...policy, allowDraft: true, unattended: true },
      { evidenceRoot, runId: "integration-replay-not-found" },
    );
    await replaySession?.close().catch(() => undefined);
    await replaySession?.browser.close().catch(() => undefined);

    expect(replayResult.status).toBe("not_found");
    expect("outcome_id" in replayResult && replayResult.outcome_id).toBe("not_found");
    expect("failed_step" in replayResult).toBe(false);
    const replaySteps = readFileSync(join(evidenceRoot, "integration-replay-not-found", "steps.jsonl"), "utf8");
    const replayStepLines = replaySteps.trim().split("\n").map((line) => JSON.parse(line) as { step: string; action: string; outcome: string });
    // The assert step is the one that actually caught the divergence —
    // extract never even ran.
    expect(replayStepLines.find((l) => l.action === "assert")?.outcome).toBe("not_found");
    expect(replayStepLines.some((l) => l.action === "extract")).toBe(false);

    // No raw sensitive value anywhere in the serialized draft file on disk.
    const writtenYaml = readFileSync(result.artifactPath, "utf8");
    expect(writtenYaml).not.toContain("10001");
    expect(writtenYaml).not.toContain("99999");

    expect(existsSync(result.compileDiffPath)).toBe(true);
    const diff = readFileSync(result.compileDiffPath, "utf8");
    expect(diff).toContain("{{member_id}}");

    // No raw input value anywhere under evidence/, launch.json included —
    // grep the whole run directory, not just the files we happened to check
    // above.
    for (const file of readdirSync(runDir, { recursive: true }) as string[]) {
      const full = join(runDir, file);
      if (statSync(full).isFile()) {
        const content = readFileSync(full, "utf8");
        expect(content, `${full} should not contain the raw member_id`).not.toContain("10001");
      }
    }
  }, 60000);

  it("--no-probe still produces a synthesized checkpoint, flagged as unvalidated against branch pages", async () => {
    evidenceRoot = mkdtempSync(join(tmpdir(), "compiler-integration-evidence-noprobe-"));
    draftsDir = mkdtempSync(join(tmpdir(), "compiler-integration-drafts-noprobe-"));
    const runId = "integration-no-probe";
    writeFixtureTranscript(runId);

    const result = await compileArtifact({
      runId,
      evidenceRoot,
      draftsDir,
      probe: false,
      appConfig,
      policy,
      launch: { goal: "Look up a member's savings balance", inputs: { member_id: "10001" } },
      target: {
        capabilityId: "lookup_savings_balance_noprobe",
        title: "Look up member savings balance",
        description: "Test-compiled capability",
        app: "legacy-cu-back-office",
        appVersion: "1.0.0",
        tenant: "first_credit_union",
        model: "claude-sonnet-5",
      },
    });

    const assertStep = result.artifact.steps.find((s) => s.action === "assert");
    expect(assertStep?.checkpoint).toBeDefined();
    expect(result.artifact.compiler_notes?.some((n) => n.includes("no branch-page negative set"))).toBe(true);
  }, 60000);

  it("a goal that names the input's value directly (e.g. \"...for account 10001\") does not leak it into title/description/capability id/compile_diff.md", async () => {
    // Regression test: a completely natural goal phrasing that happens to
    // say the input's value in plain prose (not a contrived edge case —
    // this is what a real user typed) used to flow straight into
    // capability.title/description (and, via slugify in the CLIs, into
    // capability.id) unparameterized, tripping assertNoObservedValues at
    // best and silently leaking into compile_diff.md's Goal line at worst
    // (that file isn't covered by the safety check at all).
    evidenceRoot = mkdtempSync(join(tmpdir(), "compiler-integration-evidence-goalleak-"));
    draftsDir = mkdtempSync(join(tmpdir(), "compiler-integration-drafts-goalleak-"));
    const runId = "integration-goal-leak";
    const runDir = writeFixtureTranscript(runId);
    const goalNamingTheValue = "Give me the savings balance for member 10001";

    const result = await compileArtifact({
      runId,
      evidenceRoot,
      draftsDir,
      probe: false,
      appConfig,
      policy,
      launch: { goal: goalNamingTheValue, inputs: { member_id: "10001" } },
      target: {
        capabilityId: "lookup_savings_balance_goalleak",
        title: goalNamingTheValue,
        description: goalNamingTheValue,
        app: "legacy-cu-back-office",
        appVersion: "1.0.0",
        tenant: "first_credit_union",
        model: "claude-sonnet-5",
      },
    });

    expect(result.artifact.capability.title).not.toContain("10001");
    expect(result.artifact.capability.title).toContain("{{member_id}}");
    expect(result.artifact.capability.description).not.toContain("10001");
    expect(result.artifact.compiler_notes?.some((n) => n.includes("parameterized"))).toBe(true);

    const diff = readFileSync(join(evidenceRoot, runId, "compile_diff.md"), "utf8");
    expect(diff).not.toContain("10001");
    expect(diff).toContain("{{member_id}}");

    for (const file of readdirSync(runDir, { recursive: true }) as string[]) {
      const full = join(runDir, file);
      if (statSync(full).isFile()) {
        expect(readFileSync(full, "utf8"), `${full} should not contain the raw member_id`).not.toContain("10001");
      }
    }
  }, 60000);
});
