import type { CapabilityArtifact } from "../schema/capability.js";

// A conservative backstop for value shapes that commonly identify a person
// or account even when the artifact itself didn't tag the field: US SSNs,
// and dash-delimited alphanumeric account-number-style identifiers.
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCOUNT_NUMBER_PATTERN = /\b[A-Z]{2,4}-\d{5,}\b/g;

const REDACTED = "[REDACTED]";

/**
 * The one chokepoint for redaction. Every writer that persists anything to
 * disk (log writer, evidence writer, any future artifact writer) takes a
 * Redactor in its constructor and scrubs inside write() — there is no path
 * to disk that is allowed to skip it.
 *
 * Redaction applies to PERSISTENCE, not TRANSMISSION: the CapabilityResult
 * handed back to the caller is never passed through scrub() — the caller
 * asked for the value. Only what gets written to logs/evidence/artifacts is
 * scrubbed.
 */
export class Redactor {
  private readonly sensitiveValues: Set<string>;

  constructor(artifact: CapabilityArtifact, invocationInputs: Record<string, string | number | boolean>) {
    this.sensitiveValues = new Set<string>();

    for (const input of artifact.inputs) {
      if (input.sensitivity && input.name in invocationInputs) {
        this.registerValue(invocationInputs[input.name]);
      }
    }
  }

  /** Registers a credential or other runtime secret so it is always scrubbed, regardless of the schema. */
  registerValue(value: string | number | boolean | undefined): void {
    if (value === undefined) {
      return;
    }
    this.sensitiveValues.add(String(value));
  }

  scrub<T>(obj: T): T {
    return this.scrubValue(obj) as T;
  }

  private scrubValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.scrubString(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return this.sensitiveValues.has(String(value)) ? REDACTED : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.scrubValue(item));
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.scrubValue(val);
      }
      return result;
    }
    return value;
  }

  private scrubString(input: string): string {
    let result = input;
    for (const secret of this.sensitiveValues) {
      if (secret.length === 0) {
        continue;
      }
      result = result.split(secret).join(REDACTED);
    }
    result = result.replace(SSN_PATTERN, REDACTED);
    result = result.replace(ACCOUNT_NUMBER_PATTERN, REDACTED);
    return result;
  }
}
