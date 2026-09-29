/**
 * Transformation 2 — parameterize.
 *
 * The values supplied at discovery launch are KNOWN (the caller of compile
 * supplies them again — see ../compiler/transcript.ts's LaunchInfo), so this
 * is exact-match substitution, never inference. A recorded value becomes
 * `{{input_name}}` only when it is EQUAL to a supplied input's value, never
 * when the input's value merely appears as a substring — substring
 * replacement on a longer literal would mangle it (e.g. an id embedded in a
 * URL path stays a literal URL, not `/member/{{member_id}}`, since that is
 * not what "exact match" means here; a human can always tighten it later).
 *
 * A redacted fill/select/navigate value is a LABELED placeholder —
 * "[REDACTED:member_id]", never a bare "[REDACTED]" (see ../engine/
 * redactor.ts) — so it maps back to its input DIRECTLY, by the label the
 * Redactor itself attached at write time. No inference, no positional
 * guessing: the label names the input this value came from. A redacted
 * label that doesn't match any declared input is a compile error, not a
 * best-effort guess — see resolveValueField below.
 */
import type { DiscoveryAction, RefDescriptor } from "../schema/discovery.js";
import { containsRedactionMarker, LEGACY_ANONYMOUS_REDACTED_MARKER, redactedLabel } from "../engine/redactor.js";
import { CompileError } from "./types.js";

export type CompiledActionKind = "click" | "fill" | "select" | "navigate" | "extract";

export interface CompiledAction {
  turn: number;
  kind: CompiledActionKind;
  ref?: string;
  refDescriptor?: RefDescriptor;
  outputName?: string;
  /** The real value to type/select/navigate to while LIVE-driving verification (../compiler/driver.ts). Never written to the artifact. */
  liveValue?: string;
  /** What the artifact's step.value should be: a `{{template}}` or a literal kept as-is. */
  artifactValue?: string;
  parameterizedFrom?: string;
}

export interface ParameterizationNote {
  turn: number;
  inputName: string;
  kind: CompiledActionKind;
}

export interface ParameterizeResult {
  actions: CompiledAction[];
  parameterizations: ParameterizationNote[];
  /** Literal values kept verbatim in the artifact because they did not match any supplied input (e.g. a fixed dropdown choice) and were never redacted (i.e. never matched a registered secret to begin with). Reported for compile_diff.md. */
  literalValuesUsed: string[];
}

interface KeptAction {
  turn: number;
  action: DiscoveryAction;
  refDescriptor?: RefDescriptor;
}

function exactMatchInput(raw: string, inputs: Record<string, string | number | boolean>): string | undefined {
  for (const [name, value] of Object.entries(inputs)) {
    if (raw === String(value)) {
      return name;
    }
  }
  return undefined;
}

interface ResolvedField {
  artifactValue: string;
  liveValue: string;
  parameterizedFrom?: string;
}

function legacyFormatError(turn: number, kind: string, raw: string): CompileError {
  return new CompileError(
    `turn ${turn}: this ${kind} action's recorded value ("${raw}") uses the OLD anonymous "[REDACTED]" placeholder ` +
      `format, written before redaction placeholders were labeled with the input name they came from. This ` +
      `transcript predates that change and cannot be compiled — re-run discovery to produce a fresh, compilable ` +
      `transcript. See src/compiler/README.md.`,
  );
}

/**
 * Resolves one recorded string value (a fill's value, a select's option, a
 * navigate's URL) to what the artifact should store and what should
 * actually be typed/navigated-to while live-driving verification. Shared
 * across all three because the resolution rule is identical for each:
 * label match -> parameterize, exact literal match -> parameterize,
 * embedded/legacy redaction fragment -> refuse, otherwise -> keep literal.
 */
