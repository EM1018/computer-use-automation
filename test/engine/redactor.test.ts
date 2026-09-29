import { describe, expect, it } from "vitest";
import { Redactor, redactedLabel, containsRedactionMarker, LEGACY_ANONYMOUS_REDACTED_MARKER } from "../../src/engine/redactor.js";

describe("Redactor", () => {
  it("emits a LABELED placeholder, and the label is the input name", () => {
    const redactor = new Redactor([{ name: "member_id", sensitivity: "pii" }], { member_id: "10001" });

    const scrubbed = redactor.scrub({ value: "10001" });

    expect(scrubbed).toEqual({ value: "[REDACTED:member_id]" });
    expect(redactedLabel(scrubbed.value)).toBe("member_id");
  });

  it("a label never contains any part of the redacted value, even one that would be recognizable if leaked", () => {
    // A value that LOOKS like it could end up embedded in a naive label
    // (e.g. if a label were ever derived from the value's shape or a
    // truncated form of it) — this asserts the label is always exactly the
    // caller-supplied identity, nothing value-derived.
    const recognizableValue = "555-12-9999-ACCT-SECRET-XYZ";
    const redactor = new Redactor([{ name: "account_token", sensitivity: "secret" }], { account_token: recognizableValue });

    const scrubbed = redactor.scrub({ note: `token was ${recognizableValue} at the time` }) as { note: string };

    expect(scrubbed.note).not.toContain(recognizableValue);
    expect(scrubbed.note).not.toContain("555-12-9999");
    expect(scrubbed.note).not.toContain("SECRET");
    expect(scrubbed.note).toBe("token was [REDACTED:account_token] at the time");
  });

  it("uses category labels (not an input name) for credentials and regex-backstop matches", () => {
    const redactor = new Redactor([], {});
    redactor.registerValue("hunter2", "credential");

    const scrubbed = redactor.scrub({ password: "hunter2", ssn: "123-45-6789", account: "AB-12345" }) as Record<string, string>;

    expect(scrubbed["password"]).toBe("[REDACTED:credential]");
    expect(scrubbed["ssn"]).toBe("[REDACTED:pii]");
    expect(scrubbed["account"]).toBe("[REDACTED:account_number]");
  });

  it("does not redact a value that was never registered", () => {
    const redactor = new Redactor([{ name: "member_id", sensitivity: "pii" }], { member_id: "10001" });
    expect(redactor.scrub({ value: "unrelated text" })).toEqual({ value: "unrelated text" });
  });

  it("only redacts inputs the caller marked sensitive", () => {
    const redactor = new Redactor([{ name: "currency" }], { currency: "USD" });
    expect(redactor.scrub({ value: "USD" })).toEqual({ value: "USD" });
  });

  it("redactedLabel only matches a value that IS, wholly, one placeholder", () => {
    expect(redactedLabel("[REDACTED:member_id]")).toBe("member_id");
    expect(redactedLabel("prefix-[REDACTED:member_id]-suffix")).toBeUndefined();
    expect(redactedLabel(LEGACY_ANONYMOUS_REDACTED_MARKER)).toBeUndefined();
    expect(redactedLabel("plain text")).toBeUndefined();
  });

  it("containsRedactionMarker detects an embedded placeholder even when it's not the whole string", () => {
    expect(containsRedactionMarker("[REDACTED:member_id]")).toBe(true);
    expect(containsRedactionMarker("acct-[REDACTED:member_id]-x")).toBe(true);
    expect(containsRedactionMarker("plain text")).toBe(false);
  });

  it("a longer registered secret is not corrupted by a shorter one that is its substring", () => {
    const redactor = new Redactor([], {});
    redactor.registerValue("1", "short_id");
    redactor.registerValue("10001", "member_id");

    expect(redactor.scrub({ value: "10001" })).toEqual({ value: "[REDACTED:member_id]" });
  });
});
