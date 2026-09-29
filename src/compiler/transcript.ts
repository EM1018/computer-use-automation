/**
 * Reads one discovery run's evidence/<run_id>/ directory into typed,
 * in-memory structures. Pure I/O + parsing — no pruning, parameterization,
 * or locator logic lives here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionLogEntry, PolicyEventEntry, RefsLogEntry, TranscriptTurnEntry } from "../schema/discovery.js";
import { containsRedactionMarker, LEGACY_ANONYMOUS_REDACTED_MARKER } from "../engine/redactor.js";
import { CompileError } from "./types.js";

export interface LaunchInfo {
  goal: string;
  inputs: Record<string, string>;
}

export interface RawTranscript {
  runId: string;
  runDir: string;
  turns: TranscriptTurnEntry[];
  actions: ActionLogEntry[];
  refsByTurn: Map<number, RefsLogEntry>;
  policyEvents: PolicyEventEntry[];
  launch: LaunchInfo;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * `launchOverride` lets a caller that already has the goal/inputs in memory
 * (e.g. `discover --compile`, running right after `runDiscovery` in the same
 * process) skip reading launch.json entirely — the NORMAL path, and the
 * only one that ever sees real input values, since launch.json itself never
 * does (see EvidenceWriter.writeLaunchInfo, ../engine/evidence.ts: it is
 * scrubbed through the Redactor like every other evidence file, no
 * exceptions). The standalone `compile <run_id>` CLI therefore needs real
 * values supplied again via --goal/--input for any transcript produced
 * after that change — see readLaunch below for the one narrow compat case
 * where reading launch.json directly still works.
 */
export function loadTranscript(runId: string, evidenceRoot = "evidence", launchOverride?: LaunchInfo): RawTranscript {
  const runDir = join(evidenceRoot, runId);
  if (!existsSync(runDir)) {
    throw new CompileError(`no evidence directory found at ${runDir}`);
  }

  const turns = readJsonl<TranscriptTurnEntry>(join(runDir, "transcript.jsonl"));
  const actions = readJsonl<ActionLogEntry>(join(runDir, "actions.jsonl"));
  const refsEntries = readJsonl<RefsLogEntry>(join(runDir, "refs.jsonl"));
  const policyEvents = readJsonl<PolicyEventEntry>(join(runDir, "policy_events.jsonl"));
  const refsByTurn = new Map(refsEntries.map((entry) => [entry.turn, entry]));

  const launch = launchOverride ?? readLaunch(runDir, runId);

  return { runId, runDir, turns, actions, refsByTurn, policyEvents, launch };
}

/**
 * Reads launch.json as a LAST RESORT (no override supplied). Its `inputs`
 * values are redacted placeholders for any transcript from a current build
 * — of no use for parameterization, which needs the real values — so this
 * only succeeds when the file predates that change and genuinely still
 * holds raw values (an "older build" transcript, per the compiler README).
 * Anything that looks like a redaction placeholder, labeled or the old bare
 * anonymous form, is refused with a specific, actionable error rather than
 * silently handed to the compiler as if it were real.
 */
function readLaunch(runDir: string, runId: string): LaunchInfo {
  const launchPath = join(runDir, "launch.json");
  if (!existsSync(launchPath)) {
    throw new CompileError(
      `no launch.json found at ${launchPath} and no launch info was supplied to the compiler. ` +
        `Pass --goal/--input to the compile CLI (or run \`discover ... --compile\`, which never needs this file).`,
    );
  }

  const launch = JSON.parse(readFileSync(launchPath, "utf8")) as LaunchInfo;
  const redactedNames = Object.entries(launch.inputs)
    .filter(([, value]) => value === LEGACY_ANONYMOUS_REDACTED_MARKER || containsRedactionMarker(value))
    .map(([name]) => name);

  if (redactedNames.length > 0) {
    throw new CompileError(
      `evidence/${runId}/launch.json does not carry real values for input(s) [${redactedNames.join(", ")}] — ` +
        `launch.json is redacted like every other evidence file (see src/engine/redactor.ts) and can no longer ` +
        `supply them. Pass --goal/--input to the compile CLI with the same values used at discovery launch, ` +
        `or (recommended) run \`discover ... --compile\`, which supplies them in-process and never reads this file.`,
    );
  }

  return launch;
}
