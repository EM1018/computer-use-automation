/**
 * Transformation 4 — derive the contract (inputs/outputs).
 *
 * CRITICAL invariant this module exists to protect: it derives TYPES from
 * observed values and then the caller (./driver.ts, ./compile.ts) discards
 * the values — nothing here returns or stores a sample once it has been
 * classified. See ./safety.ts for the belt-and-suspenders check that no raw
 * observed value ends up in the compiled artifact regardless.
 */
import type { Input, Output, Transform, ValueType } from "../schema/capability.js";

/** Infers the output's declared type AND the transform that gets a raw extracted string there — the two are the same decision, so one function makes it once. */
export function inferValueShape(raw: string): { type: ValueType; transform: Transform } {
  const trimmed = raw.trim();
  if (/^[+-]?[$€£]\s?-?[\d,]+(\.\d{1,2})?$/.test(trimmed) || /^-?[\d,]+\.\d{2}$/.test(trimmed)) {
    return { type: "number", transform: "parse_currency" };
  }
  if (/^-?\d+$/.test(trimmed)) {
    return { type: "number", transform: "parse_int" };
  }
  return { type: "string", transform: "trim" };
}

/**
 * Judgment call: a plain run of digits (e.g. "10001") defaults to type
 * "string" with an inferred fixed-width pattern, NOT type "number" — this
 * app's own hand-authored example artifact makes the same call for
 * member_id, and for good reason: an identifier is not a quantity (no
 * caller ever adds two member ids together), and forcing it through
 * `number` would silently drop meaningful shape (leading zeros, a fixed
 * width worth validating via `pattern`). A value with a decimal point is
 * unambiguously numeric and is typed "number" instead.
 */
function inferInputType(raw: string | number | boolean): ValueType {
  if (typeof raw === "boolean") {
    return "boolean";
  }
  if (typeof raw === "number") {
    return "number";
  }
  if (raw === "true" || raw === "false") {
    return "boolean";
  }
  if (/^\d+$/.test(raw)) {
    return "string";
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    return "number";
  }
  return "string";
}

function inferInputPattern(raw: string): string | undefined {
  return /^\d+$/.test(raw) ? `^[0-9]{${raw.length}}$` : undefined;
}

export function deriveInputs(rawInputs: Record<string, string | number | boolean>): Input[] {
  return Object.entries(rawInputs).map(([name, value]) => {
    const type = inferInputType(value);
    const pattern = type === "string" && typeof value === "string" ? inferInputPattern(value) : undefined;
    const input: Input = {
      name,
      type,
      required: true,
      description: `Value supplied for "${name}" at discovery launch; description inferred by the compiler — review before approval.`,
      sensitivity: "pii",
    };
    if (pattern) {
      input.pattern = pattern;
    }
    return input;
  });
}

export function deriveOutputs(outputSamples: ReadonlyMap<string, string>): Output[] {
  return [...outputSamples.entries()].map(([name, sample]) => {
    const { type } = inferValueShape(sample);
    return {
      name,
      type,
      description: `Value captured by the "${name}" extraction step; description inferred by the compiler — review before approval.`,
    };
  });
}
