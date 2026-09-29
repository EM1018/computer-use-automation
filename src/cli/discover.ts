#!/usr/bin/env node
import "dotenv/config";
import { SessionFactory } from "../engine/session.js";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import { AnthropicModelClient } from "../discovery/model.js";
import { runDiscovery } from "../discovery/loop.js";
import { startOperatorServer } from "../operator/server.js";
import { compileArtifact } from "../compiler/compile.js";
import { parameterizeFreeText } from "../compiler/parameterize.js";

interface ParsedArgs {
  goal: string;
  inputs: Record<string, string>;
  /** Parsed but not yet consumed — this CLI, like cli/replay.ts's --tenant, targets a single configured app; multi-tenant base_url selection is a future extension. */
  tenant: string | undefined;
  maxSteps: number | undefined;
  /** Runs the compiler immediately after a successful ("goal_reached") discovery run, in the same process — reuses the goal/inputs already in memory instead of re-reading evidence/<run_id>/launch.json. */
  compile: boolean;
  compileProbe: boolean;
  capabilityId: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let goal: string | undefined;
  const inputs: Record<string, string> = {};
  let tenant: string | undefined;
  let maxSteps: number | undefined;
  let compile = false;
  let compileProbe = true;
  let capabilityId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--goal") {
      goal = argv[i + 1];
      i += 1;
    } else if (arg === "--input") {
      const pair = argv[i + 1];
      if (!pair || !pair.includes("=")) {
        throw new Error("--input requires a <name>=<value> argument");
      }
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--tenant") {
      tenant = argv[i + 1];
      i += 1;
    } else if (arg === "--max-steps") {
      const raw = argv[i + 1];
      if (raw) {
        maxSteps = Number.parseInt(raw, 10);
      }
      i += 1;
    } else if (arg === "--compile") {
      compile = true;
    } else if (arg === "--no-probe") {
      compileProbe = false;
    } else if (arg === "--capability-id") {
      capabilityId = argv[i + 1];
      i += 1;
    }
  }

  if (!goal) {
    throw new Error(
      'usage: discover --goal "<natural language goal>" --input <name>=<value> [--tenant X] [--max-steps N] [--compile [--no-probe] [--capability-id X]]',
    );
  }

  return { goal, inputs, tenant, maxSteps, compile, compileProbe, capabilityId };
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
    // Headed by default — required for human hand-off, same as replay.
    headless: process.env["HEADLESS"] === "1",
  };

  const policy: PolicyConfig = {
    allowedBaseUrls: (process.env["ENGINE_ALLOWED_BASE_URLS"] ?? baseUrl).split(","),
    confirmIrreversible: process.env["CONFIRM_IRREVERSIBLE"] === "1",
    // This target app's one known irreversible control. A production
    // deployment would load this per target app rather than hardcode it
    // here, same as this CLI already hardcodes the login form's selectors.
    irreversibleTargets: [{ role: "button", namePattern: "^Close Account$" }],
  };

  const model = new AnthropicModelClient();
  const session = await SessionFactory.create(appConfig);

  const operatorPort = Number(process.env["OPERATOR_PORT"] ?? "4545");
  let operatorServer: ReturnType<typeof startOperatorServer> | undefined;

  const options: Parameters<typeof runDiscovery>[5] = {
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    onEscalation: (interventionId: string) => {
      operatorServer ??= startOperatorServer(operatorPort);
      console.error(
        `\n[discover] escalated — open http://127.0.0.1:${operatorPort}/interventions/${interventionId}\n[discover] waiting for a human...\n`,
      );
    },
  };

  const result = await runDiscovery(session, args.goal, args.inputs, policy, model, options);

  console.log(JSON.stringify(result, null, 2));

  // Escalation outcomes other than a successful resume already close the
  // session themselves (see src/discovery/escalation.ts); only close it
  // here for the paths that never touched that machinery.
  const sessionAlreadyClosed: ReadonlyArray<typeof result.status> = ["escalation_abandoned", "escalation_timeout", "escalation_failed"];
  if (!sessionAlreadyClosed.includes(result.status)) {
    await session.close();
    await session.browser.close();
  }
  operatorServer?.close();

  if (result.status !== "goal_reached") {
    process.exitCode = 1;
    return;
  }

  if (!args.compile) {
    process.exitCode = 0;
    return;
  }

  function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "capability";
  }

  // A natural goal commonly names an input's value inline (e.g. "...for
  // account 10001") — parameterize BEFORE
  // slugifying so the derived capability id (and the artifact's filename)
  // never embeds a raw sensitive value. compileArtifact separately
  // parameterizes title/description the same way; capabilityId has to be
  // fixed here instead, since by the time compileArtifact sees it, it
  // can't tell an auto-derived id from one the caller intentionally chose.
  const capabilityIdSource = parameterizeFreeText(args.goal, args.inputs);

  const compileResult = await compileArtifact({
    runId: result.runId,
    probe: args.compileProbe,
    appConfig,
    policy,
    // Reuses the goal/inputs already in memory rather than re-reading
    // evidence/<run_id>/launch.json — see compile.ts's own doc comment on
    // why that file has to exist for the standalone CLI path at all.
    launch: { goal: args.goal, inputs: args.inputs },
    target: {
      capabilityId: args.capabilityId ?? slugify(capabilityIdSource),
      title: args.goal,
      description: args.goal,
      app: process.env["TARGET_APP_NAME"] ?? "legacy-app",
      appVersion: process.env["TARGET_APP_VERSION"] ?? "1.0.0",
      tenant: process.env["TARGET_TENANT"] ?? "default",
      model: process.env["DISCOVERY_MODEL"] ?? "claude-sonnet-5",
    },
  });

  console.log(JSON.stringify({ compiled: true, passed: compileResult.passed, artifactPath: compileResult.artifactPath, compileDiffPath: compileResult.compileDiffPath }, null, 2));
  process.exitCode = compileResult.passed ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
