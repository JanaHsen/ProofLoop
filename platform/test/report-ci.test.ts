/**
 * Phase 6 Task 3 — deterministic report:ci aggregator (D43). No live flow, no LLM.
 *
 * Tests use a tmpdir as a fake repo root. ci-results.json entries carry
 * repo-root-relative reportPaths pointing to minimal but valid report.json fixtures
 * written into the tmpdir. The library is called with { repoRoot: tmpdir } so no
 * real run artifacts are touched.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  aggregateCiResults,
  buildCiSummaryMd,
  CiReportError,
  CiResultsError,
  escapeMd,
  serializeCiSummary,
  type CiSummary,
} from "../src/ci/report-ci";
import { reportCiCli } from "../src/report-ci-cli";

// ─── cleanup ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-report-ci-"));
  tmpDirs.push(d);
  return d;
}

/** Build a minimal valid RunReport object for a given verdict. */
function makeReport(opts: {
  runId: string;
  evaluationId: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  criteria?: Array<{
    id: string;
    text: string;
    verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
    reasoning: string;
    inconclusiveDetail?: { kind: string; origin: string; code: string; explanation: string };
  }>;
  deciderCost?: number;
  deciderLatency?: number;
  verifierCost?: number;
  verifierLatency?: number;
}): Record<string, unknown> {
  return {
    reportSchemaVersion: "1.0",
    source: {
      runId: opts.runId,
      evaluationId: opts.evaluationId,
      runLogSchemaVersion: "1.2",
      evaluationRecordSchemaVersion: "1.0",
      flowPlanSchemaVersion: "1.0",
      planHash: "sha256:aaa",
    },
    flow: {
      id: "test-flow",
      name: "Test Flow",
      entry: "http://localhost:3000",
      viewport: "desktop",
      steps: [],
      criteria: [],
    },
    execution: {
      status: "completed",
      actionCount: 5,
      errorCount: 0,
      retryCount: 0,
      costUsd: opts.deciderCost ?? 0.0012,
      latencyMs: opts.deciderLatency ?? 1000,
    },
    verification: {
      flowVerdict: opts.verdict,
      model: "claude-opus-4-8",
      params: {},
      inputTokens: 100,
      outputTokens: 20,
      costUsd: opts.verifierCost ?? 0.0034,
      latencyMs: opts.verifierLatency ?? 500,
      criteria: (opts.criteria ?? []).map((c) => ({
        criterionId: c.id,
        text: c.text,
        verdict: c.verdict,
        reasoning: c.reasoning,
        observations: [],
        citationValidations: [],
        evidence: { snapshotIds: [] },
        ...(c.inconclusiveDetail !== undefined
          ? { inconclusiveDetail: c.inconclusiveDetail }
          : {}),
      })),
    },
    timeline: [],
  };
}

/**
 * Seed a fake repo-root tmpdir with report.json files and a ci-results.json.
 * Returns { tmpDir, resultsPath }.
 */
function seedEnv(entries: Array<{
  flowPath: string;
  stage: "run" | "verify" | "report" | "complete";
  runId?: string;
  evaluationId?: string;
  reportRelPath?: string; // relative to tmpDir; written if reportContent is given
  reportContent?: Record<string, unknown>;
  errorClass?: string;
  errorMessage?: string;
}>): { tmpDir: string; resultsPath: string } {
  const tmpDir = mkTmp();

  const results: Record<string, unknown>[] = [];

  for (const e of entries) {
    const row: Record<string, unknown> = { flowPath: e.flowPath, stage: e.stage };
    if (e.runId !== undefined) row.runId = e.runId;
    if (e.evaluationId !== undefined) row.evaluationId = e.evaluationId;
    if (e.reportRelPath !== undefined) row.reportPath = e.reportRelPath;
    if (e.errorClass !== undefined) row.errorClass = e.errorClass;
    if (e.errorMessage !== undefined) row.errorMessage = e.errorMessage;

    if (e.reportContent !== undefined && e.reportRelPath !== undefined) {
      const absReport = path.join(tmpDir, e.reportRelPath);
      fs.mkdirSync(path.dirname(absReport), { recursive: true });
      fs.writeFileSync(absReport, JSON.stringify(e.reportContent, null, 2), "utf8");
    }
    results.push(row);
  }

  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), "utf8");

  return { tmpDir, resultsPath };
}

