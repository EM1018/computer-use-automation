import { describe, expect, it } from "vitest";
import { pruneDeadEnds } from "../../src/compiler/prune.js";
import type { TranscriptTurnEntry } from "../../src/schema/discovery.js";

function turn(partial: Partial<TranscriptTurnEntry> & Pick<TranscriptTurnEntry, "turn" | "url" | "observation_summary" | "action">): TranscriptTurnEntry {
  return {
    model_reasoning: "",
    result: "ok",
    page_changed: true,
    ...partial,
  };
}

describe("pruneDeadEnds", () => {
  it("cuts a dead-end loop back to a previously-reached page state, keeping everything else", () => {
    const turns: TranscriptTurnEntry[] = [
      turn({ turn: 0, url: "/search", observation_summary: "search form (empty)", action: { action: "click", ref: "e1" } }),
      turn({ turn: 1, url: "/page2", observation_summary: "wrong page", action: { action: "click", ref: "e2" } }),
      turn({ turn: 2, url: "/page3", observation_summary: "another wrong page", action: { action: "navigate", url: "/search" } }),
      // Same (url, observation) as turn 0 — the model wandered off through
      // turns 1-2 and came back to exactly where it started.
      turn({ turn: 3, url: "/search", observation_summary: "search form (empty)", action: { action: "fill", ref: "e3", value: "10001" } }),
      turn({ turn: 4, url: "/search", observation_summary: "search form (filled)", action: { action: "click", ref: "e4" } }),
      turn({ turn: 5, url: "/results", observation_summary: "result page", action: { action: "extract", ref: "e5", output_name: "value" } }),
      turn({ turn: 6, url: "/results", observation_summary: "result page (after extract)", action: { action: "done", reason: "goal reached" }, page_changed: false }),
    ];

    const result = pruneDeadEnds(turns);

    expect(result.keptTurns).toEqual([3, 4, 5]);
    expect(result.prunedRanges).toHaveLength(1);
    expect(result.prunedRanges[0]?.turns).toEqual([0, 1, 2]);
    expect(result.prunedRanges[0]?.reason).toContain("turn 0");
  });

  it("drops actions that never succeeded, with the failure reason reported", () => {
    const turns: TranscriptTurnEntry[] = [
      turn({ turn: 0, url: "/search", observation_summary: "search form", action: { action: "click", ref: "e1" }, result: "error", detail: "element not found" }),
      turn({ turn: 1, url: "/search", observation_summary: "search form", action: { action: "click", ref: "e2" } }),
    ];

    const result = pruneDeadEnds(turns);

    expect(result.keptTurns).toEqual([1]);
    expect(result.prunedRanges).toHaveLength(1);
    expect(result.prunedRanges[0]?.turns).toEqual([0]);
    expect(result.prunedRanges[0]?.reason).toContain("element not found");
  });

  it("is conservative: a run with no repeated state and no failures prunes nothing", () => {
    const turns: TranscriptTurnEntry[] = [
      turn({ turn: 0, url: "/search", observation_summary: "A", action: { action: "fill", ref: "e1", value: "10001" } }),
      turn({ turn: 1, url: "/search", observation_summary: "B", action: { action: "click", ref: "e2" } }),
      turn({ turn: 2, url: "/results", observation_summary: "C", action: { action: "extract", ref: "e3", output_name: "value" } }),
    ];

    const result = pruneDeadEnds(turns);

    expect(result.keptTurns).toEqual([0, 1, 2]);
    expect(result.prunedRanges).toEqual([]);
  });
});
