import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The engine is a generic interpreter: it knows about steps, strategies,
// checkpoints, and outcomes as shapes, never about what any particular
// artifact's fields mean. This test enforces that mechanically rather than
// by convention — engine, discovery, operator, and CLI source must never
// mention the business domain the example artifact happens to target.
// Discovery is held to the same standard for the same reason replay is: it
// operates against a goal and a live page, never hardcoded knowledge of
// what a "member" or "balance" is. (cli/discover.ts's hardcoded
// irreversibleTargets pattern, "Close Account", is app WIRING — like
// cli/replay.ts's login selectors — not business-domain knowledge, and
// doesn't trip this list anyway.)
const FORBIDDEN_WORDS = ["member", "balance", "savings", "credit union"];
const SCAN_ROOTS = [
  join(process.cwd(), "src", "engine"),
  join(process.cwd(), "src", "cli"),
  join(process.cwd(), "src", "discovery"),
  join(process.cwd(), "src", "operator"),
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("engine stays a generic interpreter", () => {
  it("contains no domain-specific words outside test fixtures", () => {
    const files = SCAN_ROOTS.flatMap(listTsFiles);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8").toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        if (content.includes(word)) {
          offenders.push(`${file} contains "${word}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
