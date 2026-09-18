/**
 * Builds one turn's observation from the live page: current URL, a TRIMMED
 * accessibility snapshot (interactive and informative nodes only, long
 * tables collapsed), and a screenshot as a second channel for whatever
 * doesn't show up in the accessibility tree (a disabled control, a modal
 * overlay, which of two similar forms is active).
 *
 * Ref-based targeting is the load-bearing piece here: every kept node gets
 * a fresh, small ref ("e1", "e2", ...) for this turn only, backed by
 * Playwright's own aria-ref locator (via ariaSnapshotJSON's mode: "ai",
 * which assigns its own refs like "f2e14" — frame-qualified, and already
 * resolvable via `page.locator('aria-ref=f2e14')` even across iframes with
 * no manual frame-scoping needed). The model only ever sees "e1".."eN"; it
 * cannot emit a selector or coordinates because there is no field for one.
 * Deriving a durable locator strategy from the chosen element is the
 * compiler's job (not built here) — this only needs to resolve the CURRENT
 * live element for the CURRENT turn.
 */

import type { Locator, Page } from "playwright";
import type { RefDescriptor } from "../schema/discovery.js";

// Roles a human (or model) can act on directly.
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "tab",
  "switch",
  "slider",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
]);

// Structural containers worth a zero-ref scaffold line for context (row/column relationships), but never a target themselves.
const SCAFFOLD_ROLES = new Set(["table", "row", "rowgroup", "list", "iframe"]);

const ROW_COLLAPSE_THRESHOLD = 6;
const MAX_ROWS_SHOWN = 4;

