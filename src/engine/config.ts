/**
 * Configuration shapes for the engine. Nothing here is specific to any one
 * target app: AppConfig carries whatever a *caller* needs to authenticate
 * against its own app, and PolicyConfig carries whatever a *caller* needs to
 * gate what the engine is allowed to do. The engine itself only reads these
 * values; it never hardcodes them.
 */

export interface AppConfig {
  /** Origin the session should be authenticated against, e.g. "http://127.0.0.1:5001". */
  baseUrl: string;
  /** Path to the login page, relative to baseUrl. */
  loginPath: string;
  /** Locator strategy for the login form's username field. */
  usernameSelector: string;
  /** Locator strategy for the login form's password field. */
  passwordSelector: string;
  /** Locator strategy for the login form's submit control. */
  submitSelector: string;
  /** Run with a visible browser window. Defaults to true — required for human hand-off. */
  headless?: boolean;
  /** Milliseconds of artificial delay Playwright inserts between operations, for a human to watch along. */
  slowMoMs?: number;
}

export interface PolicyConfig {
  /** base_url values the engine is permitted to operate against. */
  allowedBaseUrls: string[];
  /** Action types the engine is permitted to execute. Defaults to all declared actions. */
  allowedActions?: string[];
  /**
   * Must be explicitly true for automation to execute a risk: "irreversible"
   * step unattended. Checked at the moment the engine is about to run that
   * step (not at preflight, before any browser exists) — see the
   * "policy_block" escalation trigger in ./escalation.ts — because refusing
   * it needs to hand a human the same live, already-authenticated session,
   * which preflight cannot do since no session exists yet at that point.
   */
  confirmIrreversible?: boolean;
  /** Unattended runs require capability.status === "approved". Defaults to true. */
  unattended?: boolean;
  /** Dev-only escape hatch: permits an unattended run of a non-approved (draft) artifact. Defaults to false. */
  allowDraft?: boolean;
  /**
   * Elements discovery must refuse to act on unless `confirmIrreversible` is
   * set — declarative, matched by accessible role/name against whatever the
   * live accessibility snapshot says, since discovery has no artifact
   * step.risk to key off yet (that's assigned later, by the not-yet-built
   * compiler). Matched by src/discovery/policy.ts; unused by replay, which
   * has its own artifact-step-level check in ./policy.ts.
   */
  irreversibleTargets?: IrreversibleTargetPattern[];
}

export interface IrreversibleTargetPattern {
  /** Accessible role to match, e.g. "button". Omit to match any role. */
  role?: string;
  /** Regex (as a string) tested against the accessible name. Omit to match any name. */
  namePattern?: string;
}

/** Ceiling on total recoverable applications across an entire run, regardless of which recoverable. */
export const GLOBAL_RECOVERY_CAP = 5;

/**
 * How long a session may sit in PENDING_INTERVENTION (escalated, but no
 * human has claimed it yet) before the run is terminated. Sessions that
 * never die are a real production problem, so this always has a value.
 */
export const DEFAULT_PENDING_INTERVENTION_TTL_MS = 15 * 60 * 1000;

/** How long a session may sit in HUMAN_CONTROL before the run is failed and the session closed. */
export const DEFAULT_HUMAN_CONTROL_TTL_MS = 60 * 60 * 1000;

export interface EscalationTtlConfig {
  pendingInterventionTtlMs: number;
  humanControlTtlMs: number;
}

export const DEFAULT_ESCALATION_TTL: EscalationTtlConfig = {
  pendingInterventionTtlMs: DEFAULT_PENDING_INTERVENTION_TTL_MS,
  humanControlTtlMs: DEFAULT_HUMAN_CONTROL_TTL_MS,
};
