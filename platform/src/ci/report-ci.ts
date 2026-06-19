// CI results aggregator (Phase 6, D43).
//
// Reads ci-results.json (the workflow's runtime ledger) and produces:
//   summary.json — machine-readable deterministic aggregate (CiSummary)
//   summary.md   — human-readable Markdown for the sticky PR comment
//
// No LLM call. No verdict is invented. Completed reports are read verbatim;
// only the recorded flow verdict, per-criterion verdicts, reasons, and
// execution/verifier metrics are extracted. allPass is computed from counts,
// never derived from Markdown. Error messages from the ledger are NEVER copied
// to either output artifact (only errorClass, a harness-authored safe identifier).

import * as fs from "node:fs";
import * as path from "node:path";

import { REPORT_SCHEMA_VERSION } from "../report/schema";

export const CI_SUMMARY_SCHEMA_VERSION = "1.0";

const ALLOWED_STAGES = new Set(["run", "verify", "report", "complete"]);
const ALLOWED_RESULT_KEYS = new Set([
  "flowPath",
  "stage",
  "runId",
  "evaluationId",
  "reportPath",
  "errorClass",
  "errorMessage",
]);

type CiFlowStage = "run" | "verify" | "report" | "complete";

export interface CiFlowResult {
  flowPath: string;
  stage: CiFlowStage;
  runId?: string;
  evaluationId?: string;
  reportPath?: string;
  errorClass?: string;
  errorMessage?: string; // present in input; NEVER forwarded to output artifacts
}

export interface CiNonPassCriterion {
  id: string;
  text: string;
  outcome: "FAIL" | "INCONCLUSIVE";
  reason: string;
}

export interface CiSummaryFlow {
  flowPath: string;
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";
  runId?: string;
  evaluationId?: string;
  nonPassCriteria?: CiNonPassCriterion[];
  errorClass?: string;
  decider?: { costUsd: number; latencyMs: number };
  verifier?: { costUsd: number; latencyMs: number };
}

export interface CiSummary {
  schemaVersion: typeof CI_SUMMARY_SCHEMA_VERSION;
  allPass: boolean;
  counts: { pass: number; fail: number; inconclusive: number; error: number };
  flows: CiSummaryFlow[];
}

/** Thrown on any ci-results.json structural or validation defect. */
export class CiResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiResultsError";
  }
}

/** Thrown when reading or validating a completed report.json fails. */
export class CiReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiReportError";
  }
}

export interface AggregateCiResultsOptions {
  /** Absolute path to ci-results.json. */
  resultsPath: string;
  /** Absolute path to the repository root. Defaults to the repo root above platform/. */
  repoRoot?: string;
}

export interface AggregateCiResultsOutput {
  summary: CiSummary;
  /** Byte-identical across two runs on identical input; no timestamps. */
  summaryJson: string;
  /** Escaped Markdown; byte-identical across two runs on identical input. */
  summaryMd: string;
}

// Defaults derive from this module's __dirname, not process.cwd().
const DEFAULT_REPO_ROOT = path.join(__dirname, "..", "..", "..");

// ─── Markdown escaping ────────────────────────────────────────────────────────

/**
 * Escape artifact-derived text for safe interpolation into GitHub-flavored Markdown.
 * Handles: HTML entities (kills comment injection), backslashes, backticks,
 * bracket-link syntax, table pipes, and newlines (prevents heading injection).
 * Applied to EVERY interpolated artifact-derived value — flow paths, criterion text,
 * reasons, errorClass, reportPath references.
 */
export function escapeMd(s: string): string {
  return String(s)
    .replace(/\\/g, "\\\\") // backslash first to avoid double-escaping
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;") // also kills <!-- comment injection
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\r\n|\r|\n/g, " ") // flatten newlines — prevents heading injection
    .replace(/\|/g, "\\|"); // table pipe
}

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ─── ci-results.json validation ───────────────────────────────────────────────

