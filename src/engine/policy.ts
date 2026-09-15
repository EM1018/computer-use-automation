import type { CapabilityArtifact } from "../schema/capability.js";
import type { PolicyConfig } from "./config.js";
import type { CapabilityResult, InvalidInputError } from "../schema/result.js";

export type InvocationInputs = Record<string, string | number | boolean>;

export type PreflightResult =
  | { ok: true; values: InvocationInputs; warning?: string }
  | { ok: false; result: CapabilityResult };

/**
 * Phase 1, run in order: contract validation, then policy, then approval.
 * Contract validation runs first so a malformed input is reported as a
 * caller error (invalid_input) rather than a policy message — nothing here
 * touches a browser.
 */
export function preflight(
  artifact: CapabilityArtifact,
  rawInputs: InvocationInputs,
  policy: PolicyConfig,
  runId: string,
): PreflightResult {
  const contract = validateInputs(artifact, rawInputs);
  if (!contract.ok) {
    return { ok: false, result: { status: "invalid_input", errors: contract.errors } };
  }

  const policyCheck = checkPolicy(artifact, policy);
  if (!policyCheck.ok) {
    return {
      ok: false,
      result: {
        status: "failed",
        failed_step: "preflight:policy",
        expected: policyCheck.expected,
        observed: policyCheck.observed,
        evidence: {},
        run_id: runId,
      },
    };
  }

  const approvalCheck = checkApproval(artifact, policy);
  if (!approvalCheck.ok) {
    return {
      ok: false,
      result: {
        status: "failed",
        failed_step: "preflight:approval",
        expected: approvalCheck.expected,
        observed: approvalCheck.observed,
        evidence: {},
        run_id: runId,
      },
    };
  }

  return approvalCheck.warning
    ? { ok: true, values: contract.values, warning: approvalCheck.warning }
    : { ok: true, values: contract.values };
}

type ContractResult = { ok: true; values: InvocationInputs } | { ok: false; errors: InvalidInputError[] };

function validateInputs(artifact: CapabilityArtifact, rawInputs: InvocationInputs): ContractResult {
  const errors: InvalidInputError[] = [];
  const values: InvocationInputs = {};
  const declaredNames = new Set(artifact.inputs.map((input) => input.name));

  for (const input of artifact.inputs) {
    const value = rawInputs[input.name];
    if (value === undefined) {
      if (input.required) {
        errors.push({ path: input.name, message: "required input is missing" });
      }
      continue;
    }
    if (typeof value !== input.type) {
      errors.push({ path: input.name, message: `expected type "${input.type}", got "${typeof value}"` });
      continue;
    }
    if (input.pattern && typeof value === "string" && !new RegExp(input.pattern).test(value)) {
      errors.push({ path: input.name, message: `value does not match pattern ${input.pattern}` });
      continue;
    }
    values[input.name] = value;
  }

  for (const key of Object.keys(rawInputs)) {
    if (!declaredNames.has(key)) {
      errors.push({ path: key, message: "unexpected input not declared by this capability" });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

type PolicyResult = { ok: true; warning?: string } | { ok: false; expected: string; observed: string };

function checkPolicy(artifact: CapabilityArtifact, policy: PolicyConfig): PolicyResult {
  const baseUrl = artifact.recorded_against.base_url;
  if (!policy.allowedBaseUrls.includes(baseUrl)) {
    return {
      ok: false,
      expected: `base_url in allowlist [${policy.allowedBaseUrls.join(", ")}]`,
      observed: baseUrl,
    };
  }

  const allowedActions = policy.allowedActions ?? ["navigate", "click", "fill", "select", "assert", "extract"];
  for (const step of artifact.steps) {
    if (!allowedActions.includes(step.action)) {
      return {
        ok: false,
        expected: `step actions in [${allowedActions.join(", ")}]`,
        observed: `step "${step.id}" uses action "${step.action}"`,
      };
    }
  }

  const hasIrreversible = artifact.steps.some((step) => step.risk === "irreversible");
  if (hasIrreversible && !policy.confirmIrreversible) {
    return {
      ok: false,
      expected: "explicit confirmation for a run containing an irreversible step",
      observed: "no confirmation was passed",
    };
  }

  return { ok: true };
}

function checkApproval(artifact: CapabilityArtifact, policy: PolicyConfig): PolicyResult {
  const unattended = policy.unattended ?? true;
  if (!unattended || artifact.capability.status === "approved") {
    return { ok: true };
  }

  if (!policy.allowDraft) {
    return {
      ok: false,
      expected: 'capability.status === "approved" for unattended replay',
      observed: `capability.status === "${artifact.capability.status}"`,
    };
  }

  return {
    ok: true,
    warning: `unattended replay of a non-approved capability (status "${artifact.capability.status}") was explicitly permitted via --allow-draft; this is a dev-only escape hatch`,
  };
}
