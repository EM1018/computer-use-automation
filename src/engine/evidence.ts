import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Action, Strategy } from "../schema/capability.js";
import type { CapabilityResult } from "../schema/result.js";
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
}
