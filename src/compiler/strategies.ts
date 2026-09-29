/**
 * Transformation 3 — derive locator strategies. The highest-value part of
 * the compiler: turning one run's per-turn refs (only ever valid for the
 * turn they were captured in) into durable, ranked, VERIFIED locators.
 *
 * Candidate generation is pure and synchronous (this module); verification
 * requires a live page and is async (also here, via the engine's own
 * `buildLocator` — never a second, parallel notion of "does this resolve").
 * Driving the app between steps to reach each step's page state lives in
 * ./driver.ts, which calls both halves of this module in turn.
 */
import type { FrameDescriptor, RefDescriptor } from "../schema/discovery.js";
import type { Strategy } from "../schema/capability.js";
import { buildLocator, type LocatorScope } from "../engine/locate.js";

// Patterns for framework/toolkit-generated ids and names that will not
// survive a rebuild of the same page (a fresh session, a re-render) even
// though they resolve fine right now — "stable" here means "worth trusting
// across replay runs", not just "currently unique".
const GENERATED_ID_PATTERNS: RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^(ember|react|css|ext|radix|mui|ui|yui|vue)[-_]?\d+$/i, // common generated-id prefixes
  /^[0-9a-f]{16,}$/i, // long hex blob
];

function looksStable(value: string): boolean {
  if (value.length === 0 || value.length > 40) {
    return false;
  }
  return !GENERATED_ID_PATTERNS.some((pattern) => pattern.test(value));
}

function cssEscapeIdent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function attributeCandidate(descriptor: RefDescriptor): Strategy | undefined {
  const attrs = descriptor.attributes;
  if (!attrs) {
    return undefined;
  }
  if (attrs.id && looksStable(attrs.id)) {
    return { kind: "attribute", selector: `#${cssEscapeIdent(attrs.id)}`, confidence: "medium" };
  }
  if (attrs.name && looksStable(attrs.name)) {
    const tag = descriptor.tag ?? "";
    return { kind: "attribute", selector: `${tag}[name="${attrs.name}"]`, confidence: "medium" };
  }
  return undefined;
}

function textAnchoredCandidate(descriptor: RefDescriptor): Strategy | undefined {
  const nearby = descriptor.nearbyText;
  if (!nearby) {
    return undefined;
  }
  // rowFirstCell is the strongest of the three: it identifies a whole table
  // row by its label, which is exactly the "cell with no id, findable only
  // by position" case this strategy exists for.
  if (nearby.rowFirstCell) {
    return { kind: "text_anchored", anchor: nearby.rowFirstCell, relation: "right_of", confidence: "medium" };
  }
  if (nearby.precedingSibling) {
    return { kind: "text_anchored", anchor: nearby.precedingSibling, relation: "right_of", confidence: "low" };
  }
  if (nearby.followingSibling) {
    return { kind: "text_anchored", anchor: nearby.followingSibling, relation: "left_of", confidence: "low" };
  }
  return undefined;
}

/**
 * Rank order is semantic-first BY CONSTRUCTION — the order pushed here, not
 * a later sort. role_name/label survive tenant rebranding (a relabeled
 * button keeps its accessible role; see README's tenant-variant notes),
 * which is what makes cross-tenant reuse possible at all. attribute
 * survives a layout change but not a regenerated id. text_anchored survives
 * neither, but is the only option when an element has no name and no
 * stable attribute — the Savings-balance cell in this app's own example
 * artifact is exactly that case.
 */
export function generateCandidates(descriptor: RefDescriptor): Strategy[] {
  const out: Strategy[] = [];
  if (descriptor.role && descriptor.name) {
    out.push({ kind: "role_name", role: descriptor.role, name: descriptor.name, confidence: "high" });
  }
  if (descriptor.hasLabel && descriptor.labelText) {
    out.push({ kind: "label", text: descriptor.labelText, confidence: "high" });
  }
  const attribute = attributeCandidate(descriptor);
  if (attribute) {
    out.push(attribute);
  }
  const anchored = textAnchoredCandidate(descriptor);
  if (anchored) {
    out.push(anchored);
  }
  return out;
}

export interface VerifiedCandidate {
  strategy: Strategy;
  verified: boolean;
  /** Set when discarded — e.g. "resolved to 0 elements" or "resolved to 3 elements (ambiguous)". */
  reason?: string;
}

/**
 * Verifies each candidate against the CURRENT live page state, in the
 * caller-supplied order (see generateCandidates' rank-order comment).
 * Exactly 1 match keeps it; 0 or >1 discards it — an ambiguous match is
 * never narrowed by picking one, since per the engine's own resolution
 * rules (../engine/locate.ts) that is a hard replay failure waiting to
 * happen, not a usable strategy.
 */
export async function verifyCandidates(scope: LocatorScope, candidates: Strategy[]): Promise<VerifiedCandidate[]> {
  const out: VerifiedCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "coordinates") {
      // The compiler never generates a coordinates candidate (see
      // generateCandidates) — a caller passing one in explicitly is
      // treated as unverifiable rather than silently accepted.
      out.push({ strategy: candidate, verified: false, reason: "coordinates strategies are not derived or verified by the compiler" });
      continue;
    }
    const locator = buildLocator(scope, candidate);
    const count = await locator.count();
    if (count === 1) {
      out.push({ strategy: candidate, verified: true });
    } else {
      out.push({ strategy: candidate, verified: false, reason: count === 0 ? "resolved to 0 elements" : `resolved to ${count} elements (ambiguous)` });
    }
  }
  return out;
}

/**
 * Derives a `page.frameLocator()` selector from a captured frame identity —
 * "top" for the main frame (index 0, always true per Playwright's own
 * page.frames() ordering), otherwise a `src`-substring match built from the
 * frame's own URL. Generic across apps: it knows nothing about what any
 * particular iframe is FOR, only that its src contains a distinctive path
 * segment — true of this app's `/member/<id>/panel` iframe, and of iframes
 * generally.
 */
export function frameSelectorFor(frame: FrameDescriptor | undefined): string {
  if (!frame || frame.index === 0) {
    return "top";
  }
  let segment: string;
  try {
    const path = new URL(frame.url).pathname;
    segment = path.split("/").filter(Boolean).pop() ?? path;
  } catch {
    segment = frame.url;
  }
  return `iframe[src*="${segment}"]`;
}