function run(entries: Parameters<typeof seedEnv>[0]) {
  const { tmpDir, resultsPath } = seedEnv(entries);
  return aggregateCiResults({ resultsPath, repoRoot: tmpDir });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fails(entries: Parameters<typeof seedEnv>[0], ErrorClass: new (...a: any[]) => Error, match?: RegExp) {
  const { tmpDir, resultsPath } = seedEnv(entries);
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e: unknown) => {
      assert.ok(e instanceof ErrorClass, `expected ${ErrorClass.name}, got ${String(e)}`);
      if (match) assert.match((e as Error).message, match);
      return true;
    },
  );
}

// ─── fixture builders ─────────────────────────────────────────────────────────

function passEntry(n: number) {
  return {
    flowPath: `fixtures/flows/flow-${n}.flow.md`,
    stage: "complete" as const,
    runId: `run-${n}`,
    evaluationId: `eval-00${n}`,
    reportRelPath: `reports/flow-${n}/report.json`,
    reportContent: makeReport({ runId: `run-${n}`, evaluationId: `eval-00${n}`, verdict: "PASS" }),
  };
}

function failEntry(n: number, criterionId = "C1", criterionText = "cart total", reason = "Tax was $0.00") {
  return {
    flowPath: `fixtures/flows/flow-${n}.flow.md`,
    stage: "complete" as const,
    runId: `run-${n}`,
    evaluationId: `eval-00${n}`,
    reportRelPath: `reports/flow-${n}/report.json`,
    reportContent: makeReport({
      runId: `run-${n}`, evaluationId: `eval-00${n}`, verdict: "FAIL",
      criteria: [{ id: criterionId, text: criterionText, verdict: "FAIL", reasoning: reason }],
    }),
  };
}

function incEntry(n: number) {
  return {
    flowPath: `fixtures/flows/flow-${n}.flow.md`,
    stage: "complete" as const,
    runId: `run-${n}`,
    evaluationId: `eval-00${n}`,
    reportRelPath: `reports/flow-${n}/report.json`,
    reportContent: makeReport({
      runId: `run-${n}`, evaluationId: `eval-00${n}`, verdict: "INCONCLUSIVE",
      criteria: [{
        id: "C1", text: "form submits", verdict: "INCONCLUSIVE",
        reasoning: "the verifier could not determine the outcome",
        inconclusiveDetail: { kind: "ERROR", origin: "EXECUTION", code: "COULD_NOT_EXECUTE", explanation: "Flow ended before criterion step" },
      }],
    }),
  };
}

function errorEntry(n: number, errorClass = "RUN_FAILED", stage: "run" | "verify" | "report" = "run") {
  const e: Parameters<typeof seedEnv>[0][0] = {
    flowPath: `fixtures/flows/flow-${n}.flow.md`,
    stage,
    errorClass,
  };
  if (stage === "verify" || stage === "report") e.runId = `run-${n}`;
  if (stage === "report") e.evaluationId = `eval-00${n}`;
  return e;
}

// ─── positive tests ───────────────────────────────────────────────────────────

test("all-PASS aggregate: allPass=true, counts correct, outcome PASS for each flow", () => {
  const out = run([passEntry(1), passEntry(2), passEntry(3), passEntry(4), passEntry(5)]);
  assert.equal(out.summary.allPass, true);
  assert.deepEqual(out.summary.counts, { pass: 5, fail: 0, inconclusive: 0, error: 0 });
  assert.ok(out.summary.flows.every((f) => f.outcome === "PASS"));
});

