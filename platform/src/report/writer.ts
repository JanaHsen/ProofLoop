/**
 * The report writer (Phase 4 Task 1 + the optional Task 2 summary). Orchestrates
 * build → (optional summary) → render → emit for ONE explicitly selected evaluation, writing
 * both artifacts under the run directory:
 *
 *   platform/runs/<runId>/reports/<evaluationId>/report.json
 *   platform/runs/<runId>/reports/<evaluationId>/report.html
 *
 * These run-local outputs are gitignored (the whole `platform/runs/*` tree is). The
 * deterministic build runs FIRST and fully: if any D28 integrity assertion throws, neither
 * file is written and the throw propagates (fatal — NEVER caught as a summary failure).
 *
 * Every invocation rebuilds the report from the source artifacts and ATOMICALLY replaces both
 * files (temp + rename). It never patches in place, so a no-summary or failed-summary run
 * removes any `aiSummary` (and its HTML banner) left by an earlier successful run. The
 * deterministic `report.json` carries no timestamp, so a no-summary / failed-summary output is
 * byte-identical across runs. No LLM/browser/network is touched unless `--summary` is used.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { PricingConfig } from "../run/pricing";
import { buildReport, type BuildReportOptions } from "./builder";
import { renderReportHtml } from "./html";
import type { RunReport } from "./schema";
import { generateSummary, type Summarizer, type SummaryOutcome } from "./summary";

export interface WriteReportOptions extends BuildReportOptions {}

export interface WriteReportResult {
  report: RunReport;
  reportDir: string;
  jsonPath: string;
  htmlPath: string;
}

/** Serialize the deterministic report with stable key ordering and a trailing newline. */
export function serializeReport(report: RunReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Write via temp + rename so the destination is atomically replaced, never half-written. */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

/** Render + atomically replace both report files. Used by both the sync and summary paths. */
function emitReport(
  runDir: string,
  evaluationId: string,
  report: RunReport,
): { reportDir: string; jsonPath: string; htmlPath: string } {
  const reportDir = path.join(runDir, "reports", evaluationId);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, "report.json");
  const htmlPath = path.join(reportDir, "report.html");
  atomicWrite(jsonPath, serializeReport(report));
  atomicWrite(htmlPath, renderReportHtml(report));
  return { reportDir, jsonPath, htmlPath };
}

/**
 * Build and emit the DETERMINISTIC report (no summary). Throws (writing nothing) if an input
 * is missing or a D28 join is violated — the build happens before any file I/O.
 */
export function writeReport(opts: WriteReportOptions): WriteReportResult {
  const report = buildReport(opts);
  const paths = emitReport(opts.runDir, opts.evaluationId, report);
  return { report, ...paths };
}

/** Injected summary generation config for the opt-in `--summary` path. */
export interface SummaryGenerationOptions {
  summarizer: Summarizer;
  model: string;
  pricing: PricingConfig;
  timeoutMs?: number;
  clock?: () => string;
}

export interface WriteReportWithSummaryResult extends WriteReportResult {
  /** The fail-open outcome of the single summary call (never thrown). */
  summary: SummaryOutcome;
}

/**
 * Build the deterministic report (D28 fatal, NOT caught), then make ONE fail-open summary call
 * and attach `aiSummary` only on success. On any summary failure the deterministic report is
 * emitted unchanged (no `aiSummary`). Both files are atomically replaced either way.
 */
export async function writeReportWithSummary(
  opts: WriteReportOptions,
  summaryOpts: SummaryGenerationOptions,
): Promise<WriteReportWithSummaryResult> {
  // Deterministic build + ALL D28 assertions happen first; a failure here is fatal.
  const report = buildReport(opts);

  // Summary work is fail-open: generateSummary never throws for summary-specific problems.
  const summary = await generateSummary({
    report,
    summarizer: summaryOpts.summarizer,
    model: summaryOpts.model,
    pricing: summaryOpts.pricing,
    timeoutMs: summaryOpts.timeoutMs,
    clock: summaryOpts.clock,
  });

  const finalReport: RunReport = summary.ok
    ? { ...report, aiSummary: summary.aiSummary }
    : report;

  const paths = emitReport(opts.runDir, opts.evaluationId, finalReport);
  return { report: finalReport, ...paths, summary };
}
