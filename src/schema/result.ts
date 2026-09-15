/**
 * Terminal states returned by the replay engine for a single capability
 * invocation. Exactly one of these is produced per run.
 *
 * `BusinessOutcomeResult["status"]` is intentionally a plain `string`: its
 * value is whatever `returns.status` the artifact's own `outcomes` declare
 * (e.g. "member_not_found"), which is not known at compile time. Because of
 * that it cannot be a literal in the union's discriminant the way the other
 * four branches are. Narrow in this order instead:
 *
 *   if (result.status === "success") { ... }
 *   else if (result.status === "failed") { ... }
 *   else if (result.status === "escalated") { ... }
 *   else if (result.status === "invalid_input") { ... }
 *   else { // business outcome; result.status is the artifact-defined id
 *     const outcome: BusinessOutcomeResult = result;
 *   }
 *
 * i.e. check the four reserved literal statuses first — anything left over
 * is a business outcome.
 */

export interface SuccessResult {
  status: "success";
  outputs: Record<string, string | number | boolean>;
  run_id: string;
  steps_executed: number;
  duration_ms: number;
}

export interface BusinessOutcomeResult {
  status: string;
  outcome_id: string;
  message?: string;
  run_id: string;
}

export interface Evidence {
  screenshot?: string;
  html_snapshot?: string;
}

export interface FailedResult {
  status: "failed";
  failed_step: string;
  expected: string;
  observed: string;
  evidence: Evidence;
  run_id: string;
}

export interface EscalatedResult {
  status: "escalated";
  intervention_id: string;
  reason: string;
  resumable: boolean;
  run_id: string;
}

export interface InvalidInputError {
  path: string;
  message: string;
}

export interface InvalidInputResult {
  status: "invalid_input";
  errors: InvalidInputError[];
}

export type CapabilityResult =
  | SuccessResult
  | BusinessOutcomeResult
  | FailedResult
  | EscalatedResult
  | InvalidInputResult;