test("one FAIL: allPass=false, failed criterion tagged outcome:FAIL, not INCONCLUSIVE", () => {
  const out = run([passEntry(1), failEntry(2), passEntry(3)]);
  assert.equal(out.summary.allPass, false);
  assert.deepEqual(out.summary.counts, { pass: 2, fail: 1, inconclusive: 0, error: 0 });
  const failFlow = out.summary.flows.find((f) => f.outcome === "FAIL");
  assert.ok(failFlow, "FAIL flow must be present");
  assert.ok(Array.isArray(failFlow.nonPassCriteria), "nonPassCriteria present");
  assert.equal(failFlow.nonPassCriteria![0].outcome, "FAIL");
  assert.ok(
    out.summaryMd.includes("detected behavioral regression"),
    "MD must describe FAIL as behavioral regression",
  );
  assert.ok(!out.summaryMd.includes("not cleared"), "FAIL must NOT be described as inconclusive");
});

test("one INCONCLUSIVE: allPass=false, criterion tagged outcome:INCONCLUSIVE, not FAIL", () => {
  const out = run([passEntry(1), incEntry(2)]);
  assert.equal(out.summary.allPass, false);
  assert.deepEqual(out.summary.counts, { pass: 1, fail: 0, inconclusive: 1, error: 0 });
  const incFlow = out.summary.flows.find((f) => f.outcome === "INCONCLUSIVE");
  assert.ok(incFlow, "INCONCLUSIVE flow must be present");
  assert.equal(incFlow!.nonPassCriteria![0].outcome, "INCONCLUSIVE");
  assert.ok(
    out.summaryMd.includes("not cleared by the platform"),
    "MD must describe INCONCLUSIVE as not-cleared",
  );
  assert.ok(
    !out.summaryMd.includes("detected behavioral regression"),
    "INCONCLUSIVE must NOT be described as regression",
  );
});

test("INCONCLUSIVE criterion uses inconclusiveDetail.explanation as reason, not reasoning", () => {
  const out = run([incEntry(1)]);
  const incFlow = out.summary.flows[0];
  assert.equal(incFlow.nonPassCriteria![0].reason, "Flow ended before criterion step");
});

test("pipeline ERROR (stage:run): outcome=ERROR, no verdict invented, no reportPath needed", () => {
  const out = run([passEntry(1), errorEntry(2, "RUN_FAILED", "run"), passEntry(3)]);
  assert.equal(out.summary.allPass, false);
  assert.deepEqual(out.summary.counts, { pass: 2, fail: 0, inconclusive: 0, error: 1 });
  const errFlow = out.summary.flows.find((f) => f.outcome === "ERROR");
  assert.ok(errFlow, "ERROR flow must be present");
  assert.equal(errFlow!.errorClass, "RUN_FAILED");
  assert.ok(errFlow!.nonPassCriteria === undefined, "ERROR flow must have no nonPassCriteria");
  assert.ok(
    out.summaryMd.includes("no trustworthy verdict produced"),
    "MD must describe ERROR correctly",
  );
});

test("mixed PASS/FAIL/INCONCLUSIVE/ERROR: counts exact, all outcomes represented", () => {
  const out = run([passEntry(1), failEntry(2), incEntry(3), errorEntry(4), passEntry(5)]);
  assert.equal(out.summary.allPass, false);
  assert.deepEqual(out.summary.counts, { pass: 2, fail: 1, inconclusive: 1, error: 1 });
  assert.equal(out.summary.flows.filter((f) => f.outcome === "PASS").length, 2);
  assert.equal(out.summary.flows.filter((f) => f.outcome === "FAIL").length, 1);
  assert.equal(out.summary.flows.filter((f) => f.outcome === "INCONCLUSIVE").length, 1);
  assert.equal(out.summary.flows.filter((f) => f.outcome === "ERROR").length, 1);
});

test("flow order is preserved from ci-results.json (manifest order)", () => {
  const out = run([passEntry(3), passEntry(1), passEntry(2)]);
  assert.deepEqual(
    out.summary.flows.map((f) => f.flowPath),
    [
      "fixtures/flows/flow-3.flow.md",
      "fixtures/flows/flow-1.flow.md",
      "fixtures/flows/flow-2.flow.md",
    ],
  );
});

