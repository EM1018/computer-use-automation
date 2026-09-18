#!/usr/bin/env node
/**
 * npm run discover:e2e
 *
 * The one real end-to-end discovery run: a real model (via ANTHROPIC_API_KEY),
 * a real headed browser, a real target app — no mocks anywhere. Not a vitest
 * test (discovery's automated tests use a scripted model — see
 * test/discovery/loop.test.ts — specifically to avoid real API calls); this
 * script is the thing a person runs to actually watch a model discover a
 * capability, self-contained the same way ./escalation.ts is.
 *
 * Lives under src/demo/, not src/discovery/, on purpose: it wires a
 * concrete goal to this specific target app, same as escalation.ts wires a
 * concrete artifact and query flag — that's demo/example content, not
 * generic discovery-loop logic, and src/discovery/ is held to the same
 * "no target-app-specific knowledge" discipline as the replay engine (see
 * test/engine/domain-agnostic.test.ts).
 */
import "dotenv/config";
import { type ChildProcess, spawn } from "node:child_process";
import { SessionFactory } from "../engine/session.js";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import { AnthropicModelClient } from "../discovery/model.js";
import { runDiscovery } from "../discovery/loop.js";
import { startOperatorServer } from "../operator/server.js";

const APP_PORT = 5093;
const OPERATOR_PORT = 4549;
const OPERATOR_USER = "operator";
const OPERATOR_PASS = "changeme123";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAppReady(baseUrl: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // not accepting connections yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`target app at ${baseUrl} did not become ready within ${timeoutMs}ms`);
    }
    await sleep(150);
  }
}

async function main(): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_API_KEY must be set to run the real discovery end-to-end script");
  }

  const appBaseUrl = `http://127.0.0.1:${APP_PORT}`;
  console.log(`[e2e] starting target app at ${appBaseUrl}...`);
  const appProcess: ChildProcess = spawn("python3", ["app.py"], {
    env: { ...process.env, TENANT: "first_credit_union", PORT: String(APP_PORT), OPERATOR_USER, OPERATOR_PASS },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForAppReady(appBaseUrl);

  process.env["FCU_OPERATOR_USER"] = OPERATOR_USER;
  process.env["FCU_OPERATOR_PASS"] = OPERATOR_PASS;

  const appConfig: AppConfig = {
    baseUrl: appBaseUrl,
    loginPath: "/login",
    usernameSelector: "#txtUser",
    passwordSelector: "#txtPass",
    submitSelector: "input[type=submit]",
    headless: process.env["HEADLESS"] === "1",
  };
  const policy: PolicyConfig = {
    allowedBaseUrls: [appBaseUrl],
    irreversibleTargets: [{ role: "button", namePattern: "^Close Account$" }],
  };

  const session = await SessionFactory.create(appConfig);
  const model = new AnthropicModelClient();

  let operatorServer: ReturnType<typeof startOperatorServer> | undefined;
  const runId = `discover-e2e-${Date.now()}`;

  console.log(`[e2e] running discovery (run_id "${runId}") with the real model...`);
  const result = await runDiscovery(
    session,
    "Find the current savings account balance for the member with id 10001 and report it.",
    { member_id: "10001" },
    policy,
    model,
    {
      runId,
      maxSteps: 15,
      onEscalation: (interventionId) => {
        operatorServer ??= startOperatorServer(OPERATOR_PORT);
        console.error(`\n[e2e] escalated — open http://127.0.0.1:${OPERATOR_PORT}/interventions/${interventionId}\n[e2e] waiting for a human...\n`);
      },
    },
  );

  console.log("[e2e] result:", JSON.stringify(result, null, 2));

  const sessionAlreadyClosed: ReadonlyArray<typeof result.status> = ["escalation_abandoned", "escalation_timeout", "escalation_failed"];
  if (!sessionAlreadyClosed.includes(result.status)) {
    await session.close();
    await session.browser.close();
  }
  operatorServer?.close();
  appProcess.kill();

  process.exitCode = result.status === "goal_reached" ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
