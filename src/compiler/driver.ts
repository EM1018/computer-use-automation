/**
 * Drives a live page through the pruned, parameterized action sequence,
 * deriving and verifying locator strategies for each ref-targeting action
 * (Transformation 3) as it goes, and assembling the final Step[] a
 * CapabilityArtifact needs. This is the one place discovery's turn-by-turn
 * refs get turned into replay's durable strategies.
 *
 * Advancing the page between steps reuses the engine's OWN action-executing
 * primitives (performClick/performFill/performSelect/readText from
 * ../engine/replay.ts) — never a second, parallel Playwright automation
 * path — so the state reached while deriving step N+1's locators is exactly
 * the state replay itself would reach after executing step N.
 *
 * This module also COLLECTS (but does not decide) checkpoint candidates —
 * see ./checkpoints.ts. It's the natural place to do so: this is already
 * the one live re-drive of the happy path, so grabbing "what's observable
 * on the page right now" at each assert-insertion point costs nothing
 * extra. The DECISION (which candidate, if any, actually distinguishes the
 * happy path from a branch page) happens later in ./compile.ts, once
 * probing has run — see ./checkpoints.ts's module doc comment for why that
 * split is unavoidable.
 */
import type { Page } from "playwright";
import type { Step, Strategy, Wait } from "../schema/capability.js";
import { buildLocator, resolveFrameScope, type ResolvedTarget } from "../engine/locate.js";
import { performClick, performFill, performSelect, readText } from "../engine/replay.js";
import { generateCandidates, verifyCandidates, frameSelectorFor } from "./strategies.js";
import { collectAssertionCandidates, type InsertionReason, type PositionCandidates } from "./checkpoints.js";
import { inferValueShape } from "./contract.js";
import type { CompiledAction } from "./parameterize.js";
import { CompileError } from "./types.js";

export interface StepDerivation {
  stepId: string;
  turn: number;
  action: CompiledAction["kind"];
  candidatesGenerated: Strategy[];
  candidatesVerified: Strategy[];
  candidatesDiscarded: Array<{ strategy: Strategy; reason: string }>;
  zeroVerified: boolean;
}

export interface DriveResult {
  steps: Step[];
  derivations: StepDerivation[];
  /** output_name -> observed sample text. Transient by contract: the caller must classify (../compiler/contract.ts) and then discard — never serialize this map itself. */
  outputSamples: Map<string, string>;
  notes: string[];
  /** Keyed by position in `steps` (0..steps.length, where steps.length means "append at the very end") — where a synthesized assert step should be inserted, and what it could assert. Decided later by ../compiler/checkpoints.ts's pickCheckpoint, once probe data (or its absence) is known. */
  candidatesByPosition: Map<number, PositionCandidates>;
}

function rankVerified(candidates: Array<{ strategy: Strategy; verified: boolean }>): Strategy[] {
  return candidates.filter((c) => c.verified).map((c) => c.strategy);
}

const NAVIGATION_TIMEOUT_MS = 10000;
const ELEMENT_PRESENT_TIMEOUT_MS = 5000;

/** True for an action that causes a page navigation — a `navigate`, or a click/select the transcript recorded a page change for. Mirrors the same `page_changed` signal used to decide a step's own `wait`. */
function isNavigational(action: CompiledAction, pageChangedByTurn: ReadonlyMap<number, boolean>): boolean {
  if (action.kind === "navigate") {
    return true;
  }
  return (action.kind === "click" || action.kind === "select") && (pageChangedByTurn.get(action.turn) ?? false);
}

/**
 * Assert-insertion points, per the spec: immediately before each `extract`
 * step, AND after the flow's final navigational step (covering a flow that
 * doesn't end in extract at all — e.g. one that just needs to confirm it
 * landed on the right confirmation page). Expressed as positions in the
 * eventual step array (0..actions.length, where actions.length means
 * "append at the end") — a Set, so the common case (final navigation is
 * immediately followed by an extract) naturally collapses to one insertion
 * point instead of two.
 */
function computeInsertionPoints(actions: CompiledAction[], pageChangedByTurn: ReadonlyMap<number, boolean>): Set<number> {
  const points = new Set<number>();
  actions.forEach((action, index) => {
    if (action.kind === "extract") {
      points.add(index);
    }
  });
  let lastNavigationalIndex = -1;
  actions.forEach((action, index) => {
    if (isNavigational(action, pageChangedByTurn)) {
      lastNavigationalIndex = index;
    }
  });
  if (lastNavigationalIndex >= 0) {
    points.add(lastNavigationalIndex + 1);
  }
  return points;
}

function reasonFor(position: number, actions: CompiledAction[]): InsertionReason {
  return position < actions.length && actions[position]?.kind === "extract" ? "before_extract" : "after_final_navigation";
}

