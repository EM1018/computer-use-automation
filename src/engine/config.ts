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
  /** Must be explicitly true for a run containing any risk: "irreversible" step to proceed. */
  confirmIrreversible?: boolean;
  /** Unattended runs require capability.status === "approved". Defaults to true. */
  unattended?: boolean;
  /** Dev-only escape hatch: permits an unattended run of a non-approved (draft) artifact. Defaults to false. */
  allowDraft?: boolean;
}

/** Ceiling on total recoverable applications across an entire run, regardless of which recoverable. */
export const GLOBAL_RECOVERY_CAP = 5;
