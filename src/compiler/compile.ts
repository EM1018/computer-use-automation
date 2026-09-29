/**
 * Orchestrates the four transformations (prune, parameterize, derive
 * locators, derive contract) plus outcome probing, the no-observed-values
 * safety check, mandatory verification, and compile_diff.md — turning one
 * discovery transcript into a capability artifact draft.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import { SessionFactory, type Session } from "../engine/session.js";
import type { CapabilityArtifact, Outcome, Recoverable, Version } from "../schema/capability.js";
import { loadTranscript, type LaunchInfo } from "./transcript.js";
import { pruneDeadEnds } from "./prune.js";
import { parameterizeActions, parameterizeFreeText } from "./parameterize.js";
import { driveAndDeriveSteps } from "./driver.js";
import { synthesizeAssertSteps } from "./checkpoints.js";
import { deriveInputs, deriveOutputs } from "./contract.js";
import { assertNoObservedValues } from "./safety.js";
import { renderCompileDiff } from "./diff.js";
import { verifyAndWriteDraft } from "./verify.js";
import { probeOutcomes, type ProbeVariant } from "./outcomes.js";

export interface CompileTargetInfo {
  capabilityId: string;
  title: string;
  description: string;
  app: string;
  appVersion: string;
  tenant: string;
  model: string;
}

export interface HandDeclaredOutcomes {
  outcomes: Outcome[];
  recoverables: Recoverable[];
}

export interface CompileOptions {
  runId: string;
  evidenceRoot?: string;
  draftsDir?: string;
  /** Defaults to true. When false and no `handDeclared` is supplied, the artifact ships with empty outcomes/recoverables and a compiler_note explaining why. */
  probe?: boolean;
  probeVariants?: ProbeVariant[];
  handDeclared?: HandDeclaredOutcomes;
  appConfig: AppConfig;
  policy: PolicyConfig;
  target: CompileTargetInfo;
  version?: Version;
  /** The goal and REAL input values used at discovery launch — required for normal operation (launch.json on disk is redacted, see ../engine/redactor.ts, and never carries them). `discover --compile` supplies this from memory; the standalone `compile` CLI supplies it from --goal/--input. */
  launch?: LaunchInfo;
}

export interface CompileResult {
  artifact: CapabilityArtifact;
  passed: boolean;
  artifactPath: string;
  compileDiffPath: string;
}

function defaultProbeVariants(primaryInputName: string | undefined): ProbeVariant[] {
  if (!primaryInputName) {
    return [];
  }
  // These specific alternate values (99999, 10002) and query flags match
  // this target app's own documented seeded behaviors (see README.md) —
  // reasonable defaults for THIS app, overridable via options.probeVariants
  // for any other target.
  return [
    { id: "not_found", description: `alternate ${primaryInputName} expected to render a not-found page`, inputOverrides: { [primaryInputName]: "99999" }, kind: "business_outcome" },
    { id: "permission_denied", description: `alternate ${primaryInputName} expected to render a permission-denied page`, inputOverrides: { [primaryInputName]: "10002" }, kind: "business_outcome" },
    { id: "maintenance_interstitial", description: "interstitial query flag", queryFlag: "interstitial=1", kind: "recoverable_interstitial" },
    { id: "session_expired", description: "session-expiry query flag", queryFlag: "expire=1", kind: "recoverable_expired" },
  ];
}