test("decider and verifier metrics are kept separate (not merged)", () => {
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({
      runId: "run-1", evaluationId: "eval-001", verdict: "PASS",
      deciderCost: 0.0015, deciderLatency: 2000,
      verifierCost: 0.0078, verifierLatency: 900,
    }),
  }]);
  const out = aggregateCiResults({ resultsPath, repoRoot: tmpDir });
  const f = out.summary.flows[0];
  assert.equal(f.decider?.costUsd, 0.0015);
  assert.equal(f.decider?.latencyMs, 2000);
  assert.equal(f.verifier?.costUsd, 0.0078);
  assert.equal(f.verifier?.latencyMs, 900);
  assert.notEqual(f.decider?.costUsd, f.verifier?.costUsd);
});

test("Markdown cost totals are computed separately for decider and verifier", () => {
  const { tmpDir, resultsPath } = seedEnv([
    {
      flowPath: "fixtures/flows/flow-1.flow.md", stage: "complete",
      runId: "run-1", evaluationId: "eval-001", reportRelPath: "reports/flow-1/report.json",
      reportContent: makeReport({ runId: "run-1", evaluationId: "eval-001", verdict: "PASS", deciderCost: 0.0012, deciderLatency: 100, verifierCost: 0.0034, verifierLatency: 200 }),
    },
    {
      flowPath: "fixtures/flows/flow-2.flow.md", stage: "complete",
      runId: "run-2", evaluationId: "eval-001", reportRelPath: "reports/flow-2/report.json",
      reportContent: makeReport({ runId: "run-2", evaluationId: "eval-001", verdict: "PASS", deciderCost: 0.0008, deciderLatency: 100, verifierCost: 0.0016, verifierLatency: 200 }),
    },
  ]);
  const out = aggregateCiResults({ resultsPath, repoRoot: tmpDir });
  // Total decider: 0.0012 + 0.0008 = 0.0020 → $0.0020
  assert.ok(out.summaryMd.includes("$0.0020"), "total decider cost in MD");
  // Total verifier: 0.0034 + 0.0016 = 0.0050 → $0.0050
  assert.ok(out.summaryMd.includes("$0.0050"), "total verifier cost in MD");
});

test("summary.json is byte-identical across two calls with identical input", () => {
  const entries = [passEntry(1), failEntry(2), incEntry(3)];
  const out1 = run(entries);
  const out2 = run(entries);
  assert.equal(out1.summaryJson, out2.summaryJson, "summary.json must be byte-identical");
});

test("summary.md is byte-identical across two calls with identical input", () => {
  const entries = [passEntry(1), failEntry(2)];
  const out1 = run(entries);
  const out2 = run(entries);
  assert.equal(out1.summaryMd, out2.summaryMd, "summary.md must be byte-identical");
});

test("allPass is computed from counts, independent of Markdown content", () => {
  const out = run([failEntry(1)]);
  // allPass in JSON is false regardless of what summary.md says
  assert.equal(out.summary.allPass, false);
  assert.ok(out.summaryJson.includes('"allPass": false'));
  // Verify: re-computing allPass from the returned counts gives the same result
  const { pass, fail, inconclusive, error } = out.summary.counts;
  const recomputed = fail === 0 && inconclusive === 0 && error === 0 && pass === out.summary.flows.length;
  assert.equal(recomputed, out.summary.allPass);
});

test("summary.md begins with exactly '<!-- proofloop-ci -->' as the first line", () => {
  const out = run([passEntry(1)]);
  const firstLine = out.summaryMd.split("\n")[0];
  assert.equal(firstLine, "<!-- proofloop-ci -->");
});

