import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateCandidates, verifyCandidates, frameSelectorFor } from "../../src/compiler/strategies.js";
import type { RefDescriptor } from "../../src/schema/discovery.js";

describe("strategy candidate generation + live verification", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("generates semantic-first, ranked candidates from a ref descriptor", () => {
    const descriptor: RefDescriptor = {
      ref: "e1",
      role: "button",
      name: "Search",
      playwrightRef: "f1e1",
      hasLabel: false,
      attributes: { id: "btn-search-42" },
    };

    const candidates = generateCandidates(descriptor);

    expect(candidates.map((c) => c.kind)).toEqual(["role_name", "attribute"]);
  });

  it("rejects a generated-looking id as an attribute candidate", () => {
    const descriptor: RefDescriptor = {
      ref: "e1",
      role: "generic",
      playwrightRef: "f1e1",
      attributes: { id: "ember482" },
    };

    const candidates = generateCandidates(descriptor);
    expect(candidates.some((c) => c.kind === "attribute")).toBe(false);
  });

  it("verifies a candidate that resolves to exactly one element", async () => {
    await page.setContent(`<button id="unique-btn">Search</button>`);
    const candidates = generateCandidates({ ref: "e1", role: "button", name: "Search", playwrightRef: "f1e1", attributes: { id: "unique-btn" } });

    const verified = await verifyCandidates(page, candidates);

    expect(verified.every((c) => c.verified)).toBe(true);
  });

  it("discards a candidate that resolves to more than one element, rather than picking one", async () => {
    await page.setContent(`
      <button class="btn">Continue</button>
      <button class="btn">Continue</button>
    `);
    const candidates = generateCandidates({ ref: "e1", role: "button", name: "Continue", playwrightRef: "f1e1" });

    const verified = await verifyCandidates(page, candidates);

    expect(verified).toHaveLength(1);
    expect(verified[0]?.verified).toBe(false);
    expect(verified[0]?.reason).toMatch(/2 elements/);
  });

  it("discards a candidate that resolves to zero elements", async () => {
    await page.setContent(`<div>nothing matches</div>`);
    const candidates = generateCandidates({ ref: "e1", role: "button", name: "Nonexistent", playwrightRef: "f1e1" });

    const verified = await verifyCandidates(page, candidates);

    expect(verified[0]?.verified).toBe(false);
    expect(verified[0]?.reason).toMatch(/0 elements/);
  });

  it("derives a frame selector generically from the frame's own URL, and \"top\" for the main frame", () => {
    expect(frameSelectorFor(undefined)).toBe("top");
    expect(frameSelectorFor({ name: "", url: "http://x/member/10001/panel", index: 0 })).toBe("top");
    expect(frameSelectorFor({ name: "", url: "http://x/member/10001/panel", index: 1 })).toBe('iframe[src*="panel"]');
  });
});
