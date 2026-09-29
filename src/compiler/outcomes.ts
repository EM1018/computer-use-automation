/**
 * Outcomes and recoverables — be honest about provenance.
 *
 * The happy-path transcript never encounters "no such member", so these
 * cannot be derived from it. This module re-drives the ALREADY-COMPILED
 * steps (verified strategies and all) with alternate inputs and query
 * flags, using the same engine primitives the main derivation driver uses,
 * and inspects what the app actually rendered when something diverged from
 * the happy path. Detection is scoped with `within` a specific container —
 * never a page-wide text match — found generically (by attribute/role
 * pattern, not any app-specific class name) so this stays reusable across
 * apps: see findDistinguishingContainer/findRecoveryButton below.
 *
 * When probing is skipped (--no-probe) and no hand-declared outcomes file is
 * supplied, this module is simply never called — ./compile.ts records a
 * compiler_note instead of fabricating placeholder outcomes nobody actually
 * declared. See src/compiler/README.md's "Judgment calls" section.
 */
import type { Browser, Page } from "playwright";
import type { AppConfig } from "../engine/config.js";
import { SessionFactory } from "../engine/session.js";
import type { Outcome, Recoverable, Step } from "../schema/capability.js";
import { buildLocator, resolveFrameScope, type ResolvedTarget } from "../engine/locate.js";
import { performClick, performFill, performSelect } from "../engine/replay.js";
import type { BranchPageSignature } from "./checkpoints.js";

export interface ProbeVariant {
  id: string;
  description: string;
  inputOverrides?: Record<string, string | number | boolean>;
  /** Appended to the first navigate step's URL as a query flag, e.g. "interstitial=1". */
  queryFlag?: string;
  kind: "business_outcome" | "recoverable_interstitial" | "recoverable_expired";
}

export interface ProbeResult {
  outcomes: Outcome[];
  recoverables: Recoverable[];
  /** Raw values used only during probing (e.g. an alternate id) — fed into ../compiler/safety.ts's assertion alongside the main run's inputs. */
  sensitiveValuesUsed: string[];
  notes: string[];
  /** Every probed variant's landing page (url + visible text), regardless of what kind of variant it was — the negative set ../compiler/checkpoints.ts's pickCheckpoint filters synthesized checkpoint candidates against. Includes recoverable pages (interstitial/expired) too, not just business-outcome ones: a checkpoint that accidentally also matched an interstitial page would skip recovery entirely by mistaking it for the happy path. */
  branchPages: BranchPageSignature[];
}

function substitute(template: string, inputs: Record<string, string | number | boolean>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(inputs[name] ?? ""));
}

function firstLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? text.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Generic: looks for the DOM's own conventional signal for "this is a message/error/warning region" (class or role attribute pattern), never a hardcoded app-specific class name. */
async function findDistinguishingContainer(page: Page): Promise<{ selector: string; text: string } | undefined> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('[class*="err" i], [class*="warn" i], [class*="msg" i], [role="alert"]'));
    for (const el of candidates) {
      const text = (el.textContent ?? "").trim();
      if (text.length === 0) continue;
      const cls = el.getAttribute("class");
      const tag = el.tagName.toLowerCase();
      const selector = cls ? `${tag}.${cls.trim().split(/\s+/).join(".")}` : tag;
      return { selector, text };
    }
    return undefined;
  });
}

/** A "button" role can be a real `<button>` (text via textContent) or an `<input type="submit/button">` (its accessible name comes from `value`, which has no text content at all) — read whichever applies, generically. */
async function findRecoveryButton(page: Page): Promise<{ role: "button"; name: string } | undefined> {
  const button = page.getByRole("button").first();
  if ((await button.count()) > 0) {
    const name = await button
      .evaluate((el) => (el instanceof HTMLInputElement ? el.value : (el.textContent ?? "")))
      .catch(() => "");
    const trimmed = name.trim();
    if (trimmed) {
      return { role: "button", name: trimmed };
    }
  }
  return undefined;
}

interface ProbeObservation {
  landedUrl: string;
  landedBodyText: string;
  container?: { selector: string; text: string };
  button?: { role: "button"; name: string };
}

function withQueryFlag(url: URL, queryFlag: string | undefined): URL {
  if (!queryFlag) {
    return url;
  }
  const [flagKey, flagValue] = queryFlag.split("=");
  if (flagKey) {
    url.searchParams.set(flagKey, flagValue ?? "1");
  }
  return url;
}

/**
 * Re-drives `steps` with the variant's overrides, stopping the moment a
 * step's target no longer resolves (the divergence point), then inspects
 * the resulting page. A `queryFlag` variant (interstitial/session-expiry)
 * is applied on the FIRST request the probe makes — reloading wherever the
 * session already sits, since these flags are per-request app behavior
 * (see app.py's before_request), not tied to whichever step happens to be
 * a `navigate` — a compiled flow need not start with one at all (login
 * already lands on the flow's first real page; see README.md).
 */
