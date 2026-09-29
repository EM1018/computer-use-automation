import type { Sensitivity } from "../schema/capability.js";

// A conservative backstop for value shapes that commonly identify a person
// or account even when the artifact itself didn't tag the field: US SSNs,
// and dash-delimited alphanumeric account-number-style identifiers.
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCOUNT_NUMBER_PATTERN = /\b[A-Z]{2,4}-\d{5,}\b/g;

function placeholder(label: string): string {
  return `[REDACTED:${label}]`;
}

/** Matches a string that IS, in its entirety, one labeled placeholder — e.g. "[REDACTED:account_id]" -> "account_id". Never matches a bare "[REDACTED]" (the old, pre-labeling format; see LEGACY_ANONYMOUS_REDACTED_MARKER) or a placeholder embedded inside a longer string. */
const REDACTED_PLACEHOLDER_PATTERN = /^\[REDACTED:([^\]]+)\]$/;

/** Matches a labeled placeholder ANYWHERE in a string, whole-match or not — for detecting a redacted fragment embedded in a longer value. */
const REDACTED_MARKER_ANYWHERE_PATTERN = /\[REDACTED:[^\]]*\]/;

/** The pre-labeling redaction marker. No longer written by this Redactor, but a transcript recorded before this change may still contain it — see ../compiler/parameterize.ts, which surfaces a specific error pointing at this rather than silently failing to match. */
export const LEGACY_ANONYMOUS_REDACTED_MARKER = "[REDACTED]";

/** Extracts the label from a value that is EXACTLY one redaction placeholder. Returns undefined for anything else — including a value that merely CONTAINS one (see containsRedactionMarker) or the legacy anonymous marker. */
export function redactedLabel(value: string): string | undefined {
  return REDACTED_PLACEHOLDER_PATTERN.exec(value)?.[1];
}

/** True if a labeled redaction placeholder appears anywhere in the string. */
export function containsRedactionMarker(value: string): boolean {
  return REDACTED_MARKER_ANYWHERE_PATTERN.test(value);
}

/**
 * The one chokepoint for redaction. Every writer that persists anything to
 * disk (log writer, evidence writer, any future artifact writer) takes a
 * Redactor in its constructor and scrubs inside write() — there is no path
 * to disk that is allowed to skip it, launch.json included (see
 * EvidenceWriter.writeLaunchInfo in ./evidence.ts).
 *
 * Redaction applies to PERSISTENCE, not TRANSMISSION: the CapabilityResult
 * handed back to the caller is never passed through scrub() — the caller
 * asked for the value. Only what gets written to logs/evidence/artifacts is
 * scrubbed.
 *
 * Placeholders are LABELED — "[REDACTED:account_id]", never a bare
 * "[REDACTED]" — so a reader (human or the compiler, see
 * ../compiler/parameterize.ts) can tell WHICH field a scrubbed value came
 * from without ever seeing the value itself. The label is always an input
 * NAME or a fixed category ("credential", "pii", "account_number"), never
 * anything derived from the value — a label that leaked shape or content of
 * the value it replaces would defeat the point of redacting it.
 */
export class Redactor {
  // value -> label. A Map, not a Set: each registered value now carries an
  // identity, not just a "redact me" flag.
  private readonly sensitiveValues = new Map<string, string>();

  /**
   * Takes just the input DECLARATIONS (name + optional sensitivity tag),
   * not a whole CapabilityArtifact — the only thing this ever needed from
   * one. Generalized so callers that have no artifact at all (discovery has
   * a goal and launch inputs, not a capability yet) can still build a
   * Redactor without constructing a fake one just to satisfy this
   * constructor's shape.
   */
  constructor(
    inputDeclarations: ReadonlyArray<{ name: string; sensitivity?: Sensitivity | undefined }>,
    invocationInputs: Record<string, string | number | boolean>,
  ) {
    for (const input of inputDeclarations) {
      if (input.sensitivity && input.name in invocationInputs) {
        this.registerValue(invocationInputs[input.name], input.name);
      }
    }
  }

  /**
   * Registers a credential or other runtime secret so it is always
   * scrubbed, regardless of the schema. `label` is what a reader of
   * redacted evidence sees in its place — the caller's own input name for a
   * declared input, or a fixed category label ("credential", "pii",
   * "account_number") when there's no input name to attach. Never pass
   * anything derived from `value` itself as the label.
   */
  registerValue(value: string | number | boolean | undefined, label: string): void {
    if (value === undefined) {
      return;
    }
    const str = String(value);
    if (str.length === 0) {
      return;
    }
    this.sensitiveValues.set(str, label);
  }

  scrub<T>(obj: T): T {
    return this.scrubValue(obj) as T;
  }

  private scrubValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.scrubString(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      const label = this.sensitiveValues.get(String(value));
      return label ? placeholder(label) : value;
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
    // Longest secret first: otherwise a short registered value that
    // happens to be a substring of a longer registered value (e.g. both
    // "1" and "10001" registered) could corrupt the longer one's own
    // replacement instead of the longer one winning outright.
    const byLengthDescending = [...this.sensitiveValues.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [secret, label] of byLengthDescending) {
      result = result.split(secret).join(placeholder(label));
    }
    result = result.replace(SSN_PATTERN, placeholder("pii"));
    result = result.replace(ACCOUNT_NUMBER_PATTERN, placeholder("account_number"));
    return result;
  }
}
