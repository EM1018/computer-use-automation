/**
 * Synthesizes `assert` steps with a checkpoint that distinguishes the happy
 * path from a structurally similar branch page — see the module's design
 * rationale in src/compiler/README.md ("Synthesized checkpoints").
 *
 * Two halves, deliberately separated because they run at different times in
 * the pipeline:
 *   - `collectAssertionCandidates` is LIVE: called from ./driver.ts while
 *     the app is already being re-driven for locator derivation, at each
 *     point an assert will be inserted. It only COLLECTS what's observable
 *     on the page right now — it does not decide anything, because at this
 *     point in the pipeline the negative set (what a branch page looks
 *     like) doesn't exist yet; probing (./outcomes.ts) runs AFTER
 *     derivation, using the derived steps to reach those branch pages.
 *   - `pickCheckpoint` is PURE: called from ./compile.ts once probing (or
 *     its absence) is known, to decide which candidate — if any — actually
 *     distinguishes the happy path from every probed branch page.
 */
import type { Page } from "playwright";
import type { AriaRole } from "../engine/locate.js";
import type { Checkpoint, Step } from "../schema/capability.js";
import type { DriveResult, StepDerivation } from "./driver.js";

export interface AssertionCandidate {
  checkpoint: Checkpoint;
  /** What to compare against a branch page's captured signature (see BranchPageSignature) to decide whether this candidate is safe. Not used for `url_matches`, which compares the checkpoint's own pattern against the branch page's URL instead — see survivesBranchPages. */
  distinguishingText: string;
}

export interface BranchPageSignature {
  variantId: string;
  url: string;
  bodyText: string;
}

export type InsertionReason = "before_extract" | "after_final_navigation";

