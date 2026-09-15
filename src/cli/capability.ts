#!/usr/bin/env node
import { approveCapability } from "../approval.js";

function parseVersion(spec: string): { major: number; minor: number } {
  const [majorStr, minorStr] = spec.split(".");
  const major = Number.parseInt(majorStr ?? "", 10);
  const minor = Number.parseInt(minorStr ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`invalid version "${spec}", expected <major>.<minor>`);
  }
  return { major, minor };
}

function runApprove(args: string[]): void {
  const [id, versionSpec, ...rest] = args;
  if (!id || !versionSpec) {
    throw new Error("usage: capability approve <id> <major>.<minor> --approver <name>");
  }
  let approver: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--approver") {
      approver = rest[i + 1];
      i += 1;
    }
  }
  if (!approver) {
    throw new Error("--approver <name> is required");
  }

  const { major, minor } = parseVersion(versionSpec);
  const result = approveCapability(id, major, minor, approver);
  if (!result.ok) {
    console.error(`refused: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`approved: ${id}@${major}.${minor} -> ${result.path} (content_hash ${result.contentHash})`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "approve") {
    runApprove(rest);
    return;
  }
  throw new Error("usage: capability <approve> ...");
}

try {
  main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
