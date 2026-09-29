/**
 * Mandatory post-compile verification: replay the freshly-compiled artifact,
 * with the SAME inputs used at discovery launch, through the real replay
 * engine (../engine/replay.ts) — never a bespoke check. Always writes the
 * artifact to drafts/ regardless of outcome: a failed draft is the best
 * debugging evidence available (comparing it against the transcript is how
 * a human learns whether the pruner cut something load-bearing), and
 * discarding it just means burning another discovery run to find out again.
 * Only `capability approve` (../approval.ts) ever promotes a draft out of
 * artifacts/drafts/ — this module never writes to artifacts/ directly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { replay } from "../engine/replay.js";
import { SessionFactory, type Session } from "../engine/session.js";
import type { AppConfig, PolicyConfig } from "../engine/config.js";
import type { InvocationInputs } from "../engine/policy.js";
import { CapabilityArtifactSchema, type CapabilityArtifact, type Verification } from "../schema/capability.js";

export interface VerifyOptions {
  appConfig: AppConfig;
  policy: PolicyConfig;
}

export interface VerifyResult {
  artifact: CapabilityArtifact;
  passed: boolean;
  path: string;
}

export async function verifyAndWriteDraft(artifact: CapabilityArtifact, inputs: InvocationInputs, draftsDirOverride: string | undefined, options: VerifyOptions): Promise<VerifyResult> {
  const draftsDir = draftsDirOverride ?? join("artifacts", "drafts");
  mkdirSync(draftsDir, { recursive: true });

  let session: Session | undefined;
  const result = await replay(
    artifact,
    inputs,
    async () => {
      session = await SessionFactory.create(options.appConfig);
      return session;
    },
    { ...options.policy, allowDraft: true, unattended: true },
  );
  await session?.close().catch(() => undefined);
  await session?.browser.close().catch(() => undefined);

  let verification: Verification;
  let passed: boolean;
  // Narrowed by STRUCTURE ("x" in result), not by `result.status === "..."`:
  // BusinessOutcomeResult's status is a plain `string` (its value is
  // whatever the artifact's own outcomes declare — see ../schema/result.ts's
  // doc comment), so a literal-equality check can't rule it out the way it
  // can for the other five variants. Each `in` check below targets a field
  // unique to exactly one variant; the final `else` is reachable only by
  // EscalationTimeoutResult, the one variant with no field of its own.
  if ("steps_executed" in result) {
    passed = true;
    verification = { status: "passed", run: result.run_id };
  } else if ("failed_step" in result) {
    passed = false;
    verification = { status: "failed", run: result.run_id, failed_step: result.failed_step, expected: result.expected, observed: result.observed };
  } else if ("errors" in result) {
    passed = false;
    verification = {
      status: "failed",
      run: "n/a",
      expected: "supplied inputs to satisfy the derived contract",
      observed: result.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
    };
  } else if ("resumable" in result) {
    passed = false;
    verification = {
      status: "failed",
      run: result.run_id,
      expected: "the happy-path verification run to complete unattended",
      observed: 'run escalated instead (status: "escalated")',
    };
  } else if ("outcome_id" in result) {
    // A business outcome during the HAPPY-PATH verification run is itself a
    // failure to verify: the whole point of this pass is confirming the
    // artifact reaches "success" with the inputs it was recorded against.
    passed = false;
    verification = {
      status: "failed",
      run: result.run_id,
      expected: 'status "success"',
      observed: `unexpected business outcome "${result.status}" during happy-path verification`,
    };
  } else {
    passed = false;
    verification = {
      status: "failed",
      run: result.run_id,
      expected: "the happy-path verification run to complete unattended",
      observed: 'run escalated instead (status: "escalation_timeout")',
    };
  }

  const finalArtifact: CapabilityArtifact = { ...artifact, verification };
  const parsed = CapabilityArtifactSchema.parse(finalArtifact);
  const filename = `${artifact.capability.id}.v${artifact.capability.version.major}.${artifact.capability.version.minor}.yaml`;
  const path = join(draftsDir, filename);
  writeFileSync(path, yaml.dump(parsed), "utf8");

  return { artifact: parsed, passed, path };
}