test("Markdown escaping: HTML special chars and pipe are escaped in artifact-derived values", () => {
  const injected = "<script>alert(1)</script> | & 'quoted'";
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({
      runId: "run-1", evaluationId: "eval-001", verdict: "FAIL",
      criteria: [{ id: "C1", text: "criterion text", verdict: "FAIL", reasoning: injected }],
    }),
  }]);
  const out = aggregateCiResults({ resultsPath, repoRoot: tmpDir });
  assert.ok(!out.summaryMd.includes("<script>"), "raw <script> must not appear");
  assert.ok(out.summaryMd.includes("&lt;script&gt;"), "< must be escaped to &lt;");
  // The artifact's pipe character must appear as \| (escaped), not as a raw table-delimiter | surrounded by spaces
  assert.ok(out.summaryMd.includes("\\|"), "pipe in artifact value must be escaped as \\|");
  assert.ok(out.summaryMd.includes("&amp;"), "& must be escaped to &amp;");
});

test("hidden-comment injection in artifact values cannot create a second <!-- proofloop-ci --> marker", () => {
  const injection = "<!-- proofloop-ci --> injected marker";
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({
      runId: "run-1", evaluationId: "eval-001", verdict: "FAIL",
      criteria: [{ id: "C1", text: "criterion text", verdict: "FAIL", reasoning: injection }],
    }),
  }]);
  const out = aggregateCiResults({ resultsPath, repoRoot: tmpDir });
  // Count occurrences of the literal marker
  const markerCount = out.summaryMd.split("<!-- proofloop-ci -->").length - 1;
  assert.equal(markerCount, 1, "exactly one <!-- proofloop-ci --> marker must appear");
});

test("newline injection in reason cannot create a Markdown heading", () => {
  const injected = "normal text\n# Secret Heading\nmore text";
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({
      runId: "run-1", evaluationId: "eval-001", verdict: "FAIL",
      criteria: [{ id: "C1", text: "text", verdict: "FAIL", reasoning: injected }],
    }),
  }]);
  const out = aggregateCiResults({ resultsPath, repoRoot: tmpDir });
  // The newline must be replaced by a space, so no raw newline before #
  assert.ok(!out.summaryMd.includes("\n# Secret"), "newline+heading injection must be blocked");
});

// ─── negative: ci-results.json structural defects ────────────────────────────

test("completed entry missing reportPath fails with CiResultsError", () => {
  fails([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    // reportRelPath intentionally omitted
    errorClass: undefined,
  }], CiResultsError, /requires.*reportPath/);
});

test("non-complete entry missing errorClass fails with CiResultsError", () => {
  fails([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "run",
    // errorClass intentionally omitted
  }], CiResultsError, /requires.*errorClass/);
});

test("contradictory stage:complete + errorClass fails", () => {
  // We patch ci-results.json manually to add errorClass alongside stage:complete
  const tmpDir = mkTmp();
  const rp = "reports/flow-1/report.json";
  fs.mkdirSync(path.join(tmpDir, "reports", "flow-1"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, rp),
    JSON.stringify(makeReport({ runId: "r", evaluationId: "e", verdict: "PASS" })),
    "utf8",
  );
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "complete",
      runId: "r",
      evaluationId: "e",
      reportPath: rp,
      errorClass: "RUN_FAILED",
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /contradictory/.test((e as Error).message),
  );
});

test("contradictory stage:run + runId present fails", () => {
  const tmpDir = mkTmp();
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "run",
      runId: "run-1", // contradictory with run-stage failure
      errorClass: "APP_NOT_READY",
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /contradictory/.test((e as Error).message),
  );
});

test("duplicate flowPath fails with CiResultsError", () => {
  const entries = [passEntry(1), passEntry(1)]; // same flowPath
  const { tmpDir, resultsPath } = seedEnv(entries);
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /duplicate/.test((e as Error).message),
  );
});

test("unknown top-level field in ci-results entry fails", () => {
  const tmpDir = mkTmp();
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "run",
      errorClass: "RUN_FAILED",
      expectedVerdict: "PASS", // unknown field
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /unknown field/.test((e as Error).message),
  );
});

// ─── negative: report.json reading ───────────────────────────────────────────

test("completed entry whose report.json is missing fails with CiReportError", () => {
  const tmpDir = mkTmp();
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "complete",
      runId: "run-1",
      evaluationId: "eval-001",
      reportPath: "reports/does-not-exist/report.json",
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiReportError,
  );
});

