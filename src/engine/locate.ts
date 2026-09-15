import type { FrameLocator, Locator, Page } from "playwright";
import type { Strategy, SpatialRelation, Target } from "../schema/capability.js";
import { AmbiguousTarget, NoTargetFound } from "./errors.js";

/** Anything a locator can be built against: the top-level page, or a scoped iframe. */
export type LocatorScope = Page | FrameLocator;

export type AriaRole = Parameters<Page["getByRole"]>[0];

export type ResolvedTarget =
  | { kind: "locator"; locator: Locator; strategyIndex: number; strategyKind: Strategy["kind"] }
  | { kind: "coordinates"; x: number; y: number; strategyIndex: number; strategyKind: "coordinates" };

/** Resolves `target.frame` ("top", or a CSS selector identifying an iframe) to a locator scope. */
export function resolveFrameScope(page: Page, frame: string): LocatorScope {
  return frame === "top" ? page : page.frameLocator(frame);
}

/**
 * Walks a target's strategy ladder in order. The first strategy that
 * resolves to exactly one element wins, and which index won is reported
 * back to the caller (a step starting to resolve on a worse rung than
 * recorded is a drift signal, not silently absorbed). More than one match
 * is never narrowed by picking one — it is a hard stop. Zero matches falls
 * through to the next strategy; exhausting the ladder is also a hard stop,
 * but a different one, since it can legitimately mean "the page is in a
 * different, declared state" rather than "this locator is broken".
 */
export async function resolveTarget(scope: LocatorScope, target: Target, stepId: string): Promise<ResolvedTarget> {
  for (let index = 0; index < target.strategies.length; index += 1) {
    const strategy = target.strategies[index];
    if (!strategy) {
      continue;
    }

    if (strategy.kind === "coordinates") {
      // Verified only positionally at record time; no element count applies.
      // Schema validation guarantees this is the final entry in the ladder.
      return { kind: "coordinates", x: strategy.x, y: strategy.y, strategyIndex: index, strategyKind: "coordinates" };
    }

    const locator = buildLocator(scope, strategy);
    const count = await locator.count();
    if (count === 1) {
      return { kind: "locator", locator, strategyIndex: index, strategyKind: strategy.kind };
    }
    if (count > 1) {
      throw new AmbiguousTarget(stepId, index, count);
    }
  }
  throw new NoTargetFound(stepId);
}

function buildLocator(scope: LocatorScope, strategy: Exclude<Strategy, { kind: "coordinates" }>): Locator {
  switch (strategy.kind) {
    case "role_name":
      return scope.getByRole(strategy.role as AriaRole, { name: strategy.name, exact: true });
    case "label":
      return scope.getByLabel(strategy.text, { exact: true });
    case "attribute":
      return scope.locator(strategy.selector);
    case "text_anchored":
      return scope.locator(`xpath=${relationXPath(strategy.anchor, strategy.relation)}`);
  }
}

/**
 * Translates a (anchor text, spatial relation) pair into an XPath expression
 * over the anchor's nearest row-like ancestor. This is a generic structural
 * heuristic — it knows about rows and cells, nothing about what any
 * particular app's rows and cells mean.
 */
function relationXPath(anchor: string, relation: SpatialRelation): string {
  const literal = xpathStringLiteral(anchor);
  const anchorExpr = `//*[normalize-space(text())=${literal}]`;
  const cellExpr = "descendant::*[self::td or self::th]";

  switch (relation) {
    case "right_of":
      return `${anchorExpr}/ancestor::tr[1]/${cellExpr}[last()]`;
    case "left_of":
      return `${anchorExpr}/ancestor::tr[1]/${cellExpr}[1]`;
    case "above":
      return `${anchorExpr}/ancestor::tr[1]/preceding-sibling::tr[1]`;
    case "below":
      return `${anchorExpr}/ancestor::tr[1]/following-sibling::tr[1]`;
    case "inside":
      return anchorExpr;
    case "near":
      return `${anchorExpr}/ancestor::tr[1]/${cellExpr}[not(normalize-space(text())=${literal})][1]`;
  }
}

function xpathStringLiteral(text: string): string {
  if (!text.includes('"')) {
    return `"${text}"`;
  }
  if (!text.includes("'")) {
    return `'${text}'`;
  }
  const parts = text.split('"').map((part) => `"${part}"`);
  return `concat(${parts.join(", '\"', ")})`;
}