function resolveValueField(
  turn: number,
  kind: CompiledActionKind,
  raw: string,
  inputs: Record<string, string | number | boolean>,
  parameterizations: ParameterizationNote[],
  literalValuesUsed: string[],
): ResolvedField {
  const label = redactedLabel(raw);
  if (label !== undefined) {
    if (!(label in inputs)) {
      throw new CompileError(
        `turn ${turn}: this ${kind} action's recorded value is redacted with label "${label}", but no supplied input ` +
          `is named "${label}". Supply the same --input values (with the same names) used at discovery launch.`,
      );
    }
    parameterizations.push({ turn, inputName: label, kind });
    return { artifactValue: `{{${label}}}`, liveValue: String(inputs[label]), parameterizedFrom: label };
  }

  if (raw === LEGACY_ANONYMOUS_REDACTED_MARKER || raw.includes(LEGACY_ANONYMOUS_REDACTED_MARKER)) {
    throw legacyFormatError(turn, kind, raw);
  }

  if (containsRedactionMarker(raw)) {
    // A supplied input's value appeared as part of a LONGER string and got
    // substring-redacted (see ../engine/redactor.ts) rather than matching
    // exactly — the placeholder's label is real, but reconstructing the
    // surrounding literal text it was embedded in is not possible from a
    // redacted fragment. Refuse rather than guess.
    throw new CompileError(
      `turn ${turn}: this ${kind} action's recorded value contains a redacted fragment ("${raw}") embedded in a ` +
        `longer string, not an exact match — it cannot be safely reconstructed. See this module's doc comment on ` +
        `why substring replacement is refused.`,
    );
  }

  const exact = exactMatchInput(raw, inputs);
  if (exact !== undefined) {
    parameterizations.push({ turn, inputName: exact, kind });
    return { artifactValue: `{{${exact}}}`, liveValue: raw, parameterizedFrom: exact };
  }

  literalValuesUsed.push(raw);
  return { artifactValue: raw, liveValue: raw };
}

export function parameterizeActions(keptActions: KeptAction[], inputs: Record<string, string | number | boolean>): ParameterizeResult {
  const parameterizations: ParameterizationNote[] = [];
  const literalValuesUsed: string[] = [];

  const actions: CompiledAction[] = keptActions.map(({ turn, action, refDescriptor }) => {
    const refDescriptorField = refDescriptor ? { refDescriptor } : {};
    switch (action.action) {
      case "click":
        return { turn, kind: "click", ref: action.ref, ...refDescriptorField };

      case "extract":
        return { turn, kind: "extract", ref: action.ref, ...refDescriptorField, outputName: action.output_name };

      case "navigate": {
        const { artifactValue, liveValue, parameterizedFrom } = resolveValueField(turn, "navigate", action.url, inputs, parameterizations, literalValuesUsed);
        return { turn, kind: "navigate", artifactValue, liveValue, ...(parameterizedFrom ? { parameterizedFrom } : {}) };
      }

      case "fill": {
        const { artifactValue, liveValue, parameterizedFrom } = resolveValueField(turn, "fill", action.value, inputs, parameterizations, literalValuesUsed);
        return { turn, kind: "fill", ref: action.ref, ...refDescriptorField, artifactValue, liveValue, ...(parameterizedFrom ? { parameterizedFrom } : {}) };
      }

      case "select": {
        const { artifactValue, liveValue, parameterizedFrom } = resolveValueField(turn, "select", action.option, inputs, parameterizations, literalValuesUsed);
        return { turn, kind: "select", ref: action.ref, ...refDescriptorField, artifactValue, liveValue, ...(parameterizedFrom ? { parameterizedFrom } : {}) };
      }

      case "done":
      case "stuck":
        throw new CompileError(`turn ${turn}: "${action.action}" is a discovery-only control signal and should have been filtered out before parameterization`);
    }
  });

  return { actions, parameterizations, literalValuesUsed };
}

/**
 * Parameterizes free-form text — the goal, and anything derived from it
 * (a capability's `title`/`description`, compile_diff.md's own "Goal:"
 * line) — by substring, unlike `resolveValueField` above.
 *
 * This is a DELIBERATELY different rule from step-value parameterization,
 * and for a real reason: a step's `value` is a structured field (exactly
 * what got typed into one form control), where an input's value appearing
 * as a substring of something LONGER is a coincidence worth leaving alone
 * (see this module's own doc comment). Natural-language text has no such
 * structure — a goal like "give me the savings balance for member 10001"
 * legitimately CONTAINS the input value inline, in prose, and there is
 * nothing else it could mean. Left unparameterized, that literal value
 * flows straight into the artifact's `capability.description`/`title` (or
 * compile_diff.md's own Goal line) — a real leak `compile.ts` hit in
 * practice: a natural, ordinary goal phrasing that happened to name the
 * input's value directly tripped `safety.ts`'s assertion. Substring
 * replacement here isn't a compromise of the "exact match only" rule
 * elsewhere; it's the correct rule for this kind of text.
 */
export function parameterizeFreeText(text: string, inputs: Record<string, string | number | boolean>): string {
  let result = text;
  // Longest value first, same reasoning as ../engine/redactor.ts's own
  // scrubString: a short input's value must not corrupt a longer input's
  // value that happens to contain it as a substring.
  const byLengthDescending = Object.entries(inputs).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, value] of byLengthDescending) {
    const str = String(value);
    if (str.length === 0) {
      continue;
    }
    result = result.split(str).join(`{{${name}}}`);
  }
  return result;
}
