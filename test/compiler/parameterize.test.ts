import { describe, expect, it } from "vitest";
import { parameterizeActions } from "../../src/compiler/parameterize.js";
import { LEGACY_ANONYMOUS_REDACTED_MARKER } from "../../src/engine/redactor.js";
import { CompileError } from "../../src/compiler/types.js";
import type { DiscoveryAction } from "../../src/schema/discovery.js";

function kept(turn: number, action: DiscoveryAction) {
  return { turn, action };
}

function redacted(label: string): string {
  return `[REDACTED:${label}]`;
}

describe("parameterizeActions", () => {
  it("maps a labeled redaction directly to {{input_name}} — the label IS the mapping", () => {
    const result = parameterizeActions([kept(0, { action: "fill", ref: "e1", value: redacted("member_id") })], { member_id: "10001" });

    expect(result.actions[0]?.artifactValue).toBe("{{member_id}}");
    expect(result.actions[0]?.liveValue).toBe("10001");
    expect(result.parameterizations).toEqual([{ turn: 0, inputName: "member_id", kind: "fill" }]);
  });

  it("maps two DIFFERENT inputs filled in a single flow to the correct placeholders — the case positional mapping got wrong", () => {
    const result = parameterizeActions(
      [
        kept(0, { action: "fill", ref: "e1", value: redacted("account_number") }),
        kept(1, { action: "fill", ref: "e2", value: redacted("member_id") }),
      ],
      { member_id: "10001", account_number: "55555" },
    );

    // Order in the flow is account_number then member_id — the REVERSE of
    // declaration order in `inputs` — so a positional (Nth-fill-consumes-
    // Nth-input) mapping would get this backwards. Label-based mapping
    // can't, because it never looks at position at all.
    expect(result.actions[0]).toMatchObject({ artifactValue: "{{account_number}}", liveValue: "55555" });
    expect(result.actions[1]).toMatchObject({ artifactValue: "{{member_id}}", liveValue: "10001" });
  });

  it("leaves a fill step whose value is a constant (matching no input) as a literal, not parameterized", () => {
    const result = parameterizeActions([kept(0, { action: "fill", ref: "e1", value: "Checking" })], { member_id: "10001" });

    expect(result.actions[0]?.artifactValue).toBe("Checking");
    expect(result.parameterizations).toEqual([]);
    expect(result.literalValuesUsed).toEqual(["Checking"]);
  });

  it("does NOT mangle a value that merely CONTAINS a supplied input as a substring — exact match only", () => {
    const result = parameterizeActions([kept(0, { action: "select", ref: "e1", option: "100010001" })], { member_id: "10001" });

    expect(result.actions[0]?.artifactValue).toBe("100010001");
    expect(result.literalValuesUsed).toEqual(["100010001"]);
  });

  it("exact-matches a navigate URL against a supplied input", () => {
    const result = parameterizeActions([kept(0, { action: "navigate", url: "10001" })], { member_id: "10001" });

    expect(result.actions[0]?.artifactValue).toBe("{{member_id}}");
  });

  it("keeps a click/extract action's non-value fields untouched", () => {
    const result = parameterizeActions(
      [kept(0, { action: "click", ref: "e1" }), kept(1, { action: "extract", ref: "e2", output_name: "balance" })],
      { member_id: "10001" },
    );

    expect(result.actions[0]).toMatchObject({ kind: "click", ref: "e1" });
    expect(result.actions[1]).toMatchObject({ kind: "extract", ref: "e2", outputName: "balance" });
  });

  it("raises CompileError when a redacted label matches no declared input", () => {
    expect(() => parameterizeActions([kept(0, { action: "fill", ref: "e1", value: redacted("member_id") })], {})).toThrow(CompileError);
    expect(() =>
      parameterizeActions([kept(0, { action: "fill", ref: "e1", value: redacted("account_number") })], { member_id: "10001" }),
    ).toThrow(/account_number/);
  });

  it("refuses a value with a redacted fragment embedded in a longer string, rather than embedding it literally", () => {
    expect(() =>
      parameterizeActions([kept(0, { action: "select", ref: "e1", option: `acct-${redacted("member_id")}-x` })], { member_id: "10001" }),
    ).toThrow(CompileError);
  });

  it("raises a specific error for the old, pre-labeling anonymous [REDACTED] format rather than mismapping it", () => {
    expect(() =>
      parameterizeActions([kept(0, { action: "fill", ref: "e1", value: LEGACY_ANONYMOUS_REDACTED_MARKER })], { member_id: "10001" }),
    ).toThrow(/old|legacy|re-run discovery/i);
  });
});