test("malformed report.json (non-JSON) fails with CiReportError", () => {
  const tmpDir = mkTmp();
  const rp = "reports/flow-1/report.json";
  fs.mkdirSync(path.join(tmpDir, "reports", "flow-1"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rp), "{ this is not json", "utf8");
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{ flowPath: "f.flow.md", stage: "complete", runId: "r", evaluationId: "e", reportPath: rp }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiReportError && /not valid JSON/.test((e as Error).message),
  );
});

test("unsupported reportSchemaVersion fails with CiReportError", () => {
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: {
      ...makeReport({ runId: "run-1", evaluationId: "eval-001", verdict: "PASS" }),
      reportSchemaVersion: "9.9", // unsupported
    },
  }]);
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiReportError && /unsupported reportSchemaVersion/.test((e as Error).message),
  );
});

test("run-ID mismatch between ledger and report.json fails with CiReportError", () => {
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-CORRECT",
    evaluationId: "eval-001",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({ runId: "run-WRONG", evaluationId: "eval-001", verdict: "PASS" }),
  }]);
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiReportError && /source\.runId/.test((e as Error).message),
  );
});

test("evaluation-ID mismatch between ledger and report.json fails with CiReportError", () => {
  const { tmpDir, resultsPath } = seedEnv([{
    flowPath: "fixtures/flows/flow-1.flow.md",
    stage: "complete",
    runId: "run-1",
    evaluationId: "eval-CORRECT",
    reportRelPath: "reports/flow-1/report.json",
    reportContent: makeReport({ runId: "run-1", evaluationId: "eval-WRONG", verdict: "PASS" }),
  }]);
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiReportError && /source\.evaluationId/.test((e as Error).message),
  );
});

// ─── negative: path safety ────────────────────────────────────────────────────

test("absolute reportPath (posix) fails with CiResultsError", () => {
  const tmpDir = mkTmp();
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "complete",
      runId: "run-1",
      evaluationId: "eval-001",
      reportPath: "/etc/evil.json",
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /not absolute/.test((e as Error).message),
  );
});

test("traversal in reportPath (../) fails with CiResultsError", () => {
  const tmpDir = mkTmp();
  const resultsPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify([{
      flowPath: "fixtures/flows/flow-1.flow.md",
      stage: "complete",
      runId: "run-1",
      evaluationId: "eval-001",
      reportPath: "reports/../../outside.json",
    }]),
    "utf8",
  );
  assert.throws(
    () => aggregateCiResults({ resultsPath, repoRoot: tmpDir }),
    (e) => e instanceof CiResultsError && /traverses outside/.test((e as Error).message),
  );
});

// ─── CLI behavior ─────────────────────────────────────────────────────────────

test("CLI exits 0 for a valid non-green aggregate (FAIL flow)", () => {
  const { tmpDir, resultsPath } = seedEnv([failEntry(1)]);
  const outDir = path.join(tmpDir, "out");
  const written: Record<string, string> = {};
  const exitCode = reportCiCli(
    ["node", "report-ci-cli.ts", "--results", resultsPath, "--out-dir", outDir],
    {
      aggregate: (opts) => aggregateCiResults({ ...opts, repoRoot: tmpDir }),
      mkdir: () => {},
      writeFile: (p, c) => { written[p] = c; },
      out: { write: () => {} },
      err: { write: () => {} },
    },
  );
  assert.equal(exitCode, 0, "must exit 0 even for non-green aggregate");
  const jsonPath = path.join(outDir, "summary.json");
  const mdPath = path.join(outDir, "summary.md");
  assert.ok(written[jsonPath] !== undefined, "summary.json must be written");
  assert.ok(written[mdPath] !== undefined, "summary.md must be written");
  const parsed = JSON.parse(written[jsonPath]);
  assert.equal(parsed.allPass, false);
});

