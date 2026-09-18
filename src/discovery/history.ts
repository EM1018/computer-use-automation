/**
 * A compact running history the model sees each turn: "action taken -> what
 * changed", never a full observation. Full observations are written to the
 * transcript for evidence (see TranscriptWriter usage in ./loop.ts); only
 * these one-line summaries go back into the prompt.
 *
 * Judgment call beyond the literal prompt: a naive "append one short line
 * per turn forever" still grows *linearly* in the number of turns, just
 * with a small constant — which is a different claim than "does not grow
 * linearly". To make that literally true (not just cheaper-than-the-naive-
 * alternative), this keeps a bounded WINDOW of the most recent entries and
 * collapses everything older into a single running counter line. Past the
 * window size, prompt-facing history size is flat, not linear.
 */
import type { DiscoveryAction } from "../schema/discovery.js";

export interface HistoryEntry {
  turn: number;
  summary: string;
}

const DEFAULT_WINDOW = 15;

export class DiscoveryHistory {
  private readonly window: HistoryEntry[] = [];
  private readonly maxWindow: number;
  private omittedCount = 0;

  constructor(maxWindow: number = DEFAULT_WINDOW) {
    this.maxWindow = maxWindow;
  }

  push(entry: HistoryEntry): void {
    this.window.push(entry);
    if (this.window.length > this.maxWindow) {
      this.window.shift();
      this.omittedCount += 1;
    }
  }

  /** What goes into the model prompt: bounded, never the full run. */
  render(): string {
    const lines: string[] = [];
    if (this.omittedCount > 0) {
      lines.push(`(${this.omittedCount} earlier turn${this.omittedCount === 1 ? "" : "s"} omitted)`);
    }
    for (const entry of this.window) {
      lines.push(`turn ${entry.turn}: ${entry.summary}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(no actions taken yet)";
  }
}

function describeAction(action: DiscoveryAction): string {
  switch (action.action) {
    case "click":
      return `clicked ${action.ref}`;
    case "fill":
      return `filled ${action.ref}`;
    case "select":
      return `selected an option on ${action.ref}`;
    case "navigate":
      return `navigated to ${action.url}`;
    case "extract":
      return `extracted ${action.ref} as output "${action.output_name}"`;
    case "done":
      return "called done()";
    case "stuck":
      return "called stuck()";
  }
}

/**
 * One line: what was attempted, and what happened. Never includes a filled
 * value (same "which field, not what" discipline as the escalation
 * protocol's human-action logging) and never includes a full observation.
 */
export function summarizeTurn(params: {
  action: DiscoveryAction;
  outcome: "ok" | "blocked" | "invalid_ref" | "error";
  detail?: string;
  pageChanged: boolean;
}): string {
  const base = describeAction(params.action);
  const changeNote = params.outcome === "ok" ? (params.pageChanged ? "page changed" : "no visible change") : undefined;
  const parts = [base, params.outcome !== "ok" ? params.outcome : undefined, changeNote, params.detail]
    .filter((part): part is string => Boolean(part));
  return parts.join(" -> ");
}
