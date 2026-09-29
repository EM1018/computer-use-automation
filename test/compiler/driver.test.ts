import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveAndDeriveSteps } from "../../src/compiler/driver.js";
import type { CompiledAction } from "../../src/compiler/parameterize.js";

describe("driveAndDeriveSteps", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("derives a step with a verified role_name strategy and advances the page", async () => {
    await page.setContent(`<button id="btn1">Search</button>`);
    const actions: CompiledAction[] = [{ turn: 0, kind: "click", ref: "e1", refDescriptor: { ref: "e1", role: "button", name: "Search", playwrightRef: "f1e1" } }];

    const result = await driveAndDeriveSteps(page, actions, "http://example.test", new Map(), {});

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toBe("click");
    expect(result.steps[0]?.target?.strategies[0]).toMatchObject({ kind: "role_name", role: "button", name: "Search" });
    expect(result.notes).toEqual([]);
  });

  it("marks the artifact draft with a clear note when a step has ZERO verified strategies", async () => {
    await page.setContent(`<button id="btn1">Search</button>`);
    // The descriptor's name doesn't match anything on the page, and there is
    // no label/stable-attribute/nearby-text to fall back on — every
    // candidate this generates will fail live verification.
    const actions: CompiledAction[] = [{ turn: 3, kind: "click", ref: "e9", refDescriptor: { ref: "e9", role: "button", name: "DoesNotExistOnPage", playwrightRef: "f1e9" } }];

    const result = await driveAndDeriveSteps(page, actions, "http://example.test", new Map(), {});

    expect(result.steps).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatch(/ZERO candidate strategies verified/);
    expect(result.notes[0]).toContain("turn 3");
    // A step must still be schema-shaped (at least one strategy), even
    // though it's an unverified last resort.
    expect(result.steps[0]?.target?.strategies.length).toBeGreaterThan(0);
  });

  it("infers an extract step's transform from the observed sample without storing the sample itself", async () => {
    await page.setContent(`<table><tr><td>Savings</td><td id="bal">$1,234.56</td></tr></table>`);
    const actions: CompiledAction[] = [
      { turn: 0, kind: "extract", ref: "e1", outputName: "balance", refDescriptor: { ref: "e1", role: "cell", playwrightRef: "f1e1", nearbyText: { rowFirstCell: "Savings" } } },
    ];

    const result = await driveAndDeriveSteps(page, actions, "http://example.test", new Map(), {});

    expect(result.steps[0]?.transform).toBe("parse_currency");
    expect(result.outputSamples.get("balance")).toBe("$1,234.56");
  });
});
