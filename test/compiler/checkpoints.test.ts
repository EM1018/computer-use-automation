import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectAssertionCandidates, pickCheckpoint, synthesizeAssertSteps, type AssertionCandidate, type BranchPageSignature, type PositionCandidates } from "../../src/compiler/checkpoints.js";
import type { Step } from "../../src/schema/capability.js";
import type { StepDerivation } from "../../src/compiler/driver.js";

function textCandidate(text: string, within = "b >> nth=0"): AssertionCandidate {
  return { checkpoint: { kind: "text_present", pattern: text, within }, distinguishingText: text };
}

function urlCandidate(pattern: string): AssertionCandidate {
  return { checkpoint: { kind: "url_matches", pattern }, distinguishingText: pattern };
}

describe("collectAssertionCandidates (live)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("finds a text candidate scoped with `within`, not a page-wide match", async () => {
    await page.setContent(`
      <table>
        <tr><td><b>Name</b></td><td>Alice</td></tr>
        <tr><td><b>Member ID</b></td><td>10001</td></tr>
      </table>
      <p><b>Accounts</b></p>
    `);

    const candidates = await collectAssertionCandidates(page, { member_id: "10001" });
    const accounts = candidates.find((c) => c.distinguishingText === "Accounts");

    expect(accounts).toBeDefined();
    expect(accounts?.checkpoint.kind).toBe("text_present");
    if (accounts?.checkpoint.kind === "text_present") {
      expect(accounts.checkpoint.within).toBeTruthy();
      expect(accounts.checkpoint.within).not.toBe(""); // scoped, not page-wide (no `within` at all would mean "body")
    }
  });

  it("generalizes a url_matches candidate over the supplied input's value, not the literal id used this run", async () => {
    await page.route("**/member/10001", (route) => route.fulfill({ body: "<html><body>x</body></html>", contentType: "text/html" }));
    await page.goto("http://example.test/member/10001");

    const candidates = await collectAssertionCandidates(page, { member_id: "10001" });
    const urlOne = candidates.find((c) => c.checkpoint.kind === "url_matches");

    expect(urlOne).toBeDefined();
    if (urlOne?.checkpoint.kind === "url_matches") {
      expect(urlOne.checkpoint.pattern).not.toContain("10001");
      expect(new RegExp(urlOne.checkpoint.pattern).test("/member/10001")).toBe(true);
      expect(new RegExp(urlOne.checkpoint.pattern).test("/member/99999")).toBe(true);
    }
  });
});

describe("pickCheckpoint", () => {
  it("picks the first candidate that survives every branch page", () => {
    const decision = pickCheckpoint([textCandidate("Accounts")], []);
    expect(decision.checkpoint).toMatchObject({ kind: "text_present", pattern: "Accounts" });
    expect(decision.note).toBeUndefined();
  });

  it("rejects a candidate that also appears on a probed branch page, in favor of one that doesn't", () => {
    const branchPages: BranchPageSignature[] = [{ variantId: "not_found", url: "/search", bodyText: "No member found. Name field is required." }];
    // "Name" collides with the not-found page's own copy; "Accounts" does not.
    const decision = pickCheckpoint([textCandidate("Name"), textCandidate("Accounts")], branchPages);

    expect(decision.checkpoint).toMatchObject({ pattern: "Accounts" });
  });

  it("prefers text_present over element_present over url_matches when multiple survive", () => {
    const elementCandidate: AssertionCandidate = { checkpoint: { kind: "element_present", role: "heading", name: "Accounts" }, distinguishingText: "Accounts" };
    const decision = pickCheckpoint([urlCandidate("/member/[^/]+"), elementCandidate, textCandidate("Accounts")], []);

    expect(decision.checkpoint?.kind).toBe("text_present");
  });

  it("rejects a url_matches candidate whose pattern also matches a branch page's URL (same URL shape, different page — the case legacy apps make likely)", () => {
    // A permission-denied page renders at the SAME url shape as the happy
    // path (/member/<id>) in this app — exactly why url_matches is the
    // lowest-priority candidate kind: it commonly can't tell branch pages
    // apart from the happy path at all.
    const branchPages: BranchPageSignature[] = [{ variantId: "permission_denied", url: "http://x/member/10002", bodyText: "You do not have permission." }];
    const decision = pickCheckpoint([urlCandidate("/member/[^/]+")], branchPages);
    expect(decision.checkpoint).toBeUndefined();
  });

  it("emits no checkpoint and a clear note when every candidate collides with a branch page", () => {
    const branchPages: BranchPageSignature[] = [{ variantId: "not_found", url: "/search", bodyText: "Accounts Name Member ID" }];
    const decision = pickCheckpoint([textCandidate("Accounts"), textCandidate("Name")], branchPages);

    expect(decision.checkpoint).toBeUndefined();
    expect(decision.note).toMatch(/no candidate assertion distinguished/);
  });

  it("emits no checkpoint and a note when there were no candidates to begin with", () => {
    const decision = pickCheckpoint([], []);
    expect(decision.checkpoint).toBeUndefined();
    expect(decision.note).toMatch(/no candidate assertion could be derived/);
  });
});