export async function driveAndDeriveSteps(
  page: Page,
  actions: CompiledAction[],
  baseUrl: string,
  pageChangedByTurn: ReadonlyMap<number, boolean>,
  inputs: Record<string, string | number | boolean>,
): Promise<DriveResult> {
  const steps: Step[] = [];
  const derivations: StepDerivation[] = [];
  const outputSamples = new Map<string, string>();
  const notes: string[] = [];
  const candidatesByPosition = new Map<number, PositionCandidates>();
  const insertionPoints = computeInsertionPoints(actions, pageChangedByTurn);

  async function captureIfNeeded(position: number): Promise<void> {
    if (!insertionPoints.has(position)) {
      return;
    }
    const candidates = await collectAssertionCandidates(page, inputs);
    candidatesByPosition.set(position, { reason: reasonFor(position, actions), candidates });
  }

  await captureIfNeeded(0);

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action) continue;
    const id = `s${index + 1}`;

    if (action.kind === "navigate") {
      const value = action.artifactValue ?? "/";
      steps.push({ id, action: "navigate", value, risk: "safe", wait: { for: "navigation", timeout_ms: NAVIGATION_TIMEOUT_MS } });
      await page.goto(new URL(action.liveValue ?? value, baseUrl).toString(), { waitUntil: "load" });
      await captureIfNeeded(index + 1);
      continue;
    }

    const descriptor = action.refDescriptor;
    if (!descriptor) {
      throw new CompileError(`turn ${action.turn}: ${action.kind} action has no ref descriptor recorded in refs.jsonl — cannot derive a locator for it`);
    }

    const frameSelector = frameSelectorFor(descriptor.frame);
    const scope = resolveFrameScope(page, frameSelector);
    const generated = generateCandidates(descriptor);
    const verified = await verifyCandidates(scope, generated);
    const verifiedStrategies = rankVerified(verified);
    const discarded = verified
      .filter((candidate) => !candidate.verified)
      .map((candidate) => ({ strategy: candidate.strategy, reason: candidate.reason ?? "discarded" }));

    let finalStrategies = verifiedStrategies;
    const zeroVerified = finalStrategies.length === 0;
    if (zeroVerified) {
      const fallback = generated[0];
      if (!fallback) {
        throw new CompileError(
          `turn ${action.turn}: ref "${descriptor.ref}" (role "${descriptor.role}") has no candidate locator strategies at all — no accessible name, no label, no stable attribute, no nearby text. This step cannot be compiled.`,
        );
      }
      notes.push(
        `step "${id}" (turn ${action.turn}, ${action.kind}): ZERO candidate strategies verified against the live page. ` +
          `Falling back to the unverified "${fallback.kind}" candidate so the artifact stays schema-valid — this step is ` +
          `NOT expected to replay reliably, and mandatory verification will very likely fail on it. Needs manual authoring review before approval.`,
      );
      finalStrategies = [{ ...fallback, confidence: "low" }];
    }

    const target = { frame: frameSelector, strategies: finalStrategies };
    const winner = finalStrategies[0];
    if (!winner) {
      throw new CompileError(`turn ${action.turn}: internal error — target has no strategies after derivation`);
    }
    if (winner.kind === "coordinates") {
      throw new CompileError(`turn ${action.turn}: internal error — derived a coordinates strategy, which the compiler never generates`);
    }
    const winnerLocator = buildLocator(scope, winner);
    const resolved: ResolvedTarget = { kind: "locator", locator: winnerLocator, strategyIndex: 0, strategyKind: winner.kind };

    const pageChanged = pageChangedByTurn.get(action.turn) ?? false;
    const navigationWait: Wait | undefined = pageChanged ? { for: "navigation", timeout_ms: NAVIGATION_TIMEOUT_MS } : undefined;

    // A zero-verified fallback is, by definition, not known to resolve to
    // anything real — actually performing the action against it would hang
    // against Playwright's actionability timeout for no benefit (there is
    // nothing reliable to click/fill/read). Skip live-executing it: the
    // step still gets recorded (with its note), but subsequent steps are
    // derived from whatever page state already existed, on a best-effort
    // basis, rather than blocking the whole compile on an already-known-bad
    // step.
    if (zeroVerified) {
      if (action.kind === "click") {
        steps.push({ id, action: "click", target, risk: "safe", ...(navigationWait ? { wait: navigationWait } : {}) });
      } else if (action.kind === "fill") {
        steps.push({ id, action: "fill", target, value: action.artifactValue, risk: "safe" });
      } else if (action.kind === "select") {
        steps.push({ id, action: "select", target, value: action.artifactValue, risk: "safe", ...(navigationWait ? { wait: navigationWait } : {}) });
      } else {
        steps.push({ id, action: "extract", target, into: action.outputName, transform: "trim", risk: "safe", wait: { for: "element_present", timeout_ms: ELEMENT_PRESENT_TIMEOUT_MS } });
      }
    } else if (action.kind === "click") {
      await Promise.all([page.waitForLoadState("load", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined), performClick(page, resolved)]);
      steps.push({ id, action: "click", target, risk: "safe", ...(navigationWait ? { wait: navigationWait } : {}) });
    } else if (action.kind === "fill") {
      await performFill(resolved, action.liveValue ?? "");
      steps.push({ id, action: "fill", target, value: action.artifactValue, risk: "safe" });
    } else if (action.kind === "select") {
      await performSelect(resolved, action.liveValue ?? "");
      steps.push({ id, action: "select", target, value: action.artifactValue, risk: "safe", ...(navigationWait ? { wait: navigationWait } : {}) });
    } else if (action.kind === "extract") {
      const raw = await readText(page, resolved);
      if (action.outputName) {
        outputSamples.set(action.outputName, raw);
      }
      const { transform } = inferValueShape(raw);
      steps.push({
        id,
        action: "extract",
        target,
        into: action.outputName,
        transform,
        risk: "safe",
        wait: { for: "element_present", timeout_ms: ELEMENT_PRESENT_TIMEOUT_MS },
      });
    }

    derivations.push({
      stepId: id,
      turn: action.turn,
      action: action.kind,
      candidatesGenerated: generated,
      candidatesVerified: verifiedStrategies,
      candidatesDiscarded: discarded,
      zeroVerified,
    });

    await captureIfNeeded(index + 1);
  }

  return { steps, derivations, outputSamples, notes, candidatesByPosition };
}
