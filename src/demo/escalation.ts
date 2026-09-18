#!/usr/bin/env node
/**
 * npm run demo:escalation
 *
 * End-to-end walkthrough of the human-in-the-loop escalation path:
 *   1. replays lookup_savings_balance with ?expire=1
 *   2. the fill step fails its target, falls through to the declared
 *      session_expired recoverable, which escalates — automation holds no
 *      credentials, and re-login is deliberately not part of any artifact
 *   3. an intervention record is written, the session is ceded, and the
 *      engine's continuation blocks on the operator surface
 *   4. this script prints the operator URL and waits
 *   5. a human logs in manually in the live (headed) browser window, then
 *      hits Resume on the operator page
 *   6. the engine re-verifies page state, continues from the stuck step,
 *      and the run completes with the balance
 *
 * This script polls evidence/result.json rather than awaiting replay()
 * itself, because replay() deliberately returns "escalated" immediately —
 * see the caller-facing-boundary comment in src/engine/replay.ts. A real
 * caller would look the run up later (or receive a webhook, in a fuller
 * system); polling here is just this demo's own way of knowing when to
 * stop waiting and print the result, not a substitute for a real condition
 * check inside the engine.
 */
import "dotenv/config";
import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadArtifact } from "../loader.js";
import { replay } from "../engine/replay.js";
import { SessionFactory } from "../engine/session.js";
import { startOperatorServer } from "../operator/server.js";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import type { CapabilityArtifact } from "../schema/capability.js";
import type { CapabilityResult } from "../schema/result.js";

const APP_PORT = 5099;
const OPERATOR_PORT = 4545;
const OPERATOR_USER = "operator";
const OPERATOR_PASS = "changeme123";
const EVIDENCE_ROOT = "evidence";

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

function withAppendedQuery(artifact: CapabilityArtifact, query: string): CapabilityArtifact {
  const clone = structuredClone(artifact);
  const firstNavigate = clone.steps.find((step) => step.action === "navigate");
  if (!firstNavigate) {
    throw new Error("artifact has no navigate step to append the demo query flag to");
  }
  const [path, existingQuery] = (firstNavigate.value ?? "/").split("?");
  firstNavigate.value = `${path}?${[existingQuery, query].filter(Boolean).join("&")}`;
  return clone;
}

/** Polls result.json for a status other than "escalated" — this demo's own way of knowing when to stop waiting, not part of the engine. */
async function waitForFinalResult(runId: string, timeoutMs: number): Promise<CapabilityResult> {
  const resultPath = join(EVIDENCE_ROOT, runId, "result.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(resultPath, "utf8");
      const result = JSON.parse(raw) as CapabilityResult;
      if (!("resumable" in result)) {
        return result;
      }
    } catch {
      // result.json not written yet, or mid-write — keep polling.
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for a final result for run "${runId}"`);
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const appBaseUrl = `http://127.0.0.1:${APP_PORT}`;
  console.log(`[demo] starting target app at ${appBaseUrl}...`);
  const appProcess: ChildProcess = spawn("python3", ["app.py"], {
    env: { ...process.env, TENANT: "first_credit_union", PORT: String(APP_PORT), OPERATOR_USER, OPERATOR_PASS },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForAppReady(appBaseUrl);

  process.env["FCU_OPERATOR_USER"] = OPERATOR_USER;
  process.env["FCU_OPERATOR_PASS"] = OPERATOR_PASS;

  console.log(`[demo] starting operator surface at http://127.0.0.1:${OPERATOR_PORT}...`);
  const operatorServer = startOperatorServer(OPERATOR_PORT);

  const loaded = loadArtifact(join("artifacts", "drafts", "lookup_savings_balance.v1.0.yaml"));
  if (!loaded.ok) {
    throw new Error(`failed to load the demo artifact: ${loaded.error.message}`);
  }
  const artifact = withAppendedQuery(
    { ...loaded.artifact, recorded_against: { ...loaded.artifact.recorded_against, base_url: appBaseUrl } },
    "expire=1",
  );

  const appConfig: AppConfig = {
    baseUrl: appBaseUrl,
    loginPath: "/login",
    usernameSelector: "#txtUser",
    passwordSelector: "#txtPass",
    submitSelector: "input[type=submit]",
    headless: false,
  };
  const policy: PolicyConfig = { allowedBaseUrls: [appBaseUrl], unattended: true, allowDraft: true };
  const runId = `demo-escalation-${Date.now()}`;

  console.log(`[demo] replaying lookup_savings_balance@1.0 with ?expire=1 (run_id "${runId}")...`);
  const result = await replay(
    artifact,
    { member_id: "10001" },
    () => SessionFactory.create(appConfig),
    policy,
    { runId, evidenceRoot: EVIDENCE_ROOT },
  );

  if (!("resumable" in result)) {
    console.log("[demo] run did not escalate as expected — result:", JSON.stringify(result, null, 2));
  } else {
    console.log(`\n[demo] escalated: ${result.reason}`);
    console.log(`[demo] intervention: http://127.0.0.1:${OPERATOR_PORT}/interventions/${result.intervention_id}`);
    console.log("[demo] open that URL, click Claim, log in as the operator in the live browser window, then click Resume.");
    console.log("[demo] waiting for a human...\n");

    const final = await waitForFinalResult(runId, 60 * 60 * 1000);
    console.log("[demo] run finished:", JSON.stringify(final, null, 2));
  }

  operatorServer.close();
  appProcess.kill();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
