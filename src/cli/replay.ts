#!/usr/bin/env node
import { join } from "node:path";
import { loadArtifact, resolveCapability } from "../loader.js";
import { replay } from "../engine/replay.js";
import { SessionFactory } from "../engine/session.js";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import type { InvocationInputs } from "../engine/policy.js";
import type { CapabilityArtifact, ValueType } from "../schema/capability.js";

interface ParsedArgs {
  capabilityId: string;
  major: number;
  /** Exact minor, when the selector was <id>@<major>.<minor>. Required with --allow-draft, since drafts aren't resolved by "highest approved". */
  minor: number | undefined;
  inputs: Record<string, string>;
  tenant: string | undefined;
  confirmIrreversible: boolean;
  allowDraft: boolean;
  /** Debug-only: appended as a query string onto the artifact's first navigate step, to exercise page-level flags the target app itself understands (e.g. a forced interstitial or session expiry) that aren't part of any capability's declared inputs. */
  query: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [selector, ...rest] = argv;
  if (!selector || !selector.includes("@")) {
    throw new Error(
      "usage: replay <capability_id>@<major>[.<minor>] --input name=value [--tenant X] [--confirm-irreversible] [--allow-draft] [--query k=v]",
    );
  }
  const atIndex = selector.lastIndexOf("@");
  const capabilityId = selector.slice(0, atIndex);
  const versionSpec = selector.slice(atIndex + 1);
  const [majorStr, minorStr] = versionSpec.split(".");
  const major = Number.parseInt(majorStr ?? "", 10);
  const minor = minorStr !== undefined ? Number.parseInt(minorStr, 10) : undefined;
  if (!capabilityId || Number.isNaN(major) || (minor !== undefined && Number.isNaN(minor))) {
    throw new Error(`invalid capability selector "${selector}", expected <capability_id>@<major>[.<minor>]`);
  }

  const inputs: Record<string, string> = {};
  let tenant: string | undefined;
  let confirmIrreversible = false;
  let allowDraft = false;
  let query: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--input") {
      const pair = rest[i + 1];
      if (!pair || !pair.includes("=")) {
        throw new Error("--input requires a name=value argument");
      }
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--tenant") {
      tenant = rest[i + 1];
      i += 1;
    } else if (arg === "--confirm-irreversible") {
      confirmIrreversible = true;
    } else if (arg === "--allow-draft") {
      allowDraft = true;
    } else if (arg === "--query") {
      query = rest[i + 1];
      i += 1;
    }
  }

  return { capabilityId, major, minor, inputs, tenant, confirmIrreversible, allowDraft, query };
}

function withAppendedQuery(artifact: CapabilityArtifact, query: string): CapabilityArtifact {
  const clone = structuredClone(artifact);
  const firstNavigate = clone.steps.find((step) => step.action === "navigate");
  if (!firstNavigate) {
    throw new Error("--query was given but this artifact has no navigate step to append it to");
  }
  const [path, existingQuery] = (firstNavigate.value ?? "/").split("?");
  const mergedQuery = [existingQuery, query].filter(Boolean).join("&");
  firstNavigate.value = `${path}?${mergedQuery}`;
  return clone;
}

function coerceInput(raw: string, type: ValueType): string | number | boolean {
  if (type === "number") {
    return Number(raw);
  }
  if (type === "boolean") {
    return raw === "true";
  }
  return raw;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let resolvedArtifact: CapabilityArtifact;
  if (args.allowDraft) {
    if (args.minor === undefined) {
      throw new Error("--allow-draft requires an exact selector <capability_id>@<major>.<minor>");
    }
    const draftPath = join("artifacts", "drafts", `${args.capabilityId}.v${args.major}.${args.minor}.yaml`);
    const loaded = loadArtifact(draftPath);
    if (!loaded.ok) {
      console.log(JSON.stringify({ status: "failed", failed_step: "resolve", expected: "a loadable draft artifact", observed: loaded.error.message, evidence: {}, run_id: "n/a" }));
      process.exitCode = 1;
      return;
    }
    resolvedArtifact = loaded.artifact;
  } else {
    const resolved = resolveCapability(args.capabilityId, args.major);
    if (!resolved.ok) {
      console.log(JSON.stringify({ status: "failed", failed_step: "resolve", expected: "an approved artifact", observed: resolved.error.message, evidence: {}, run_id: "n/a" }));
      process.exitCode = 1;
      return;
    }
    resolvedArtifact = resolved.artifact;
  }
  const artifact = args.query ? withAppendedQuery(resolvedArtifact, args.query) : resolvedArtifact;

  const inputs: InvocationInputs = {};
  for (const input of artifact.inputs) {
    const raw = args.inputs[input.name];
    if (raw !== undefined) {
      inputs[input.name] = coerceInput(raw, input.type);
    }
  }

  const slowMoRaw = process.env["SLOWMO_MS"];
  const appConfig: AppConfig = {
    baseUrl: artifact.recorded_against.base_url,
    loginPath: "/login",
    usernameSelector: "#txtUser",
    passwordSelector: "#txtPass",
    submitSelector: "input[type=submit]",
    headless: process.env["HEADLESS"] === "1",
    ...(slowMoRaw ? { slowMoMs: Number(slowMoRaw) } : {}),
  };

  const policy: PolicyConfig = {
    allowedBaseUrls: (process.env["ENGINE_ALLOWED_BASE_URLS"] ?? artifact.recorded_against.base_url).split(","),
    confirmIrreversible: args.confirmIrreversible,
    unattended: true,
    allowDraft: args.allowDraft,
  };

  let session: Awaited<ReturnType<typeof SessionFactory.create>> | undefined;
  const result = await replay(
    artifact,
    inputs,
    async () => {
      session = await SessionFactory.create(appConfig);
      return session;
    },
    policy,
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "failed" || result.status === "invalid_input" ? 1 : 0;

  const holdMs = Number(process.env["HOLD_MS"] ?? "0");
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }

  await session?.close();
  await session?.browser.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