describe("synthesizeAssertSteps", () => {
  function step(id: string, action: Step["action"]): Step {
    return { id, action, risk: "safe" } as Step;
  }

  it("inserts an assert step immediately before an extract step", () => {
    const steps: Step[] = [step("s1", "click"), step("s2", "extract")];
    const derivations: StepDerivation[] = [
      { stepId: "s1", turn: 0, action: "click", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false },
      { stepId: "s2", turn: 1, action: "extract", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false },
    ];
    const candidatesByPosition = new Map<number, PositionCandidates>([[1, { reason: "before_extract", candidates: [textCandidate("Accounts")] }]]);

    const result = synthesizeAssertSteps({ steps, derivations, candidatesByPosition }, [], true);

    expect(result.steps.map((s) => s.action)).toEqual(["click", "assert", "extract"]);
    expect(result.steps[1]?.checkpoint).toMatchObject({ pattern: "Accounts" });
    // Ids renumbered sequentially after insertion.
    expect(result.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("keeps derivations aligned with their (possibly renumbered) step after insertion, skipping navigate steps which never had one", () => {
    const steps: Step[] = [step("s1", "navigate"), step("s2", "click"), step("s3", "extract")];
    const derivations: StepDerivation[] = [
      { stepId: "s2", turn: 0, action: "click", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false },
      { stepId: "s3", turn: 1, action: "extract", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false },
    ];
    const candidatesByPosition = new Map<number, PositionCandidates>([[2, { reason: "before_extract", candidates: [textCandidate("Accounts")] }]]);

    const result = synthesizeAssertSteps({ steps, derivations, candidatesByPosition }, [], true);

    expect(result.steps.map((s) => `${s.id}:${s.action}`)).toEqual(["s1:navigate", "s2:click", "s3:assert", "s4:extract"]);
    // The click's derivation now points at s2 (unchanged), the extract's at s4 (shifted by the inserted assert).
    expect(result.derivations.find((d) => d.action === "click")?.stepId).toBe("s2");
    expect(result.derivations.find((d) => d.action === "extract")?.stepId).toBe("s4");
  });

  it("does not emit a checkpoint, and adds a compiler note, when no candidate distinguishes the happy path", () => {
    const steps: Step[] = [step("s1", "extract")];
    const derivations: StepDerivation[] = [{ stepId: "s1", turn: 0, action: "extract", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false }];
    const branchPages: BranchPageSignature[] = [{ variantId: "not_found", url: "/search", bodyText: "Accounts" }];
    const candidatesByPosition = new Map<number, PositionCandidates>([[0, { reason: "before_extract", candidates: [textCandidate("Accounts")] }]]);

    const result = synthesizeAssertSteps({ steps, derivations, candidatesByPosition }, branchPages, true);

    const assertStep = result.steps.find((s) => s.action === "assert");
    expect(assertStep?.checkpoint).toBeUndefined();
    expect(result.notes.some((n) => n.includes("no candidate assertion distinguished"))).toBe(true);
  });

  it("still synthesizes a checkpoint when probing did not run, with a note flagging it as unvalidated", () => {
    const steps: Step[] = [step("s1", "extract")];
    const derivations: StepDerivation[] = [{ stepId: "s1", turn: 0, action: "extract", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false }];
    const candidatesByPosition = new Map<number, PositionCandidates>([[0, { reason: "before_extract", candidates: [textCandidate("Accounts")] }]]);

    const result = synthesizeAssertSteps({ steps, derivations, candidatesByPosition }, [], false);

    const assertStep = result.steps.find((s) => s.action === "assert");
    expect(assertStep?.checkpoint).toMatchObject({ pattern: "Accounts" });
    expect(result.notes.some((n) => n.includes("no branch-page negative set"))).toBe(true);
  });

  it("sets on_fail: evaluate_outcomes on every synthesized assert", () => {
    const steps: Step[] = [step("s1", "extract")];
    const derivations: StepDerivation[] = [{ stepId: "s1", turn: 0, action: "extract", candidatesGenerated: [], candidatesVerified: [], candidatesDiscarded: [], zeroVerified: false }];
    const candidatesByPosition = new Map<number, PositionCandidates>([[0, { reason: "before_extract", candidates: [textCandidate("Accounts")] }]]);

    const result = synthesizeAssertSteps({ steps, derivations, candidatesByPosition }, [], true);
    expect(result.steps.find((s) => s.action === "assert")?.on_fail).toBe("evaluate_outcomes");
  });
});