export async function compileArtifact(options: CompileOptions): Promise<CompileResult> {
  const evidenceRoot = options.evidenceRoot ?? "evidence";
  const transcript = loadTranscript(options.runId, evidenceRoot, options.launch);
  const { goal } = transcript.launch;
  const inputs: Record<string, string | number | boolean> = transcript.launch.inputs;

  const prune = pruneDeadEnds(transcript.turns);
  const keptSet = new Set(prune.keptTurns);
  const keptActionEntries = transcript.actions
    .filter((entry) => keptSet.has(entry.turn))
    .sort((a, b) => a.turn - b.turn)
    .map((entry) => ({ turn: entry.turn, action: entry.action, ...(entry.ref_resolution ? { refDescriptor: entry.ref_resolution } : {}) }));

  const parameterized = parameterizeActions(keptActionEntries, inputs);
  const pageChangedByTurn = new Map(transcript.turns.map((turn) => [turn.turn, turn.page_changed]));

  const browser = await chromium.launch({ headless: options.appConfig.headless ?? false });
  let session: Session | undefined;
  const shouldProbe = options.probe ?? true;
  let drive: Awaited<ReturnType<typeof driveAndDeriveSteps>>;
  let probe: Awaited<ReturnType<typeof probeOutcomes>> | undefined;
  try {
    session = await SessionFactory.createInBrowser(browser, options.appConfig);
    drive = await driveAndDeriveSteps(session.page, parameterized.actions, options.appConfig.baseUrl, pageChangedByTurn, inputs);

    if (shouldProbe && !options.handDeclared) {
      const primaryInput = Object.keys(inputs)[0];
      const variants = options.probeVariants ?? defaultProbeVariants(primaryInput);
      // Each probe variant gets its OWN freshly-logged-in session (see
      // probeOutcomes' doc comment) — never the derivation session above,
      // whose page is left wherever the happy path's last step landed.
      probe = await probeOutcomes(browser, options.appConfig, drive.steps, inputs, options.appConfig.baseUrl, variants);
    }
  } finally {
    await session?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  // Deciding which (if any) synthesized checkpoint candidate is safe needs
  // to know what a branch page looks like — that's `probe.branchPages`,
  // which only exists once probing has actually run. Runs unconditionally
  // (not gated on shouldProbe) per the compiler README: --no-probe or a
  // hand-declared-outcomes run still gets checkpoints, just unvalidated
  // ones, with a note saying so — never silently weaker than a hand-written
  // artifact (see src/compiler/README.md's "Synthesized checkpoints").
  const probeRan = probe !== undefined;
  const synthesizedResult = synthesizeAssertSteps(drive, probe?.branchPages ?? [], probeRan);

  const version = options.version ?? { major: 1, minor: 0 };
  const outputs = deriveOutputs(drive.outputSamples);
  const declaredInputs = deriveInputs(inputs);

  const outcomes: Outcome[] = options.handDeclared
    ? options.handDeclared.outcomes.map((o) => ({ ...o, provenance: "hand_declared" as const }))
    : (probe?.outcomes ?? []);
  const recoverables: Recoverable[] = options.handDeclared?.recoverables ?? probe?.recoverables ?? [];

  // Free text — the goal, and title/description derived from it by the
  // CLIs — commonly names a supplied input's value directly ("give me the
  // savings balance for member 10001" says "10001" in plain prose, not as
  // a structured field), which would otherwise flow a raw sensitive value
  // straight into the artifact's capability.title/description (caught by
  // assertNoObservedValues below) and into compile_diff.md's own "Goal:"
  // line (which nothing else checks). Parameterize all three the same way,
  // before either ever gets written. See parameterizeFreeText's doc
  // comment (./parameterize.ts) for why substring replacement is correct
  // here despite being refused everywhere else in this compiler.
  const parameterizedGoal = parameterizeFreeText(goal, inputs);
  const parameterizedTitle = parameterizeFreeText(options.target.title, inputs);
  const parameterizedDescription = parameterizeFreeText(options.target.description, inputs);

  const compilerNotes = [...drive.notes, ...synthesizedResult.notes];
  if (parameterizedGoal !== goal || parameterizedTitle !== options.target.title || parameterizedDescription !== options.target.description) {
    // Deliberately no example value in this message: it becomes part of
    // the artifact (compiler_notes), so it has to obey the same rule
    // everything else here does — never echo a raw sensitive value, not
    // even as an illustrative example.
    compilerNotes.push(
      "the supplied goal/title/description named a supplied input's value directly and was parameterized to {{input_name}} before being used — " +
        "the original wording is still visible in this run's evidence/<run_id>/launch.json.",
    );
  }
  if (!shouldProbe && !options.handDeclared) {
    compilerNotes.push(
      "probing was skipped (--no-probe) and no hand-declared outcomes were supplied: this artifact ships with EMPTY outcomes/recoverables. " +
        "Hand-author them (or supply --outcomes-file) before approving — without them, any non-happy-path page state will hard-fail instead of returning a business outcome.",
    );
  }

  const artifactDraft: CapabilityArtifact = {
    schema_version: 1,
    capability: {
      id: options.target.capabilityId,
      version,
      title: parameterizedTitle,
      description: parameterizedDescription,
      status: "draft",
    },
    recorded_against: {
      app: options.target.app,
      app_version: options.target.appVersion,
      tenant: options.target.tenant,
      base_url: options.appConfig.baseUrl,
    },
    provenance: {
      discovered_at: new Date().toISOString(),
      model: options.target.model,
      run_id: options.runId,
      transcript_ref: `evidence/${options.runId}/transcript.jsonl`,
    },
    inputs: declaredInputs,
    outputs,
    steps: synthesizedResult.steps,
    outcomes,
    recoverables,
    ...(compilerNotes.length > 0 ? { compiler_notes: compilerNotes } : {}),
  };

  const sensitiveValues = new Set<string>([...Object.values(inputs).map(String), ...(probe?.sensitiveValuesUsed ?? [])]);
  assertNoObservedValues(artifactDraft, sensitiveValues);

  const { artifact: verifiedArtifact, passed, path: artifactPath } = await verifyAndWriteDraft(artifactDraft, inputs, options.draftsDir, {
    appConfig: options.appConfig,
    policy: options.policy,
  });

  const diff = renderCompileDiff({
    runId: options.runId,
    goal: parameterizedGoal,
    prune,
    parameterize: parameterized,
    derivations: synthesizedResult.derivations,
    outputs,
    notes: drive.notes,
    probeNotes: probe?.notes ?? [],
    synthesizedCheckpoints: synthesizedResult.synthesized,
  });
  const compileDiffPath = join(evidenceRoot, options.runId, "compile_diff.md");
  writeFileSync(compileDiffPath, diff, "utf8");

  return { artifact: verifiedArtifact, passed, artifactPath, compileDiffPath };
}
