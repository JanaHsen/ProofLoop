/**
 * The report writer (Phase 4 Task 1). Orchestrates build → render → emit for ONE explicitly
 * selected evaluation, then writes both artifacts under the run directory:
 *
 *   platform/runs/<runId>/reports/<evaluationId>/report.json
 *   platform/runs/<runId>/reports/<evaluationId>/report.html
 *
 * These run-local outputs are gitignored (the whole `platform/runs/*` tree is). The build
 * runs FIRST and fully: if any D28 integrity assertion throws, neither file is written
 * (D28). `report.json` serializes with stable key ordering and carries no timestamp, so two
 * generations of the same inputs are byte-identical. No LLM, browser, or network is touched.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { buildReport, type BuildReportOptions } from "./builder";
import { renderReportHtml } from "./html";
import type { RunReport } from "./schema";

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

/**
 * Build and emit the report for one explicitly selected evaluation. Throws (writing nothing)
 * if an input is missing or a D28 join is violated — the build happens before any file I/O.
 */
export function writeReport(opts: WriteReportOptions): WriteReportResult {
  // Build (and therefore validate) BEFORE creating any directory or file.
  const report = buildReport(opts);

  const reportDir = path.join(opts.runDir, "reports", opts.evaluationId);
  fs.mkdirSync(reportDir, { recursive: true });

  const jsonPath = path.join(reportDir, "report.json");
  const htmlPath = path.join(reportDir, "report.html");
  fs.writeFileSync(jsonPath, serializeReport(report), "utf8");
  fs.writeFileSync(htmlPath, renderReportHtml(report), "utf8");

  return { report, reportDir, jsonPath, htmlPath };
}
