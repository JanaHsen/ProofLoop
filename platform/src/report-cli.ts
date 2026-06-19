// CLI entry for the Phase 4 report generator (Task 1 deterministic + optional Task 2 summary).
//
// Usage:
//   npm run report -- --run <runId> --evaluation <evaluationId>            (offline, no LLM)
//   npm run report -- --run <runId> --evaluation <evaluationId> --summary  (one bounded call)
//
// Plain generation is OFFLINE by construction: no browser, verifier, LLM, network, or API key.
// The evaluation is NEVER chosen implicitly — both flags required, newest never assumed. Any
// integrity mismatch fails loud and writes nothing (exit 1).
//
// `--summary` is OPT-IN, ADDITIVE, ONE-CALL, FAIL-OPEN. The deterministic report is built (all
// D28 assertions) before any summary work. A summary-specific problem (missing model/key,
// unpriced model, oversized input, API/timeout/validation failure) is a warning on stderr; the
// deterministic report is still written and the process exits 0. Deterministic-side failures
// stay fatal (exit 1) and are never converted to a summary failure.

import * as path from "node:path";

import { readEngineConfig } from "./config";
import { loadPricing, ratesFor } from "./run/pricing";
import {
  ReportArtifactNotFoundError,
  ReportIntegrityError,
  UnsupportedEvaluationSchemaError,
} from "./report/builder";
import { AnthropicSummarizer } from "./report/summary";
import { writeReport, writeReportWithSummary, type WriteReportResult } from "./report/writer";

export interface ReportArgs {
  runId: string;
  evaluationId: string;
  summary: boolean;
}

/**
 * Parse `--run <id> --evaluation <id> [--summary]` (order-independent). `--summary` is a
 * valueless flag. Returns null if `--run`/`--evaluation` are missing or an unknown flag
 * appears. Pure and side-effect free so it can be unit-tested without running `main`.
 */
export function parseReportArgs(args: string[]): ReportArgs | null {
  let runId: string | undefined;
  let evaluationId: string | undefined;
  let summary = false;
  for (let i = 0; i < args.length; ) {
    const flag = args[i];
    if (flag === "--summary") {
      summary = true;
      i += 1;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) return null;
    if (flag === "--run") runId = value;
    else if (flag === "--evaluation") evaluationId = value;
    else return null;
    i += 2;
  }
  if (!runId || !evaluationId) return null;
  return { runId, evaluationId, summary };
}

function reportLine(args: ReportArgs, result: WriteReportResult, suffix: string): string {
  return (
    `■ report run=${args.runId} evaluation=${args.evaluationId} ` +
    `flowVerdict=${result.report.verification.flowVerdict} ` +
    `executionStatus=${result.report.execution.status}${suffix}\n` +
    `  ${result.jsonPath}\n  ${result.htmlPath}\n`
  );
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      "usage: npm run report -- --run <runId> --evaluation <evaluationId> [--summary]\n",
    );
    return 2;
  }

  const runsRoot = path.join(__dirname, "..", "runs");
  const runDir = path.join(runsRoot, parsed.runId);
  const flowsDir = path.join(__dirname, "..", "..", "fixtures", "flows");

  try {
    if (!parsed.summary) {
      const result = writeReport({ runDir, evaluationId: parsed.evaluationId, flowsDir });
      process.stdout.write(reportLine(parsed, result, ""));
      return 0;
    }

    // --- --summary preflight: any failed precondition => zero client calls, fail-open (exit 0).
    const cfg = readEngineConfig();
    const preflightFailure = summaryPreflight(cfg);
    if (preflightFailure) {
      process.stderr.write(`! summary skipped: ${preflightFailure}\n`);
      const result = writeReport({ runDir, evaluationId: parsed.evaluationId, flowsDir });
      process.stdout.write(reportLine(parsed, result, " summary=skipped"));
      return 0;
    }

    const pricing = loadPricing(cfg.pricingConfigId);
    const summarizer = new AnthropicSummarizer({
      apiKey: cfg.anthropicApiKey,
      model: cfg.summaryModel!,
    });
    const result = await writeReportWithSummary(
      { runDir, evaluationId: parsed.evaluationId, flowsDir },
      { summarizer, model: cfg.summaryModel!, pricing },
    );
    if (!result.summary.ok) {
      process.stderr.write(`! summary failed: ${result.summary.reason}\n`);
    }
    process.stdout.write(
      reportLine(parsed, result, ` summary=${result.summary.ok ? "ok" : "failed"}`),
    );
    return 0;
  } catch (e) {
    // Deterministic-side failures are fatal — never converted to a summary fail-open.
    if (
      e instanceof ReportIntegrityError ||
      e instanceof ReportArtifactNotFoundError ||
      e instanceof UnsupportedEvaluationSchemaError
    ) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
}

/**
 * Validate the `--summary` preconditions WITHOUT any client call: configured model, API key,
 * and that the model is priced in the committed pricing config. Returns a human reason on the
 * first failure (a summary failure), or undefined when all preconditions hold.
 */
export function summaryPreflight(cfg: ReturnType<typeof readEngineConfig>): string | undefined {
  const model = cfg.summaryModel?.trim();
  if (!model) {
    return "PROOFLOOP_SUMMARY_MODEL is not set (required for --summary; no default)";
  }
  if (!cfg.anthropicApiKey) {
    return "ANTHROPIC_API_KEY is not set";
  }
  try {
    ratesFor(loadPricing(cfg.pricingConfigId), model);
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
