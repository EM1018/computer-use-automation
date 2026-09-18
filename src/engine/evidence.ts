import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Page } from "playwright";
import type { Action, Strategy } from "../schema/capability.js";
import type { CapabilityResult } from "../schema/result.js";
import type { InterventionRecord } from "../schema/intervention.js";
import type { ActionLogEntry, PolicyEventEntry, RefsLogEntry, TranscriptTurnEntry } from "../schema/discovery.js";
import type { Redactor } from "./redactor.js";
import type { Controller } from "./session.js";

export interface StepLogEntry {
  run_id: string;
  step: string;
  action: Action;
  strategy_index_used?: number;
  strategy_kind?: Strategy["kind"];
  duration_ms: number;
  outcome: string;
  actor: Controller;
  detail?: string;
}

/**
 * Writes evidence for a single run under evidence/<run_id>/. Every method
 * scrubs through the Redactor passed at construction — there is no path to
 * disk here that bypasses it. Redaction applies to what gets written, not
 * to the CapabilityResult handed back to the caller.
 */
export class EvidenceWriter {
  readonly runDir: string;
  private readonly redactor: Redactor;
  private ensured: Promise<void> | undefined;

  constructor(evidenceRoot: string, runId: string, redactor: Redactor) {
    this.runDir = join(evidenceRoot, runId);
    this.redactor = redactor;
  }

  private ensureDir(): Promise<void> {
    this.ensured ??= mkdir(this.runDir, { recursive: true }).then(() => undefined);
    return this.ensured;
  }

  async writeStep(entry: StepLogEntry): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(entry);
    await appendFile(join(this.runDir, "steps.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  async writeResult(result: CapabilityResult): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(result);
    await writeFile(join(this.runDir, "result.json"), `${JSON.stringify(scrubbed, null, 2)}\n`, "utf8");
  }

  /** Records a non-fatal, run-level warning (e.g. an unattended run explicitly permitted against a draft). */
  async writeWarning(runId: string, message: string): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub({ run_id: runId, message });
    await appendFile(join(this.runDir, "warnings.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  /** Screenshots are only taken on failure or escalation, per the evidence contract. */
  async writeScreenshot(page: Page): Promise<string> {
    await this.ensureDir();
    const path = join(this.runDir, "failure.png");
    await page.screenshot({ path });
    return path;
  }

  tracePath(): string {
    return join(this.runDir, "trace.zip");
  }

  /**
   * Writes (or overwrites, on a status transition) one intervention record
   * to evidence/<run_id>/interventions/<intervention_id>.yaml. Interventions
   * carry input values and page context, same redaction rules as everything
   * else this writer produces — routed through the same Redactor, no
   * separate path to disk.
   */
  async writeIntervention(record: InterventionRecord): Promise<string> {
    const dir = join(this.runDir, "interventions");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${record.intervention_id}.yaml`);
    const scrubbed = this.redactor.scrub(record);
    await writeFile(path, yaml.dump(scrubbed), "utf8");
    return path;
  }

  // -------------------------------------------------------------------------
  // Discovery's transcript files — same evidence/<run_id>/ root, same
  // Redactor chokepoint, no separate writer class. Input values supplied at
  // discovery launch are sensitive by construction (see
  // src/discovery/loop.ts's Redactor setup) and get scrubbed here exactly
  // like everything else.
  // -------------------------------------------------------------------------

  async writeTranscriptTurn(entry: TranscriptTurnEntry): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(entry);
    await appendFile(join(this.runDir, "transcript.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  async writeAction(entry: ActionLogEntry): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(entry);
    await appendFile(join(this.runDir, "actions.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  async writePolicyEvent(entry: PolicyEventEntry): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(entry);
    await appendFile(join(this.runDir, "policy_events.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  async writeRefs(entry: RefsLogEntry): Promise<void> {
    await this.ensureDir();
    const scrubbed = this.redactor.scrub(entry);
    await appendFile(join(this.runDir, "refs.jsonl"), `${JSON.stringify(scrubbed)}\n`, "utf8");
  }

  /** Path helper only, no I/O — lets a caller reference a turn's screenshot (e.g. for an intervention record) without retaking it. */
  turnScreenshotPath(turn: number): string {
    return join(this.runDir, "screenshots", `turn_${turn}.png`);
  }

  async writeTurnScreenshot(turn: number, page: Page): Promise<string> {
    await this.ensureDir();
    const dir = join(this.runDir, "screenshots");
    await mkdir(dir, { recursive: true });
    const path = this.turnScreenshotPath(turn);
    await page.screenshot({ path });
    return path;
  }
}
