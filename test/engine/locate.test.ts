import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTarget } from "../../src/engine/locate.js";
import { AmbiguousTarget, NoTargetFound } from "../../src/engine/errors.js";
import type { Target } from "../../src/schema/capability.js";

describe("strategy ladder resolution", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("throws AmbiguousTarget rather than picking one when a strategy matches 2 elements", async () => {
    await page.setContent(`
      <button class="action">Go</button>
      <button class="action">Go</button>
    `);
    const target: Target = {
      frame: "top",
      strategies: [{ kind: "attribute", selector: "button.action", confidence: "high" }],
    };

    await expect(resolveTarget(page, target, "s1")).rejects.toBeInstanceOf(AmbiguousTarget);
  });

  it("throws NoTargetFound once every strategy in the ladder matches zero elements", async () => {
    await page.setContent(`<div>nothing here</div>`);
    const target: Target = {
      frame: "top",
      strategies: [{ kind: "attribute", selector: "button.missing", confidence: "high" }],
    };

    await expect(resolveTarget(page, target, "s1")).rejects.toBeInstanceOf(NoTargetFound);
  });

  it("falls through a zero-match strategy and records which index resolved", async () => {
    await page.setContent(`<button id="only">Go</button>`);
    const target: Target = {
      frame: "top",
      strategies: [
        { kind: "attribute", selector: "button.missing", confidence: "high" },
        { kind: "attribute", selector: "#only", confidence: "medium" },
      ],
    };

    const resolved = await resolveTarget(page, target, "s1");
    expect(resolved.kind).toBe("locator");
    expect(resolved.strategyIndex).toBe(1);
  });
});
