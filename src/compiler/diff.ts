/**
 * Renders evidence/<run_id>/compile_diff.md — the human-readable proof that
 * the compiled artifact is decoupled from the raw transcript: which actions
 * got cut and why, which literals became {{placeholders}}, which candidate
 * locator strategies survived verification (and which didn't, and why), and
 * what output types got inferred.
 */
import type { Checkpoint, Strategy, Output } from "../schema/capability.js";
import type { PruneResult } from "./prune.js";
import type { ParameterizeResult } from "./parameterize.js";
import type { StepDerivation } from "./driver.js";
import type { SynthesizedCheckpointReport } from "./checkpoints.js";

export interface DiffInput {
  runId: string;
  goal: string;
  prune: PruneResult;
  parameterize: ParameterizeResult;
  derivations: StepDerivation[];
  outputs: Output[];
  notes: string[];
  probeNotes: string[];
  synthesizedCheckpoints: SynthesizedCheckpointReport[];
}

function describeCheckpoint(checkpoint: Checkpoint): string {
  switch (checkpoint.kind) {
    case "text_present":
      return `text_present("${checkpoint.pattern}"${checkpoint.within ? ` within ${checkpoint.within}` : ""})`;
    case "element_present":
      return `element_present(role=${checkpoint.role ?? "*"}, name="${checkpoint.name ?? checkpoint.name_pattern ?? "*"}")`;
    case "url_matches":
      return `url_matches(${checkpoint.pattern})`;
  }
}

function describeStrategy(strategy: Strategy): string {
  switch (strategy.kind) {
    case "role_name":
      return `role_name(role=${strategy.role}, name="${strategy.name}")`;
    case "label":
      return `label("${strategy.text}")`;
    case "attribute":
      return `attribute(${strategy.selector})`;
    case "text_anchored":
      return `text_anchored(anchor="${strategy.anchor}", relation=${strategy.relation})`;
    case "coordinates":
      return `coordinates(${strategy.x}, ${strategy.y})`;
  }
}

export function renderCompileDiff(input: DiffInput): string {
  const lines: string[] = [];
  lines.push(`# Compile diff — run ${input.runId}`, "", `Goal: ${input.goal}`, "");

  lines.push("## Actions pruned", "");
  if (input.prune.prunedRanges.length === 0) {
    lines.push("(none — every recorded action contributed to reaching the goal)");
  } else {
    for (const range of input.prune.prunedRanges) {
      lines.push(`- turn(s) ${range.turns.join(", ")}: ${range.reason}`);
    }
  }
  lines.push("");

  lines.push("## Values parameterized", "");
  if (input.parameterize.parameterizations.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of input.parameterize.parameterizations) {
      lines.push(`- turn ${p.turn} (${p.kind}): recorded literal value -> \`{{${p.inputName}}}\``);
    }
  }
  if (input.parameterize.literalValuesUsed.length > 0) {
    lines.push("", `${input.parameterize.literalValuesUsed.length} value(s) did not match any supplied input and were kept as literal step values (e.g. a fixed dropdown choice).`);
  }
  lines.push("");

  lines.push("## Locator strategies per step", "");
  for (const d of input.derivations) {
    lines.push(`### ${d.stepId} (${d.action}, turn ${d.turn})`);
    lines.push(`- candidates generated: ${d.candidatesGenerated.map(describeStrategy).join("; ") || "(none)"}`);
    lines.push(`- verified: ${d.candidatesVerified.map(describeStrategy).join("; ") || "(none)"}`);
    if (d.candidatesDiscarded.length > 0) {
      lines.push(`- discarded: ${d.candidatesDiscarded.map((x) => `${describeStrategy(x.strategy)} — ${x.reason}`).join("; ")}`);
    }
    if (d.zeroVerified) {
      lines.push("- ⚠ ZERO strategies verified for this step — see compiler_notes on the artifact.");
    }
    lines.push("");
  }

  lines.push("## Synthesized checkpoints", "");
  if (input.synthesizedCheckpoints.length === 0) {
    lines.push("(none — no extract step or final navigation in this flow)");
  } else {
    for (const c of input.synthesizedCheckpoints) {
      const reasonText = c.reason === "before_extract" ? "before an extract step" : "after the flow's final navigation";
      lines.push(
        `- \`${c.stepId}\` (${reasonText}, ${c.candidatesConsidered} candidate(s) considered): ${c.checkpoint ? describeCheckpoint(c.checkpoint) : "⚠ NO checkpoint — see compiler_notes"}`,
      );
    }
  }
  lines.push("");

  lines.push("## Outputs derived", "");
  if (input.outputs.length === 0) {
    lines.push("(none)");
  } else {
    for (const o of input.outputs) {
      lines.push(`- \`${o.name}\`: type \`${o.type}\``);
    }
  }
  lines.push("");

  if (input.probeNotes.length > 0) {
    lines.push("## Probing notes", "", ...input.probeNotes.map((n) => `- ${n}`), "");
  }
  if (input.notes.length > 0) {
    lines.push("## Compiler notes", "", ...input.notes.map((n) => `- ${n}`), "");
  }

  return lines.join("\n");
}