function validateResults(raw: unknown, repoRoot: string): CiFlowResult[] {
  if (!Array.isArray(raw)) {
    throw new CiResultsError("ci-results.json must be a non-empty JSON array.");
  }
  if (raw.length === 0) {
    throw new CiResultsError("ci-results.json must contain at least one flow entry.");
  }

  const seenPaths = new Set<string>();
  const results: CiFlowResult[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const prefix = `ci-results.json entry [${i}]`;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CiResultsError(`${prefix}: each entry must be a JSON object.`);
    }
    const obj = entry as Record<string, unknown>;

    const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_RESULT_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new CiResultsError(
        `${prefix}: unknown field(s): ${unknownKeys.join(", ")} ` +
          `(allowed: ${[...ALLOWED_RESULT_KEYS].join(", ")}).`,
      );
    }

    if (typeof obj.flowPath !== "string" || obj.flowPath.trim() === "") {
      throw new CiResultsError(`${prefix}: "flowPath" must be a non-empty string.`);
    }
    const flowPath = obj.flowPath as string;

    if (seenPaths.has(flowPath)) {
      throw new CiResultsError(`${prefix}: duplicate flowPath "${flowPath}".`);
    }
    seenPaths.add(flowPath);

    if (!ALLOWED_STAGES.has(obj.stage as string)) {
      throw new CiResultsError(
        `${prefix} (${flowPath}): "stage" must be one of: ${[...ALLOWED_STAGES].join(", ")} ` +
          `(got ${JSON.stringify(obj.stage)}).`,
      );
    }
    const stage = obj.stage as CiFlowStage;

    const hasRunId = obj.runId !== undefined;
    const hasEvalId = obj.evaluationId !== undefined;
    const hasReportPath = obj.reportPath !== undefined;
    const hasErrorClass = obj.errorClass !== undefined;

    if (stage === "complete") {
      if (typeof obj.runId !== "string" || obj.runId.trim() === "") {
        throw new CiResultsError(
          `${prefix} (${flowPath}): stage "complete" requires a non-empty "runId".`,
        );
      }
      if (typeof obj.evaluationId !== "string" || obj.evaluationId.trim() === "") {
        throw new CiResultsError(
          `${prefix} (${flowPath}): stage "complete" requires a non-empty "evaluationId".`,
        );
      }
      if (typeof obj.reportPath !== "string" || obj.reportPath.trim() === "") {
        throw new CiResultsError(
          `${prefix} (${flowPath}): stage "complete" requires a non-empty "reportPath".`,
        );
      }
      if (hasErrorClass) {
        throw new CiResultsError(
          `${prefix} (${flowPath}): contradictory — stage "complete" must not have "errorClass".`,
        );
      }
      // Validate reportPath: reject absolute, reject traversal out of repoRoot.
      const reportPath = obj.reportPath as string;
      if (path.posix.isAbsolute(reportPath) || path.win32.isAbsolute(reportPath)) {
        throw new CiResultsError(
          `${prefix} (${flowPath}): "reportPath" must be repo-root-relative, not absolute: ${reportPath}`,
        );
      }
      const absReport = path.resolve(repoRoot, reportPath);
      const rel = path.relative(repoRoot, absReport);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new CiResultsError(
          `${prefix} (${flowPath}): "reportPath" traverses outside the repository root: ${reportPath}`,
        );
      }
    } else {
      // Non-complete: must have errorClass (the pipeline stopped at this stage with an error).
      if (typeof obj.errorClass !== "string" || obj.errorClass.trim() === "") {
        throw new CiResultsError(
          `${prefix} (${flowPath}): stage "${stage}" (non-complete) requires a non-empty "errorClass".`,
        );
      }
      // Stage-specific contradictions: fields that could not have been produced yet.
      if (stage === "run") {
        if (hasRunId || hasEvalId || hasReportPath) {
          throw new CiResultsError(
            `${prefix} (${flowPath}): contradictory — stage "run" (failed before run-cli) ` +
              `must not have runId, evaluationId, or reportPath.`,
          );
        }
      } else if (stage === "verify") {
        if (typeof obj.runId !== "string" || obj.runId.trim() === "") {
          throw new CiResultsError(
            `${prefix} (${flowPath}): stage "verify" (failed) requires a non-empty "runId".`,
          );
        }
        if (hasEvalId || hasReportPath) {
          throw new CiResultsError(
            `${prefix} (${flowPath}): contradictory — stage "verify" (failed) must not have ` +
              `evaluationId or reportPath.`,
          );
        }
      } else if (stage === "report") {
        if (typeof obj.runId !== "string" || obj.runId.trim() === "") {
          throw new CiResultsError(
            `${prefix} (${flowPath}): stage "report" (failed) requires a non-empty "runId".`,
          );
        }
        if (typeof obj.evaluationId !== "string" || obj.evaluationId.trim() === "") {
          throw new CiResultsError(
            `${prefix} (${flowPath}): stage "report" (failed) requires a non-empty "evaluationId".`,
          );
        }
        if (hasReportPath) {
          throw new CiResultsError(
            `${prefix} (${flowPath}): contradictory — stage "report" (failed) must not have reportPath.`,
          );
        }
      }
    }

    const result: CiFlowResult = { flowPath, stage };
    if (obj.runId !== undefined) result.runId = obj.runId as string;
    if (obj.evaluationId !== undefined) result.evaluationId = obj.evaluationId as string;
    if (obj.reportPath !== undefined) result.reportPath = obj.reportPath as string;
    if (obj.errorClass !== undefined) result.errorClass = obj.errorClass as string;
    // errorMessage: read but NEVER forwarded to output artifacts.
    if (obj.errorMessage !== undefined) result.errorMessage = obj.errorMessage as string;
    results.push(result);
  }

  return results;
}

