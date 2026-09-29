/**
 * Closes the loop between pruning and the compiled artifact itself: a
 * transcript with a dead-end loop must produce an artifact whose STEPS
 * exclude it, not just a prune() call whose turn numbers exclude it (see
 * prune.test.ts for that narrower check). Uses a real Playwright page
 * against static content — no flask/login needed, since this is only
 * exercising prune -> parameterize -> derive, not the full compileArtifact
 * orchestrator.
 */
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneDeadEnds } from "../../src/compiler/prune.js";
import { parameterizeActions } from "../../src/compiler/parameterize.js";
import { driveAndDeriveSteps } from "../../src/compiler/driver.js";
import type { ActionLogEntry, TranscriptTurnEntry } from "../../src/schema/discovery.js";

describe("a dead-end loop is excluded from the compiled artifact's steps", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(`
      <form>
        <label for="mbr">Member ID</label>
        <input id="mbr" name="mbr">
        <button id="search-btn">Search</button>
      </form>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it("compiles only the load-bearing fill, never the wrong-turn click the model backed out of", async () => {
    const wrongClickRef = { ref: "e9", role: "button", name: "WrongButton", playwrightRef: "f1e9" };
    const fillRef = { ref: "e1", role: "textbox", name: "Member ID", playwrightRef: "f1e1", hasLabel: true, labelText: "Member ID" };

    const turns: TranscriptTurnEntry[] = [
      { turn: 0, url: "http://x/form", observation_summary: "A", model_reasoning: "", action: { action: "click", ref: "e9" }, result: "ok", page_changed: true },
      { turn: 1, url: "http://x/wrong-page", observation_summary: "B", model_reasoning: "", action: { action: "navigate", url: "http://x/form" }, result: "ok", page_changed: true },
      // Back to the exact same state as turn 0 — turns 0-1 are a dead end.
      { turn: 2, url: "http://x/form", observation_summary: "A", model_reasoning: "", action: { action: "fill", ref: "e1", value: "[REDACTED:member_id]" }, result: "ok", page_changed: false },
    ];

    const actions: ActionLogEntry[] = [
      { turn: 0, action: { action: "click", ref: "e9" }, ref_resolution: wrongClickRef },
      { turn: 1, action: { action: "navigate", url: "http://x/form" } },
      { turn: 2, action: { action: "fill", ref: "e1", value: "[REDACTED:member_id]" }, ref_resolution: fillRef },
    ];

    const prune = pruneDeadEnds(turns);
    expect(prune.keptTurns).toEqual([2]);

    const keptSet = new Set(prune.keptTurns);
    const keptActionEntries = actions
      .filter((a) => keptSet.has(a.turn))
      .map((a) => ({ turn: a.turn, action: a.action, ...(a.ref_resolution ? { refDescriptor: a.ref_resolution } : {}) }));

    const parameterized = parameterizeActions(keptActionEntries, { member_id: "10001" });
    const result = await driveAndDeriveSteps(page, parameterized.actions, "http://x", new Map(), { member_id: "10001" });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toBe("fill");
    expect(result.steps[0]?.value).toBe("{{member_id}}");
  });
});