async function runProbe(page: Page, steps: Step[], baseInputs: Record<string, string | number | boolean>, baseUrl: string, variant: ProbeVariant): Promise<ProbeObservation> {
  const inputs = { ...baseInputs, ...(variant.inputOverrides ?? {}) };

  if (variant.queryFlag) {
    await page.goto(withQueryFlag(new URL(page.url()), variant.queryFlag).toString(), { waitUntil: "load" });
  }

  for (const step of steps) {
    if (step.action === "navigate") {
      const url = withQueryFlag(new URL(substitute(step.value ?? "/", inputs), baseUrl), variant.queryFlag);
      await page.goto(url.toString(), { waitUntil: "load" });
      continue;
    }
    if (!step.target) {
      continue;
    }
    const scope = resolveFrameScope(page, step.target.frame);
    let resolved: ResolvedTarget | undefined;
    for (let i = 0; i < step.target.strategies.length; i += 1) {
      const strategy = step.target.strategies[i];
      if (!strategy || strategy.kind === "coordinates") continue;
      const locator = buildLocator(scope, strategy);
      if ((await locator.count()) === 1) {
        resolved = { kind: "locator", locator, strategyIndex: i, strategyKind: strategy.kind };
        break;
      }
    }
    if (!resolved) {
      break; // divergence point reached — stop driving, inspect the page as-is
    }
    if (step.action === "click") {
      await Promise.all([page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined), performClick(page, resolved)]);
    } else if (step.action === "fill") {
      await performFill(resolved, substitute(step.value ?? "", inputs));
    } else if (step.action === "select") {
      await performSelect(resolved, substitute(step.value ?? "", inputs));
    } else {
      break; // extract/assert: nothing further worth driving toward divergence
    }
  }

  const container = await findDistinguishingContainer(page).catch(() => undefined);
  const button = variant.kind === "recoverable_interstitial" ? await findRecoveryButton(page).catch(() => undefined) : undefined;
  const landedBodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return { landedUrl: page.url(), landedBodyText, ...(container ? { container } : {}), ...(button ? { button } : {}) };
}

/**
 * Runs each variant against its OWN freshly-logged-in session, never a
 * session shared across variants (or left over from the main derivation
 * driver). A probe re-drives `steps` from the beginning, so it needs to
 * start from exactly the state a real invocation would: fresh session,
 * fresh login, nothing carried over from whatever page a previous probe (or
 * the main derivation pass) happened to leave the browser sitting on.
 */
export async function probeOutcomes(
  browser: Browser,
  appConfig: AppConfig,
  steps: Step[],
  baseInputs: Record<string, string | number | boolean>,
  baseUrl: string,
  variants: ProbeVariant[],
): Promise<ProbeResult> {
  const outcomes: Outcome[] = [];
  const recoverables: Recoverable[] = [];
  const sensitiveValuesUsed: string[] = [];
  const notes: string[] = [];
  const branchPages: BranchPageSignature[] = [];

  for (const variant of variants) {
    if (variant.inputOverrides) {
      sensitiveValuesUsed.push(...Object.values(variant.inputOverrides).map(String));
    }
    const session = await SessionFactory.createInBrowser(browser, appConfig);
    try {
      const observed = await runProbe(session.page, steps, baseInputs, baseUrl, variant);
      // Every landed page counts as a branch page for checkpoint-negative-
      // set purposes, regardless of whether it turned into a declared
      // outcome/recoverable below — an interstitial or expired-session page
      // is just as much "not the happy path" as a not-found page is.
      branchPages.push({ variantId: variant.id, url: observed.landedUrl, bodyText: observed.landedBodyText });

      if (variant.kind === "business_outcome") {
        if (!observed.container) {
          notes.push(`probe "${variant.id}" (${variant.description}): no distinguishing message container found on the resulting page — skipped. Hand-declare this outcome if it is real.`);
          continue;
        }
        outcomes.push({
          id: variant.id,
          class: "business_outcome",
          detect: { kind: "text_present", pattern: escapeRegExp(firstLine(observed.container.text)), within: observed.container.selector },
          returns: { status: variant.id, message: observed.container.text.trim() },
          provenance: "probed",
        });
      } else if (variant.kind === "recoverable_interstitial") {
        if (!observed.button) {
          notes.push(`probe "${variant.id}" (${variant.description}): no recovery control (button) found — skipped.`);
          continue;
        }
        recoverables.push({
          id: variant.id,
          detect: observed.container
            ? { kind: "text_present", pattern: escapeRegExp(firstLine(observed.container.text)), within: observed.container.selector }
            : { kind: "element_present", role: observed.button.role, name: observed.button.name },
          recover: { action: "click", role: observed.button.role, name: observed.button.name },
          max_attempts: 1,
        });
      } else {
        // recoverable_expired
        recoverables.push({
          id: variant.id,
          detect: observed.container
            ? { kind: "text_present", pattern: escapeRegExp(firstLine(observed.container.text)), within: observed.container.selector }
            : { kind: "url_matches", pattern: escapeRegExp(new URL(observed.landedUrl).pathname) },
          recover: { action: "escalate", reason: "Session expired mid-flow; automation holds no credentials to re-authenticate." },
          max_attempts: 1,
        });
      }
    } catch (err) {
      notes.push(`probe "${variant.id}" (${variant.description}) failed to run: ${err instanceof Error ? err.message : String(err)} — skipped.`);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  return { outcomes, recoverables, sensitiveValuesUsed, notes, branchPages };
}