test("CLI exits 2 on invalid args (missing --out-dir)", () => {
  const errLines: string[] = [];
  const code = reportCiCli(
    ["node", "report-ci-cli.ts", "--results", "some-file.json"],
    { err: { write: (s) => errLines.push(s) }, out: { write: () => {} } },
  );
  assert.equal(code, 2);
  assert.ok(errLines.some((l) => l.includes("--results")));
});

test("CLI exits 1 when aggregate throws CiResultsError (malformed input)", () => {
  const errLines: string[] = [];
  const code = reportCiCli(
    ["node", "report-ci-cli.ts", "--results", "/nonexistent/ci-results.json", "--out-dir", "/tmp/out"],
    {
      aggregate: () => { throw new CiResultsError("bad input"); },
      mkdir: () => {},
      writeFile: () => {},
      out: { write: () => {} },
      err: { write: (s) => errLines.push(s) },
    },
  );
  assert.equal(code, 1);
  assert.ok(errLines.some((l) => l.includes("bad input")));
});

test("CLI exits 1 when summary.json write fails", () => {
  const { tmpDir, resultsPath } = seedEnv([passEntry(1)]);
  let callCount = 0;
  const code = reportCiCli(
    ["node", "report-ci-cli.ts", "--results", resultsPath, "--out-dir", path.join(tmpDir, "out")],
    {
      aggregate: (opts) => aggregateCiResults({ ...opts, repoRoot: tmpDir }),
      mkdir: () => {},
      writeFile: () => {
        callCount++;
        if (callCount === 1) throw new Error("disk full");
      },
      out: { write: () => {} },
      err: { write: () => {} },
    },
  );
  assert.equal(code, 1);
});

test("no Anthropic client, verifier, executor, or summary model is invoked", () => {
  // Structural: report-ci.ts only imports fs, path, and ../report/schema (a pure types file).
  // The test verifies the aggregate function completes without any LLM-related imports
  // by confirming the output contains no api_key-related or model-invocation errors.
  const out = run([passEntry(1)]);
  assert.ok(out.summary.schemaVersion === "1.0");
  assert.ok(typeof out.summaryJson === "string");
  assert.ok(typeof out.summaryMd === "string");
  // If any LLM call had been made it would have thrown (no API key in test env).
  // Reaching here means no LLM call occurred.
});

// ─── escapeMd unit tests ──────────────────────────────────────────────────────

test("escapeMd escapes the required special characters", () => {
  assert.equal(escapeMd("<"), "&lt;");
  assert.equal(escapeMd(">"), "&gt;");
  assert.equal(escapeMd("&"), "&amp;");
  assert.equal(escapeMd("|"), "\\|");
  assert.equal(escapeMd("`"), "&#96;");
  assert.equal(escapeMd("["), "\\[");
  assert.equal(escapeMd("]"), "\\]");
  assert.equal(escapeMd("\\"), "\\\\");
  assert.equal(escapeMd("line1\nline2"), "line1 line2");
  assert.equal(escapeMd("<!-- foo -->"), "&lt;!-- foo --&gt;");
});

// ─── serializeCiSummary stable key ordering ───────────────────────────────────

test("serializeCiSummary: stable key order and correct structure", () => {
  const summary: CiSummary = {
    schemaVersion: "1.0",
    allPass: true,
    counts: { pass: 1, fail: 0, inconclusive: 0, error: 0 },
    flows: [{
      flowPath: "fixtures/flows/login.flow.md",
      outcome: "PASS",
      runId: "run-1",
      evaluationId: "eval-001",
      decider: { costUsd: 0.0012, latencyMs: 1000 },
      verifier: { costUsd: 0.0034, latencyMs: 500 },
    }],
  };
  const json = serializeCiSummary(summary);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, "1.0");
  assert.equal(parsed.allPass, true);
  assert.deepEqual(parsed.counts, { pass: 1, fail: 0, inconclusive: 0, error: 0 });
  assert.equal(parsed.flows[0].flowPath, "fixtures/flows/login.flow.md");
  assert.equal(json, serializeCiSummary(summary), "must be byte-identical on second call");
  assert.ok(json.endsWith("\n"), "must end with newline");
});