/** The subset of ariaSnapshotJSON's per-node shape this module reads. Playwright types this as an opaque Serializable, so field access here is defensive, not trusting the shape blindly. */
interface AriaNode {
  role?: unknown;
  name?: unknown;
  text?: unknown;
  children?: unknown;
  ref?: unknown;
  url?: unknown;
  placeholder?: unknown;
  checked?: unknown;
  disabled?: unknown;
  expanded?: unknown;
  pressed?: unknown;
  selected?: unknown;
  level?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function childrenOf(node: AriaNode): AriaNode[] {
  return Array.isArray(node.children) ? (node.children as AriaNode[]) : [];
}

function label(node: AriaNode): string | undefined {
  return asString(node.name) ?? asString(node.text);
}

function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

interface WalkState {
  nextRefIndex: number;
  lines: string[];
  refs: RefDescriptor[];
  refToPlaywrightRef: Map<string, string>;
}

/** True if this node or any descendant would get a ref — gates whether a structural scaffold line is worth printing at all. */
function hasKeepableDescendant(node: AriaNode): boolean {
  const role = asString(node.role) ?? "";
  if (isInteractive(role) || label(node) !== undefined) {
    return true;
  }
  return childrenOf(node).some(hasKeepableDescendant);
}

/** Collapses a rowgroup/table/list's row-like children to a representative few when there are many, keeping any header-ish rows and noting how many were omitted. */
function collapseRows(node: AriaNode): { children: AriaNode[]; omittedNote: string | undefined } {
  const role = asString(node.role) ?? "";
  const children = childrenOf(node);
  if (role !== "rowgroup" && role !== "table" && role !== "list") {
    return { children, omittedNote: undefined };
  }

  const rowRole = role === "list" ? "listitem" : "row";
  const rowChildren = children.filter((c) => asString(c.role) === rowRole);
  if (rowChildren.length <= ROW_COLLAPSE_THRESHOLD) {
    return { children, omittedNote: undefined };
  }

  const isHeaderRow = (row: AriaNode): boolean => {
    const cells = childrenOf(row);
    return cells.length > 0 && cells.every((cell) => asString(cell.role) === "columnheader" || asString(cell.role) === "rowheader");
  };
  const headerRows = rowChildren.filter(isHeaderRow);
  const dataRows = rowChildren.filter((r) => !isHeaderRow(r));
  const shownData = dataRows.slice(0, MAX_ROWS_SHOWN);
  const omitted = dataRows.length - shownData.length;
  const nonRowChildren = children.filter((c) => asString(c.role) !== rowRole);

  return {
    children: [...nonRowChildren, ...headerRows, ...shownData],
    omittedNote: omitted > 0 ? `(${omitted} more ${rowRole === "listitem" ? "items" : "rows"} omitted)` : undefined,
  };
}

function renderAttributes(node: AriaNode): string {
  const parts: string[] = [];
  if (node.disabled === true) parts.push("disabled");
  if (node.checked === true) parts.push("checked");
  if (node.checked === "mixed") parts.push("checked=mixed");
  if (node.selected === true) parts.push("selected");
  if (node.pressed === true) parts.push("pressed");
  if (node.expanded === true) parts.push("expanded");
  const url = asString(node.url);
  if (url) parts.push(`url=${url}`);
  const placeholder = asString(node.placeholder);
  if (placeholder) parts.push(`placeholder="${placeholder}"`);
  const level = typeof node.level === "number" ? node.level : undefined;
  if (level !== undefined) parts.push(`level=${level}`);
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

function walk(node: AriaNode, depth: number, state: WalkState): void {
  const role = asString(node.role) ?? "generic";
  const text = label(node);
  const keep = isInteractive(role) || text !== undefined;
  const indent = "  ".repeat(depth);

  const { children, omittedNote } = collapseRows(node);
  const willRecurse = children.length > 0 || omittedNote !== undefined;
  // A trailing ":" (matching Playwright's own aria-snapshot convention)
  // signals "there is more nested content below this line" — needed
  // because a node's computed accessible name is sometimes a browser-side
  // concatenation of descendant text (e.g. a table cell wrapping a whole
  // sub-form), which would otherwise read as this line's complete content
  // when it is not.
  const suffix = willRecurse ? ":" : "";

  if (keep) {
    const ref = `e${state.nextRefIndex}`;
    state.nextRefIndex += 1;
    const playwrightRef = asString(node.ref) ?? "";
    const descriptor: RefDescriptor = { ref, role, playwrightRef };
    if (text !== undefined) {
      descriptor.name = text;
    }
    state.refs.push(descriptor);
    state.refToPlaywrightRef.set(ref, playwrightRef);

    const namePart = text !== undefined ? ` "${text}"` : "";
    state.lines.push(`${indent}- ${role}${namePart} [ref=${ref}]${renderAttributes(node)}${suffix}`);
  } else if (SCAFFOLD_ROLES.has(role) && hasKeepableDescendant(node)) {
    state.lines.push(`${indent}- ${role}${suffix}`);
  }

  const childDepth = keep || SCAFFOLD_ROLES.has(role) ? depth + 1 : depth;
  for (const child of children) {
    walk(child, childDepth, state);
  }
  if (omittedNote) {
    state.lines.push(`${"  ".repeat(childDepth)}- ${omittedNote}`);
  }
}

export interface Observation {
  url: string;
  /** Trimmed, ref-annotated tree — what actually goes into the model's prompt. */
  snapshotText: string;
  /** Serializable per-ref metadata — what refs.jsonl records. */
  refs: RefDescriptor[];
  screenshot: Buffer;
}

export interface ObserveResult {
  observation: Observation;
  /** Live Locators, keyed by OUR ref (e1, e2, ...) — never serialized, never sent to the model. */
  refMap: Map<string, Locator>;
}

export async function observe(page: Page): Promise<ObserveResult> {
  const rawJson: unknown = await page.ariaSnapshotJSON({ mode: "ai" });
  const roots = Array.isArray(rawJson) ? (rawJson as AriaNode[]) : [];

  const state: WalkState = { nextRefIndex: 1, lines: [], refs: [], refToPlaywrightRef: new Map() };
  for (const root of roots) {
    walk(root, 0, state);
  }

  const refMap = new Map<string, Locator>();
  for (const [ref, playwrightRef] of state.refToPlaywrightRef) {
    if (playwrightRef) {
      refMap.set(ref, page.locator(`aria-ref=${playwrightRef}`));
    }
  }

  const screenshot = await page.screenshot({ type: "png" });

  return {
    observation: {
      url: page.url(),
      snapshotText: state.lines.length > 0 ? state.lines.join("\n") : "(empty page)",
      refs: state.refs,
      screenshot,
    },
    refMap,
  };
}

/**
 * A cheap, ref-free content signature used to detect "did the page actually
 * change" (see src/discovery/loop.ts's no_progress tracking). Separate from
 * the ref-ful "ai" mode snapshot used for the model-facing observation,
 * since Playwright's own internal ref numbering is not guaranteed to be
 * byte-stable across calls the way plain content is, and this only needs to
 * answer "same or different", not be human-readable.
 */
export async function pageSignature(page: Page): Promise<string> {
  const snapshot = await page.ariaSnapshot({ mode: "default" }).catch(() => "");
  return `${page.url()}\n${snapshot}`;
}
