/**
 * A deterministic string form of a value: object keys sorted recursively,
 * no incidental whitespace. Two values that are structurally equal produce
 * the same canonical string regardless of source formatting (key order,
 * indentation) — this is what makes content hashing and deep-equality
 * comparisons stable across a YAML file being reformatted.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
