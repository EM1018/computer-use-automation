#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import { compileArtifact } from "../compiler/compile.js";
import { parameterizeFreeText } from "../compiler/parameterize.js";
import type { Outcome, Recoverable } from "../schema/capability.js";

interface ParsedArgs {
  runId: string;
  probe: boolean;
  goal: string | undefined;
  inputs: Record<string, string>;
  capabilityId: string | undefined;
  title: string | undefined;
  description: string | undefined;
  outcomesFile: string | undefined;
}

function usage(): never {
  throw new Error(
    'usage: compile <run_id> [--no-probe] [--goal "<goal>"] [--input name=value ...] ' +
      "[--capability-id X] [--title X] [--description X] [--outcomes-file path.json]",
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const [runId, ...rest] = argv;
  if (!runId) {
    usage();
  }
  let probe = true;
  let goal: string | undefined;
  const inputs: Record<string, string> = {};
  let capabilityId: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let outcomesFile: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--no-probe") {
      probe = false;
    } else if (arg === "--goal") {
      goal = rest[i + 1];
      i += 1;
    } else if (arg === "--input") {
      const pair = rest[i + 1];
      if (!pair || !pair.includes("=")) {
        throw new Error("--input requires a <name>=<value> argument");
      }
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--capability-id") {
      capabilityId = rest[i + 1];
      i += 1;
    } else if (arg === "--title") {
      title = rest[i + 1];
      i += 1;
    } else if (arg === "--description") {
      description = rest[i + 1];
      i += 1;
    } else if (arg === "--outcomes-file") {
      outcomesFile = rest[i + 1];
      i += 1;
    }
  }

  return { runId, probe, goal, inputs, capabilityId, title, description, outcomesFile };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "capability";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = process.env["TARGET_BASE_URL"] ?? "http://127.0.0.1:5001";
  const appConfig: AppConfig = {
    baseUrl,
    loginPath: "/login",
    usernameSelector: "#txtUser",
    passwordSelector: "#txtPass",
    submitSelector: "input[type=submit]",
    headless: process.env["HEADLESS"] === "1",
  };
  const policy: PolicyConfig = {
    allowedBaseUrls: (process.env["ENGINE_ALLOWED_BASE_URLS"] ?? baseUrl).split(","),
  };

  let handDeclared: { outcomes: Outcome[]; recoverables: Recoverable[] } | undefined;
  if (args.outcomesFile) {
    const parsed = JSON.parse(readFileSync(args.outcomesFile, "utf8")) as { outcomes?: Outcome[]; recoverables?: Recoverable[] };
    handDeclared = { outcomes: parsed.outcomes ?? [], recoverables: parsed.recoverables ?? [] };
  }

  // The literal CLI spec is just `compile <run_id> [--no-probe]`, which
  // works for the recommended `discover ... --compile` flow (goal/inputs
  // never leave memory). Standalone `compile <run_id>` on its own now
  // requires --goal/--input for any current-build transcript: launch.json
  // is redacted like every other evidence file (see ../engine/redactor.ts
  // and ../compiler/transcript.ts's readLaunch), so it never carries real
  // input values to fall back on. These flags remain a fallback ONLY for
  // transcripts written by an older build, whose launch.json still has raw
  // values — see src/compiler/README.md's "Judgment calls" section.
  const launch = args.goal ? { goal: args.goal, inputs: args.inputs } : undefined;
  const goalForNaming = args.goal ?? args.runId;
  // Parameterized before slugifying/naming — see the matching comment in
  // ../cli/discover.ts for why: a natural goal commonly names a supplied
  // input's value inline, and compileArtifact can't safely fix this up
  // itself for capabilityId (it can't tell an auto-derived id from one the
  // caller intentionally chose via --capability-id).
  const namingSource = parameterizeFreeText(goalForNaming, args.inputs);

  const result = await compileArtifact({
    runId: args.runId,
    probe: args.probe,
    ...(handDeclared ? { handDeclared } : {}),
    appConfig,
    policy,
    ...(launch ? { launch } : {}),
    target: {
      capabilityId: args.capabilityId ?? slugify(namingSource),
      title: args.title ?? goalForNaming,
      description: args.description ?? args.goal ?? `Compiled from discovery run ${args.runId}.`,
      app: process.env["TARGET_APP_NAME"] ?? "legacy-app",
      appVersion: process.env["TARGET_APP_VERSION"] ?? "1.0.0",
      tenant: process.env["TARGET_TENANT"] ?? "default",
      model: process.env["DISCOVERY_MODEL"] ?? "claude-sonnet-5",
    },
  });

  console.log(JSON.stringify({ passed: result.passed, artifactPath: result.artifactPath, compileDiffPath: result.compileDiffPath }, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
