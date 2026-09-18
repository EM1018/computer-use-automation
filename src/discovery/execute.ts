/**
 * Executes one already-validated DiscoveryAction against the live page.
 * Validation (ref exists, policy allows it) happens in ./loop.ts BEFORE
 * this is called — this module only performs the action and reports what
 * happened; it never decides whether an action SHOULD run.
 */
import type { Locator, Page } from "playwright";
import type { DiscoveryAction, RefDescriptor } from "../schema/discovery.js";

export interface ExecuteOutcome {
  ok: boolean;
  errorMessage?: string;
  /** Populated only for a successful extract. */
  extractedValue?: string;
}

/** The ref a discovery action targets, if any — click/fill/select/extract all name one; navigate/done/stuck never do. */
export function targetRef(action: DiscoveryAction): string | undefined {
  return "ref" in action ? action.ref : undefined;
}

/** Looks up a ref's descriptor from this turn's observation — what the policy check matches against. */
export function findRefDescriptor(refs: RefDescriptor[], ref: string): RefDescriptor | undefined {
  return refs.find((candidate) => candidate.ref === ref);
}

export async function executeDiscoveryAction(
  page: Page,
  action: DiscoveryAction,
  refMap: Map<string, Locator>,
): Promise<ExecuteOutcome> {
  try {
    switch (action.action) {
      case "click": {
        await requireLocator(refMap, action.ref).click();
        return { ok: true };
      }
      case "fill": {
        await requireLocator(refMap, action.ref).fill(action.value);
        return { ok: true };
      }
      case "select": {
        await requireLocator(refMap, action.ref).selectOption(action.option);
        return { ok: true };
      }
      case "navigate": {
        const target = new URL(action.url, page.url()).toString();
        await page.goto(target, { waitUntil: "load" });
        return { ok: true };
      }
      case "extract": {
        const text = (await requireLocator(refMap, action.ref).innerText()).trim();
        return { ok: true, extractedValue: text };
      }
      case "done":
      case "stuck":
        // Control signals only — nothing to do to the page.
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

function requireLocator(refMap: Map<string, Locator>, ref: string): Locator {
  const locator = refMap.get(ref);
  if (!locator) {
    // Loop.ts validates refs before calling this; reaching here means that
    // discipline was bypassed somewhere, which is a bug in the caller, not
    // a recoverable runtime condition.
    throw new Error(`internal error: executeDiscoveryAction called with unresolved ref "${ref}"`);
  }
  return locator;
}