// ─── report.json reading ──────────────────────────────────────────────────────

interface ReportCriterionMinimal {
  criterionId: string;
  text: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasoning: string;
  inconclusiveDetail?: { kind: string; explanation: string };
}

interface ReportMinimal {
  flowVerdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  criteria: ReportCriterionMinimal[];
  decider: { costUsd: number; latencyMs: number };
  verifier: { costUsd: number; latencyMs: number };
}

function readCompletedReport(
  absPath: string,
  expectedRunId: string,
  expectedEvalId: string,
): ReportMinimal {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (e) {
    throw new CiReportError(`cannot read report.json at ${absPath}: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CiReportError(
      `report.json is not valid JSON at ${absPath}: ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CiReportError(`report.json must be a JSON object at ${absPath}.`);
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.reportSchemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new CiReportError(
      `unsupported reportSchemaVersion ${JSON.stringify(obj.reportSchemaVersion)} ` +
        `at ${absPath} (supported: "${REPORT_SCHEMA_VERSION}").`,
    );
  }

  const source = obj.source as Record<string, unknown> | undefined;
  if (typeof source !== "object" || source === null) {
    throw new CiReportError(`report.json missing "source" object at ${absPath}.`);
  }
  if (source.runId !== expectedRunId) {
    throw new CiReportError(
      `report.json source.runId (${JSON.stringify(source.runId)}) !== ` +
        `expected runId (${JSON.stringify(expectedRunId)}) at ${absPath}.`,
    );
  }
  if (source.evaluationId !== expectedEvalId) {
    throw new CiReportError(
      `report.json source.evaluationId (${JSON.stringify(source.evaluationId)}) !== ` +
        `expected evaluationId (${JSON.stringify(expectedEvalId)}) at ${absPath}.`,
    );
  }

  const execution = obj.execution as Record<string, unknown> | undefined;
  if (typeof execution !== "object" || execution === null) {
    throw new CiReportError(`report.json missing "execution" object at ${absPath}.`);
  }

  const verification = obj.verification as Record<string, unknown> | undefined;
  if (typeof verification !== "object" || verification === null) {
    throw new CiReportError(`report.json missing "verification" object at ${absPath}.`);
  }

  const flowVerdict = verification.flowVerdict as string;
  if (flowVerdict !== "PASS" && flowVerdict !== "FAIL" && flowVerdict !== "INCONCLUSIVE") {
    throw new CiReportError(
      `report.json verification.flowVerdict is not a valid verdict: ` +
        `${JSON.stringify(flowVerdict)} at ${absPath}.`,
    );
  }

  const rawCriteria = verification.criteria;
  if (!Array.isArray(rawCriteria)) {
    throw new CiReportError(
      `report.json verification.criteria must be an array at ${absPath}.`,
    );
  }

  const criteria: ReportCriterionMinimal[] = rawCriteria.map((c, idx) => {
    if (typeof c !== "object" || c === null) {
      throw new CiReportError(
        `report.json verification.criteria[${idx}] is not an object at ${absPath}.`,
      );
    }
    const cObj = c as Record<string, unknown>;
    const v = String(cObj.verdict ?? "");
    if (v !== "PASS" && v !== "FAIL" && v !== "INCONCLUSIVE") {
      throw new CiReportError(
        `report.json verification.criteria[${idx}].verdict is not valid: ` +
          `${JSON.stringify(v)} at ${absPath}.`,
      );
    }
    const result: ReportCriterionMinimal = {
      criterionId: String(cObj.criterionId ?? ""),
      text: String(cObj.text ?? ""),
      verdict: v as "PASS" | "FAIL" | "INCONCLUSIVE",
      reasoning: String(cObj.reasoning ?? ""),
    };
    if (cObj.inconclusiveDetail !== undefined) {
      const d = cObj.inconclusiveDetail as Record<string, unknown>;
      result.inconclusiveDetail = {
        kind: String(d.kind ?? ""),
        explanation: String(d.explanation ?? ""),
      };
    }
    return result;
  });

  return {
    flowVerdict: flowVerdict as "PASS" | "FAIL" | "INCONCLUSIVE",
    criteria,
    decider: {
      costUsd: Number(execution.costUsd ?? 0),
      latencyMs: Number(execution.latencyMs ?? 0),
    },
    verifier: {
      costUsd: Number(verification.costUsd ?? 0),
      latencyMs: Number(verification.latencyMs ?? 0),
    },
  };
}

// ─── JSON serialization ───────────────────────────────────────────────────────

/** Build summary.json with stable key ordering. Byte-identical across runs on identical input. */
export function serializeCiSummary(summary: CiSummary): string {
  // Build with explicit key ordering (JS insertion order is stable for string keys).
  const obj = {
    schemaVersion: summary.schemaVersion,
    allPass: summary.allPass,
    counts: {
      pass: summary.counts.pass,
      fail: summary.counts.fail,
      inconclusive: summary.counts.inconclusive,
      error: summary.counts.error,
    },
    flows: summary.flows.map((f) => {
      // Build each flow entry with keys in schema-defined order; optional fields omitted
      // when absent so a flow with no metrics has a smaller footprint.
      const row: Record<string, unknown> = {};
      row.flowPath = f.flowPath;
      row.outcome = f.outcome;
      if (f.runId !== undefined) row.runId = f.runId;
      if (f.evaluationId !== undefined) row.evaluationId = f.evaluationId;
      if (f.nonPassCriteria !== undefined) {
        row.nonPassCriteria = f.nonPassCriteria.map((c) => ({
          id: c.id,
          text: c.text,
          outcome: c.outcome,
          reason: c.reason,
        }));
      }
      if (f.errorClass !== undefined) row.errorClass = f.errorClass;
      if (f.decider !== undefined) {
        row.decider = { costUsd: f.decider.costUsd, latencyMs: f.decider.latencyMs };
      }
      if (f.verifier !== undefined) {
        row.verifier = { costUsd: f.verifier.costUsd, latencyMs: f.verifier.latencyMs };
      }
      return row;
    }),
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

// ─── Markdown rendering ───────────────────────────────────────────────────────

interface FlowAggregate {
  flow: CiSummaryFlow;
  /** Repo-root-relative reportPath for the artifact link (only for "complete" entries). */
  reportPath?: string;
}

const CAVEAT =
  "> **Caveat:** This is a single CI execution of each flow against a clean app. " +
  "A green result is not a reliability claim and a red result is one run, " +
  "not a measured failure rate. Repeated-run reliability and verdict variance are Phase 8. " +
  "Bug-ledger accuracy is Phase 7.";

/** Build summary.md. Byte-identical across runs on identical input. */
export function buildCiSummaryMd(aggregates: FlowAggregate[]): string {
  const allGreen = aggregates.every(({ flow }) => flow.outcome === "PASS");

  const statusLine = allGreen
    ? "**Status: All flows cleared**"
    : "**Status: Not all flows cleared**";

  const tableRows = aggregates
    .map(({ flow }) => {
      const costDec = flow.decider !== undefined ? money(flow.decider.costUsd) : "—";
      const latDec = flow.decider !== undefined ? `${flow.decider.latencyMs}ms` : "—";
      const costVer = flow.verifier !== undefined ? money(flow.verifier.costUsd) : "—";
      const latVer = flow.verifier !== undefined ? `${flow.verifier.latencyMs}ms` : "—";
      return (
        `| ${escapeMd(flow.flowPath)} | ${escapeMd(flow.outcome)} | ` +
        `${escapeMd(costDec)} | ${escapeMd(latDec)} | ` +
        `${escapeMd(costVer)} | ${escapeMd(latVer)} |`
      );
    })
    .join("\n");

  const table =
    `| Flow | Outcome | Decider cost | Decider latency | Verifier cost | Verifier latency |\n` +
    `|---|---|---|---|---|---|\n` +
    tableRows;

  let totalDecider = 0;
  let totalVerifier = 0;
  for (const { flow } of aggregates) {
    if (flow.decider !== undefined) totalDecider += flow.decider.costUsd;
    if (flow.verifier !== undefined) totalVerifier += flow.verifier.costUsd;
  }
  const costTotals =
    `**Total decider cost: ${money(totalDecider)}** | ` +
    `**Total verifier cost: ${money(totalVerifier)}**`;

  const nonPassAggs = aggregates.filter(({ flow }) => flow.outcome !== "PASS");

  let issuesBlock = "";
  if (nonPassAggs.length > 0) {
    const sections = nonPassAggs.map(({ flow, reportPath }) => {
      const fp = escapeMd(flow.flowPath);
      let header: string;
      if (flow.outcome === "FAIL") {
        header = `#### ${fp} — FAIL (detected behavioral regression)`;
      } else if (flow.outcome === "INCONCLUSIVE") {
        header = `#### ${fp} — INCONCLUSIVE (not cleared by the platform)`;
      } else {
        header = `#### ${fp} — ERROR (no trustworthy verdict produced)`;
      }

      const parts: string[] = [header];

      if (reportPath !== undefined) {
        parts.push(`\nReport artifact: \`${escapeMd(reportPath)}\``);
      }

      if (flow.outcome === "ERROR") {
        const ec = flow.errorClass !== undefined ? escapeMd(flow.errorClass) : "(unknown)";
        parts.push(`\nPipeline error class: \`${ec}\``);
      } else if (flow.nonPassCriteria && flow.nonPassCriteria.length > 0) {
        const rows = flow.nonPassCriteria
          .map(
            (c) =>
              `| ${escapeMd(c.id)} | ${escapeMd(c.outcome)} | ${escapeMd(c.reason)} |`,
          )
          .join("\n");
        parts.push(`\n| Criterion | Outcome | Reason |\n|---|---|---|\n${rows}`);
      }

      return parts.join("\n");
    });

    issuesBlock = `\n### Issues requiring attention\n\n${sections.join("\n\n")}\n`;
  }

  return (
    [
      "<!-- proofloop-ci -->",
      "",
      "## ProofLoop CI",
      "",
      statusLine,
      "",
      table,
      "",
      costTotals,
      issuesBlock,
      "---",
      "",
      CAVEAT,
      "",
    ].join("\n")
  );
}

// ─── Main aggregation function ────────────────────────────────────────────────

export function aggregateCiResults(opts: AggregateCiResultsOptions): AggregateCiResultsOutput {
  const repoRoot = path.resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(opts.resultsPath, "utf8");
  } catch (e) {
    throw new CiResultsError(
      `cannot read ci-results.json at ${opts.resultsPath}: ${(e as Error).message}`,
    );
  }

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(rawContent);
  } catch (e) {
    throw new CiResultsError(
      `ci-results.json is not valid JSON at ${opts.resultsPath}: ${(e as Error).message}`,
    );
  }

  const results = validateResults(rawParsed, repoRoot);

  const aggregates: FlowAggregate[] = [];

  for (const entry of results) {
    if (entry.stage === "complete") {
      const absReport = path.resolve(repoRoot, entry.reportPath!);
      const report = readCompletedReport(absReport, entry.runId!, entry.evaluationId!);

      const nonPassCriteria: CiNonPassCriterion[] = [];
      for (const c of report.criteria) {
        if (c.verdict === "FAIL" || c.verdict === "INCONCLUSIVE") {
          // FAIL: use verifier reasoning. INCONCLUSIVE: prefer inconclusiveDetail.explanation.
          const reason =
            c.verdict === "INCONCLUSIVE" && c.inconclusiveDetail
              ? c.inconclusiveDetail.explanation
              : c.reasoning;
          nonPassCriteria.push({ id: c.criterionId, text: c.text, outcome: c.verdict, reason });
        }
      }

      const flow: CiSummaryFlow = {
        flowPath: entry.flowPath,
        outcome: report.flowVerdict,
        runId: entry.runId,
        evaluationId: entry.evaluationId,
      };
      if (nonPassCriteria.length > 0) flow.nonPassCriteria = nonPassCriteria;
      flow.decider = report.decider;
      flow.verifier = report.verifier;

      aggregates.push({ flow, reportPath: entry.reportPath });
    } else {
      // Pipeline stopped before completing — emit ERROR, invent no verdict.
      const flow: CiSummaryFlow = {
        flowPath: entry.flowPath,
        outcome: "ERROR",
        errorClass: entry.errorClass,
      };
      // Preserve available IDs for traceability even on error.
      if (entry.runId !== undefined) flow.runId = entry.runId;
      if (entry.evaluationId !== undefined) flow.evaluationId = entry.evaluationId;
      // errorMessage is intentionally NOT forwarded.
      aggregates.push({ flow });
    }
  }

  let pass = 0, fail = 0, inconclusive = 0, error = 0;
  for (const { flow } of aggregates) {
    if (flow.outcome === "PASS") pass++;
    else if (flow.outcome === "FAIL") fail++;
    else if (flow.outcome === "INCONCLUSIVE") inconclusive++;
    else error++;
  }

  // allPass per spec: all three non-pass counts zero AND pass count equals flow count.
  const allPass =
    fail === 0 &&
    inconclusive === 0 &&
    error === 0 &&
    pass === aggregates.length;

  const summary: CiSummary = {
    schemaVersion: CI_SUMMARY_SCHEMA_VERSION,
    allPass,
    counts: { pass, fail, inconclusive, error },
    flows: aggregates.map(({ flow }) => flow),
  };

  const summaryJson = serializeCiSummary(summary);
  const summaryMd = buildCiSummaryMd(aggregates);

  return { summary, summaryJson, summaryMd };
}
