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
 *
 * Each ref also carries an ENRICHED descriptor (tag, attributes, label
 * association, frame identity, nearby text, bounding box) beyond what the
 * model sees in the prompt — that's for the compiler (not built here),
 * which derives durable locator strategies (role_name, label, attribute,
 * text_anchored, coordinates) from this data after the run.
 */

import type { Locator, Page } from "playwright";
import type { BoundingBox, FrameDescriptor, NearbyText, RefAttributes, RefDescriptor, ViewportSize } from "../schema/discovery.js";

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
  box?: unknown;
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

function asBoundingBox(value: unknown): BoundingBox | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["x"] === "number" && typeof v["y"] === "number" && typeof v["width"] === "number" && typeof v["height"] === "number") {
    return { x: v["x"], y: v["y"], width: v["width"], height: v["height"] };
  }
  return undefined;
}

function isHeaderRow(row: AriaNode): boolean {
  const cells = childrenOf(row);
  return cells.length > 0 && cells.every((cell) => asString(cell.role) === "columnheader" || asString(cell.role) === "rowheader");
}

interface WalkState {
  nextRefIndex: number;
  lines: string[];
  refs: RefDescriptor[];
  refToPlaywrightRef: Map<string, string>;
}

/** Table/row positioning context threaded down through the walk, for nearbyText — established at the rowgroup/table level (columnHeaders) and the row level (rowFirstCell, this cell's index). */
interface TableContext {
  columnHeaders: string[];
}
interface RowContext {
  rowFirstCellText: string | undefined;
  cellIndex: number;
}
interface WalkPosition {
  siblings: AriaNode[];
  index: number;
  table?: TableContext | undefined;
  row?: RowContext | undefined;
}

function buildNearbyText(pos: WalkPosition): NearbyText | undefined {
  const result: NearbyText = {};
  if (pos.row) {
    const columnHeader = pos.table?.columnHeaders[pos.row.cellIndex];
    if (columnHeader) {
      result.columnHeader = columnHeader;
    }
    if (pos.row.rowFirstCellText) {
      result.rowFirstCell = pos.row.rowFirstCellText;
    }
  }
  const prevSibling = pos.index > 0 ? pos.siblings[pos.index - 1] : undefined;
  const nextSibling = pos.index < pos.siblings.length - 1 ? pos.siblings[pos.index + 1] : undefined;
  const prevText = prevSibling ? label(prevSibling) : undefined;
  const nextText = nextSibling ? label(nextSibling) : undefined;
  if (prevText) {
    result.precedingSibling = prevText;
  }
  if (nextText) {
    result.followingSibling = nextText;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

function walk(node: AriaNode, depth: number, state: WalkState, pos: WalkPosition): void {
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
    const nearbyText = buildNearbyText(pos);
    if (nearbyText) {
      descriptor.nearbyText = nearbyText;
    }
    const box = asBoundingBox(node.box);
    if (box) {
      descriptor.boundingBox = box;
    }
    state.refs.push(descriptor);
    state.refToPlaywrightRef.set(ref, playwrightRef);

    const namePart = text !== undefined ? ` "${text}"` : "";
    state.lines.push(`${indent}- ${role}${namePart} [ref=${ref}]${renderAttributes(node)}${suffix}`);
  } else if (SCAFFOLD_ROLES.has(role) && hasKeepableDescendant(node)) {
    state.lines.push(`${indent}- ${role}${suffix}`);
  }

  // A rowgroup/table establishes column headers for its descendant rows'
  // cells; every other role just passes the enclosing table context
  // through unchanged (so it survives table -> rowgroup -> row -> cell).
  let childTable = pos.table;
  if (role === "rowgroup" || role === "table") {
    const headerRow = children.find((c) => asString(c.role) === "row" && isHeaderRow(c));
    if (headerRow) {
      childTable = { columnHeaders: childrenOf(headerRow).map((cell) => label(cell) ?? "") };
    }
  }

  const childDepth = keep || SCAFFOLD_ROLES.has(role) ? depth + 1 : depth;
  children.forEach((child, index) => {
    let childRow = pos.row;
    if (role === "row") {
      childRow = { rowFirstCellText: label(children[0] as AriaNode), cellIndex: index };
    }
    walk(child, childDepth, state, { siblings: children, index, table: childTable, row: childRow });
  });
  if (omittedNote) {
    state.lines.push(`${"  ".repeat(childDepth)}- ${omittedNote}`);
  }
}

/** Tag, HTML attributes, and real <label> association — read directly from the DOM since none of it is in the accessibility tree. */
async function readDomInfo(locator: Locator): Promise<{ tag: string; attributes: RefAttributes; hasLabel: boolean; labelText: string | undefined }> {
  return locator.evaluate((el) => {
    const attributeNames = ["name", "id", "class", "type", "placeholder"] as const;
    const attributes: Record<string, string> = {};
    for (const attr of attributeNames) {
      const value = el.getAttribute(attr);
      if (value) {
        attributes[attr] = value;
      }
    }
    const id = el.getAttribute("id");
    let labelEl: HTMLLabelElement | null = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    labelEl ??= el.closest("label");
    return {
      tag: el.tagName.toLowerCase(),
      attributes,
      hasLabel: labelEl !== null,
      labelText: labelEl?.textContent?.trim() || undefined,
    };
  });
}

/** The real Frame object that owns this element, via ElementHandle.ownerFrame() — never inferred from playwrightRef's internal "f2e28" numbering. */
async function readOwnerFrame(locator: Locator, page: Page): Promise<FrameDescriptor | undefined> {
  const handle = await locator.elementHandle();
  if (!handle) {
    return undefined;
  }
  try {
    const frame = await handle.ownerFrame();
    if (!frame) {
      return undefined;
    }
    return { name: frame.name(), url: frame.url(), index: page.frames().indexOf(frame) };
  } finally {
    await handle.dispose().catch(() => undefined);
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
  const rawJson: unknown = await page.ariaSnapshotJSON({ mode: "ai", boxes: true });
  const roots = Array.isArray(rawJson) ? (rawJson as AriaNode[]) : [];

  const state: WalkState = { nextRefIndex: 1, lines: [], refs: [], refToPlaywrightRef: new Map() };
  roots.forEach((root, index) => {
    walk(root, 0, state, { siblings: roots, index });
  });

  const refMap = new Map<string, Locator>();
  for (const [ref, playwrightRef] of state.refToPlaywrightRef) {
    if (playwrightRef) {
      refMap.set(ref, page.locator(`aria-ref=${playwrightRef}`));
    }
  }

  const viewport: ViewportSize | undefined = page.viewportSize() ?? undefined;

  // Enrichment is a best-effort second pass, in parallel across refs: a
  // single stale/vanished element must not take down the whole turn's
  // observation, so each lookup is caught independently.
  await Promise.all(
    state.refs.map(async (descriptor) => {
      const locator = refMap.get(descriptor.ref);
      if (!locator) {
        return;
      }
      const [domInfo, frame] = await Promise.all([
        readDomInfo(locator).catch(() => undefined),
        readOwnerFrame(locator, page).catch(() => undefined),
      ]);
      if (domInfo) {
        descriptor.tag = domInfo.tag;
        if (Object.keys(domInfo.attributes).length > 0) {
          descriptor.attributes = domInfo.attributes;
        }
        descriptor.hasLabel = domInfo.hasLabel;
        if (domInfo.labelText) {
          descriptor.labelText = domInfo.labelText;
        }
      }
      if (frame) {
        descriptor.frame = frame;
      }
      if (viewport) {
        descriptor.viewport = viewport;
      }
    }),
  );

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
