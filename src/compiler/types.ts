/**
 * Shared types for the compiler pipeline (transcript -> capability
 * artifact). Each transformation lives in its own module (./prune.ts,
 * ./parameterize.ts, ./strategies.ts, ./driver.ts, ./contract.ts,
 * ./outcomes.ts, ./safety.ts, ./diff.ts, ./verify.ts); ./compile.ts wires
 * them together. Nothing here talks to a browser or the filesystem.
 */

/** Thrown for a condition the compiler cannot safely work around — never caught and silently papered over; always surfaces as a non-zero exit. */
export class CompileError extends Error {}