export interface PositionCandidates {
  reason: InsertionReason;
  candidates: AssertionCandidate[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Generic, structure-based guesses at "something a reader would recognize
// this page by" — headings, labels, bold/strong emphasis, table headers.
// Deliberately broad and app-agnostic; the negative-set filter in
// pickCheckpoint is what actually earns the "distinguishes the happy path"
// property, not cleverness here.
const TEXT_CANDIDATE_SELECTORS = ["h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "label", "legend", "caption", "th", "[role=heading]"];
const MAX_CANDIDATE_TEXT_LENGTH = 60;

interface RawTextNode {
  selector: string;
  index: number;
  text: string;
}

async function collectTextCandidates(page: Page): Promise<AssertionCandidate[]> {
  const nodes = await page.evaluate(
    ({ selectors, maxLength }) => {
      const out: { selector: string; index: number; text: string }[] = [];
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        elements.forEach((el, index) => {
          const text = (el.textContent ?? "").trim();
          if (text && text.length <= maxLength) {
            out.push({ selector, index, text });
          }
        });
      }
      return out;
    },
    { selectors: TEXT_CANDIDATE_SELECTORS, maxLength: MAX_CANDIDATE_TEXT_LENGTH },
  );

  const out: AssertionCandidate[] = [];
  for (const node of nodes as RawTextNode[]) {
    // Playwright's own `>> nth=N` chaining, verified unique here the same
    // way every other locator this compiler produces is verified (see
    // ./strategies.ts) — never stored on the strength of a guess.
    const within = `${node.selector} >> nth=${node.index}`;
    const count = await page.locator(within).count().catch(() => 0);
    if (count !== 1) {
      continue;
    }
    out.push({
      checkpoint: { kind: "text_present", pattern: escapeRegExp(node.text), within },
      distinguishingText: node.text,
    });
  }
  return out;
}

interface AriaNodeLite {
  role?: unknown;
  name?: unknown;
  children?: unknown;
}

// Roles worth asserting the PRESENCE of — deliberately a short, generic
// list of "this kind of thing usually names what a page is," not anything
// app-specific.
const INTERESTING_ROLES = new Set(["heading", "button", "link", "status", "alert", "region"]);

async function collectRoleNameCandidates(page: Page): Promise<AssertionCandidate[]> {
  const raw: unknown = await page.ariaSnapshotJSON({ mode: "default" }).catch(() => []);
  const roots = Array.isArray(raw) ? (raw as AriaNodeLite[]) : [];
  const pairs: Array<{ role: string; name: string }> = [];

  const walk = (node: AriaNodeLite): void => {
    const role = typeof node.role === "string" ? node.role : undefined;
    const name = typeof node.name === "string" ? node.name.trim() : undefined;
    if (role && name && INTERESTING_ROLES.has(role) && name.length > 0 && name.length <= MAX_CANDIDATE_TEXT_LENGTH) {
      pairs.push({ role, name });
    }
    const children = Array.isArray(node.children) ? (node.children as AriaNodeLite[]) : [];
    children.forEach(walk);
  };
  roots.forEach(walk);

  const out: AssertionCandidate[] = [];
  for (const { role, name } of pairs) {
    const count = await page
      .getByRole(role as AriaRole, { name, exact: true })
      .count()
      .catch(() => 0);
    if (count !== 1) {
      continue;
    }
    out.push({ checkpoint: { kind: "element_present", role, name }, distinguishingText: name });
  }
  return out;
}

/**
 * A `url_matches` candidate must not hardcode the specific input value used
 * during THIS derivation run — replay invokes the same artifact with
 * DIFFERENT values, so a literal id baked into the pattern would only ever
 * match this one run. Generalizes by replacing any exact occurrence of a
 * declared input's current value in the path with a generic segment
 * wildcard, same "exact match only" discipline as ../compiler/
 * parameterize.ts (never a partial/substring replace).
 *
 * Deliberately NOT anchored with `^...$`: the engine tests a `url_matches`
 * checkpoint's pattern against the FULL current URL, host included (see
 * checkpointMatches in ../engine/detect.ts — `page.url()`, not
 * `page.url().pathname`), and this module's own negative-set check
 * (survivesBranchPages, below) does the same against a branch page's full
 * URL. Anchoring a pathname-only pattern would never match either. Same
 * substring-match convention the rest of the codebase already uses for
 * `url_matches` (see deriveResumeContract in ../engine/escalation.ts).
 */
function generalizeUrlPattern(currentUrl: string, inputs: Record<string, string | number | boolean>): string {
  const url = new URL(currentUrl);
  let pattern = escapeRegExp(url.pathname);
  for (const raw of Object.values(inputs).map(String)) {
    if (raw.length === 0) {
      continue;
    }
    const escaped = escapeRegExp(raw);
    if (pattern.includes(escaped)) {
      pattern = pattern.split(escaped).join("[^/]+");
    }
  }
  return pattern;
}

/** Collects every candidate the compiler is willing to consider at one insertion point, from the LIVE page, in priority order (text_present, then element_present, then url_matches — see pickCheckpoint). Pure data collection: no decision is made here. */
export async function collectAssertionCandidates(page: Page, inputs: Record<string, string | number | boolean>): Promise<AssertionCandidate[]> {
  const [textCandidates, roleCandidates] = await Promise.all([collectTextCandidates(page), collectRoleNameCandidates(page)]);
  const urlPattern = generalizeUrlPattern(page.url(), inputs);
  const urlCandidate: AssertionCandidate = {
    checkpoint: { kind: "url_matches", pattern: urlPattern },
    distinguishingText: urlPattern,
  };
  return [...textCandidates, ...roleCandidates, urlCandidate];
}

function survivesBranchPages(candidate: AssertionCandidate, branchPages: BranchPageSignature[]): boolean {
  for (const branch of branchPages) {
    if (candidate.checkpoint.kind === "url_matches") {
      if (new RegExp(candidate.checkpoint.pattern).test(branch.url)) {
        return false;
      }
      continue;
    }
    // A substring check on the branch page's full visible text — a
    // deliberately CONSERVATIVE approximation for element_present
    // candidates too (whose real distinguishing signal is role+name, not
    // just visible text): it can over-reject a candidate that would
    // actually have been fine, but it can never accept one that collides
    // with a branch page, which is the property that actually matters
    // here. See src/compiler/README.md's "Judgment calls".
    if (branch.bodyText.includes(candidate.distinguishingText)) {
      return false;
    }
  }
  return true;
}

export interface CheckpointDecision {
  checkpoint?: Checkpoint;
  /** Set only when no candidate survived — the honest "could not derive a safe checkpoint here" note. */
  note?: string;
}

/**
 * Picks the first candidate, in priority order, that does not ALSO appear
 * on any probed branch page. Priority (semantic first, same reasoning as
 * ../compiler/strategies.ts's locator ranking): a scoped text_present,
 * then a role+name element_present, then url_matches last — url_matches is
 * the weakest signal precisely because legacy apps often reuse the same
 * URL shape across branch pages (e.g. a permission-denied page that still
 * renders at /member/<id>, same as the happy path).
 */
export function pickCheckpoint(candidates: AssertionCandidate[], branchPages: BranchPageSignature[]): CheckpointDecision {
  const byPriority = [
    ...candidates.filter((c) => c.checkpoint.kind === "text_present"),
    ...candidates.filter((c) => c.checkpoint.kind === "element_present"),
    ...candidates.filter((c) => c.checkpoint.kind === "url_matches"),
  ];
  for (const candidate of byPriority) {
    if (survivesBranchPages(candidate, branchPages)) {
      return { checkpoint: candidate.checkpoint };
    }
  }
  return {
    note:
      branchPages.length > 0
        ? "no candidate assertion distinguished the happy path from every probed branch page — every observable candidate also appeared on at least one of them. Emitted without a checkpoint; author one by hand before approving."
        : "no candidate assertion could be derived from the live page at all (no distinctive text, role+name, or usable URL shape found). Emitted without a checkpoint; author one by hand before approving.",
  };
}

function describeReason(reason: InsertionReason): string {
  return reason === "before_extract" ? "before an extract step" : "after the flow's final navigation";
}

export interface SynthesizedCheckpointReport {
  stepId: string;
  reason: InsertionReason;
  checkpoint?: Checkpoint;
  candidatesConsidered: number;
}

export interface SynthesizeResult {
  steps: Step[];
  derivations: StepDerivation[];
  notes: string[];
  synthesized: SynthesizedCheckpointReport[];
}

/**
 * Splices synthesized assert steps into the derived step array at the
 * positions `driveAndDeriveSteps` marked, deciding each one's checkpoint
 * via `pickCheckpoint` now that probe data (or its documented absence) is
 * known, then renumbers every step's id sequentially — insertion shifts
 * everything after it, so ids assigned during derivation can't be trusted
 * anymore.
 *
 * `derivations` (../compiler/driver.ts's per-step locator-derivation
 * report, used by ../compiler/diff.ts) only ever has one entry per
 * NON-navigate step — navigate steps never got one to begin with, since
 * they have no locator to derive — so it's walked in lockstep with `steps`
 * while skipping navigate steps, not by matching array index directly.
 */
export function synthesizeAssertSteps(
  drive: Pick<DriveResult, "steps" | "derivations" | "candidatesByPosition">,
  branchPages: BranchPageSignature[],
  probeRan: boolean,
): SynthesizeResult {
  const notes: string[] = [];
  const synthesized: SynthesizedCheckpointReport[] = [];
  const finalSteps: Step[] = [];
  const finalDerivations: StepDerivation[] = [];

  function insertAssertIfAny(position: number): void {
    const entry = drive.candidatesByPosition.get(position);
    if (!entry) {
      return;
    }
    const decision = pickCheckpoint(entry.candidates, branchPages);
    if (decision.note) {
      notes.push(`synthesized assert (${describeReason(entry.reason)}): ${decision.note}`);
    }
    const id = `s${finalSteps.length + 1}`;
    const step: Step = {
      id,
      action: "assert",
      risk: "safe",
      on_fail: "evaluate_outcomes",
      ...(decision.checkpoint ? { checkpoint: decision.checkpoint, wait: { for: "element_present", timeout_ms: 5000 } } : {}),
    };
    finalSteps.push(step);
    synthesized.push({ stepId: id, reason: entry.reason, ...(decision.checkpoint ? { checkpoint: decision.checkpoint } : {}), candidatesConsidered: entry.candidates.length });
  }

  insertAssertIfAny(0);
  let derivationIndex = 0;
  drive.steps.forEach((originalStep, index) => {
    const id = `s${finalSteps.length + 1}`;
    finalSteps.push({ ...originalStep, id });
    if (originalStep.action !== "navigate") {
      const matchingDerivation = drive.derivations[derivationIndex];
      derivationIndex += 1;
      if (matchingDerivation) {
        finalDerivations.push({ ...matchingDerivation, stepId: id });
      }
    }
    insertAssertIfAny(index + 1);
  });

  if (!probeRan && synthesized.length > 0) {
    notes.push(
      "probing did not run (--no-probe, or hand-declared outcomes were supplied instead), so synthesized checkpoints were derived from the live page ALONE, with no branch-page negative set to validate them against — review them before approving.",
    );
  }

  return { steps: finalSteps, derivations: finalDerivations, notes, synthesized };
}
