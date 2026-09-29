import { describe, expect, it } from "vitest";
import { renderCompileDiff } from "../../src/compiler/diff.js";

describe("renderCompileDiff", () => {
  it("names the pruned actions by turn number and reason", () => {
    const markdown = renderCompileDiff({
      runId: "run1",
      goal: "Look something up",
      prune: {
        keptTurns: [3, 4, 5],
        prunedRanges: [{ turns: [0, 1, 2], reason: "returned to a page state already reached at turn 0 — dead end, no net progress" }],
      },
      parameterize: {
        actions: [],
        parameterizations: [{ turn: 3, inputName: "member_id", kind: "fill" }],
        literalValuesUsed: [],
      },
      derivations: [
        {
          stepId: "s1",
          turn: 4,
          action: "click",
          candidatesGenerated: [{ kind: "role_name", role: "button", name: "Search", confidence: "high" }],
          candidatesVerified: [{ kind: "role_name", role: "button", name: "Search", confidence: "high" }],
          candidatesDiscarded: [],
          zeroVerified: false,
        },
      ],
      outputs: [{ name: "balance", type: "number", description: "balance" }],
      notes: [],
      probeNotes: [],
      synthesizedCheckpoints: [
        { stepId: "s2", reason: "before_extract", checkpoint: { kind: "text_present", pattern: "Accounts", within: "b >> nth=2" }, candidatesConsidered: 3 },
      ],
    });

    expect(markdown).toContain("## Actions pruned");
    expect(markdown).toContain("turn(s) 0, 1, 2");
    expect(markdown).toContain("dead end");
    expect(markdown).toContain("{{member_id}}");
    expect(markdown).toContain("s1 (click, turn 4)");
    expect(markdown).toContain("`balance`");
    expect(markdown).toContain("## Synthesized checkpoints");
    expect(markdown).toContain("s2");
    expect(markdown).toContain("before an extract step");
    expect(markdown).toContain("text_present");
    expect(markdown).toContain("within b >> nth=2");
  });

  it("says so explicitly when nothing was pruned", () => {
    const markdown = renderCompileDiff({
      runId: "run2",
      goal: "goal",
      prune: { keptTurns: [0], prunedRanges: [] },
      parameterize: { actions: [], parameterizations: [], literalValuesUsed: [] },
      derivations: [],
      outputs: [],
      notes: [],
      probeNotes: [],
      synthesizedCheckpoints: [],
    });

    expect(markdown).toContain("none — every recorded action contributed");
  });

  it("flags a position where no checkpoint could be derived", () => {
    const markdown = renderCompileDiff({
      runId: "run3",
      goal: "goal",
      prune: { keptTurns: [0], prunedRanges: [] },
      parameterize: { actions: [], parameterizations: [], literalValuesUsed: [] },
      derivations: [],
      outputs: [],
      notes: [],
      probeNotes: [],
      synthesizedCheckpoints: [{ stepId: "s2", reason: "before_extract", candidatesConsidered: 2 }],
    });

    expect(markdown).toContain("NO checkpoint");
  });
});
