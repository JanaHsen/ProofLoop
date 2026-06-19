import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlowFile } from "../src/parser";
import { readManifest } from "../src/run/audit";
import type { RawUsage } from "../src/run/pricing";
import { computePlanHash } from "../src/run/schema";
import { citationTextSurface } from "../src/verify/citation";
import type { Verdict } from "../src/verify/evaluation";
import type { EvidenceWindow } from "../src/verify/resolver";
import {
  finalizeCriterion,
  VERIFIER_PARAMS,
  type Verifier,
  type VerifierCriterionInput,
  type VerifierResult,
} from "../src/verify/verifier";
import { writeEvaluation } from "../src/verify/writer";

import {
  buildReport,
  ReportArtifactNotFoundError,
  ReportIntegrityError,
  UnsupportedEvaluationSchemaError,
} from "../src/report/builder";
import { escapeHtml, renderReportHtml } from "../src/report/html";
import { REPORT_SCHEMA_VERSION, type RunReport } from "../src/report/schema";
import { serializeReport, writeReport } from "../src/report/writer";
import { parseReportArgs } from "../src/report-cli";

// Same frozen Phase 2 exit run + real flow used by writer.test.ts: their planHash matches,
// so generating an evaluation against it and then reporting on it is a valid end-to-end path.
const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
const MODEL = "claude-opus-4-8"; // priced in the run's pricing config; no live call anywhere here
const USAGE: RawUsage = { input_tokens: 1000, output_tokens: 200 };
const LATENCY = 42;
const CLOCK = ["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"];

function fixedClock(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** The first ref with a non-empty citation surface, cited verbatim — a citation the harness accepts. */
function validObservation(window: EvidenceWindow): any {
  for (const snap of window.snapshots) {
    for (const ref of snap.refs) {
      const surface = citationTextSurface(snap, ref);
      if (surface.length > 0 && surface[0].length > 0) {
        return { label: "value", observedText: surface[0], snapshotId: snap.snapshotId, ref };
      }
    }
  }
  throw new Error("no citable ref in evidence window — fixture changed?");
}

function mockVerifier(verdict: Verdict): Verifier {
  return {
    async verify(input: VerifierCriterionInput): Promise<VerifierResult> {
      const raw = {
        verdict,
        observations: [validObservation(input.window)],
        eventObservations: [],
        reasoning: `decided ${verdict}`,
      };
      const evaluation = finalizeCriterion(input, raw, 1);
      return {
        evaluation,
        usage: { ...USAGE },
        latencyMs: LATENCY,
        model: MODEL,
        toolCallCount: 1,
        rawVerdict: verdict,
      };
    },
  };
}

/** Temp run dir (copy of the frozen run) with one generated evaluation. Caller removes `root`. */
async function tmpRunWithEval(
  verdict: Verdict,
): Promise<{ root: string; runDir: string; evaluationId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-report-"));
  const runDir = path.join(root, "run");
  fs.cpSync(FROZEN, runDir, { recursive: true });
  const { evaluationId } = await writeEvaluation({
    runDir,
    flowsDir: FLOWS_DIR,
    verifier: mockVerifier(verdict),
    verifierModel: MODEL,
    verifierParams: VERIFIER_PARAMS,
    clock: fixedClock(CLOCK),
  });
  return { root, runDir, evaluationId };
}

function evalPath(runDir: string, evaluationId: string): string {
  return path.join(runDir, "evaluations", evaluationId, "evaluation.json");
}
function readEvalFile(runDir: string, evaluationId: string): any {
  return JSON.parse(fs.readFileSync(evalPath(runDir, evaluationId), "utf8"));
}
function writeEvalFile(runDir: string, evaluationId: string, rec: any): void {
  fs.writeFileSync(evalPath(runDir, evaluationId), JSON.stringify(rec, null, 2) + "\n");
}

test("buildReport: valid PASS report projects source, flow, verdicts, and evidence", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const manifest = readManifest(runDir);
    const { report, jsonPath, htmlPath } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });

    assert.equal(report.reportSchemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(report.source.runId, manifest.runId);
    assert.equal(report.source.evaluationId, evaluationId);
    assert.equal(report.source.planHash, manifest.planHash);
    assert.equal(report.source.runLogSchemaVersion, "1.0");
    assert.equal(report.source.evaluationRecordSchemaVersion, "1.0");

    // flow projection: 5 NL steps + 3 NL criteria, preserved verbatim
    assert.equal(report.flow.id, "add-to-cart");
    assert.equal(report.flow.steps.length, 5);
    assert.equal(report.flow.criteria.length, 3);

    // execution metrics come from the manifest totals
    assert.equal(report.execution.status, "completed");
    assert.equal(report.execution.model, "claude-sonnet-4-6");
    assert.equal(report.execution.inputTokens, manifest.totals.promptTokens);
    assert.equal(report.execution.actionCount, manifest.totals.actionCount);

    // verification: three PASS criteria ⇒ PASS, each obs paired 1:1 with a valid citation
    assert.equal(report.verification.flowVerdict, "PASS");
    assert.equal(report.verification.model, MODEL);
    assert.equal(report.verification.criteria.length, 3);
    for (const c of report.verification.criteria) {
      assert.equal(c.verdict, "PASS");
      assert.ok(c.text.length > 0, "criterion text joined from FlowPlan");
      assert.equal(c.observations.length, c.citationValidations.length);
      assert.ok(c.observations.length >= 1);
      for (const obs of c.observations) {
        assert.ok(c.evidence.snapshotIds.includes(obs.snapshotId));
      }
    }

    // timeline carries step boundaries (text joined) and the terminal flow status
    assert.ok(report.timeline.length > 0);
    assert.ok(report.timeline.some((e) => e.type === "flow_end"));
    const firstStep = report.timeline.find((e) => e.type === "step_start");
    assert.ok(firstStep && typeof firstStep.stepText === "string" && firstStep.stepText.length > 0);

    // both artifacts exist; report.json round-trips to the returned object
    assert.ok(fs.existsSync(jsonPath) && fs.existsSync(htmlPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, "utf8")), report);
    const html = fs.readFileSync(htmlPath, "utf8");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: execution completed while the flow verdict is FAIL (distinct concepts)", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("FAIL");
  try {
    const { report } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    assert.equal(report.execution.status, "completed");
    assert.equal(report.verification.flowVerdict, "FAIL");
    assert.notEqual(report.execution.status, report.verification.flowVerdict);
    assert.ok(report.verification.criteria.every((c) => c.verdict === "FAIL"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: explicit evaluation selection — the named record is the one projected", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    assert.equal(evaluationId, "eval-001");
    // a second pass with a different verdict ⇒ eval-002 alongside eval-001
    const second = await writeEvaluation({
      runDir,
      flowsDir: FLOWS_DIR,
      verifier: mockVerifier("FAIL"),
      verifierModel: MODEL,
      verifierParams: VERIFIER_PARAMS,
      clock: fixedClock(CLOCK),
    });
    assert.equal(second.evaluationId, "eval-002");

    const first = buildReport({ runDir, evaluationId: "eval-001", flowsDir: FLOWS_DIR });
    const other = buildReport({ runDir, evaluationId: "eval-002", flowsDir: FLOWS_DIR });
    assert.equal(first.verification.flowVerdict, "PASS");
    assert.equal(other.verification.flowVerdict, "FAIL");
    assert.equal(first.source.evaluationId, "eval-001");
    assert.equal(other.source.evaluationId, "eval-002");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseReportArgs: requires BOTH flags; never defaults an evaluation", () => {
  assert.deepEqual(parseReportArgs(["--run", "r", "--evaluation", "eval-001"]), {
    runId: "r",
    evaluationId: "eval-001",
  });
  assert.deepEqual(parseReportArgs(["--evaluation", "eval-001", "--run", "r"]), {
    runId: "r",
    evaluationId: "eval-001",
  });
  assert.equal(parseReportArgs(["--run", "r"]), null, "missing --evaluation is not resolved");
  assert.equal(parseReportArgs(["--evaluation", "eval-001"]), null);
  assert.equal(parseReportArgs([]), null);
  assert.equal(parseReportArgs(["--run", "r", "--latest"]), null);
});

test("buildReport: a non-existent evaluation id fails loud (never falls back)", async () => {
  const { root, runDir } = await tmpRunWithEval("PASS");
  try {
    assert.throws(
      () => buildReport({ runDir, evaluationId: "eval-999", flowsDir: FLOWS_DIR }),
      ReportArtifactNotFoundError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: run-id mismatch between evaluation and run fails, writing nothing", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.runId = "add-to-cart-2026-01-01T00-00-00-000Z-deadbeef";
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
    assert.ok(!fs.existsSync(path.join(runDir, "reports")), "no report written on mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: flow-id mismatch fails", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.flowId = "checkout";
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: plan-hash mismatch (evaluation vs run) fails", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.planHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: plan-hash mismatch (current flow re-parse vs run) fails (D24)", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    // Move BOTH manifest and evaluation to the same bogus hash so the eval↔run check passes
    // and only the flow-reparse invariant can fire.
    const bogus = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const manifestPath = path.join(runDir, "run.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.planHash = bogus;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const rec = readEvalFile(runDir, evaluationId);
    rec.planHash = bogus;
    writeEvalFile(runDir, evaluationId, rec);

    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: a FlowPlan criterion missing from the evaluation fails", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.criteria.pop(); // drop add-to-cart:C3
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: a duplicated criterion in the evaluation fails", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.criteria.push(JSON.parse(JSON.stringify(rec.criteria[0]))); // duplicate C1
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: observation/citation length mismatch fails (never zip to shorter)", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.criteria[0].citationValidations.pop(); // 1 observation, 0 validations
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: an out-of-evidence-set citation fails", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const rec = readEvalFile(runDir, evaluationId);
    rec.criteria[0].observations[0].snapshotId = "snapshot-does-not-belong";
    writeEvalFile(runDir, evaluationId, rec);
    assert.throws(
      () => buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }),
      ReportIntegrityError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: accepts run-log schema version 1.1 through the supported-version check", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const manifestPath = path.join(runDir, "run.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.runLogSchemaVersion = "1.1";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const report = buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    assert.equal(report.source.runLogSchemaVersion, "1.1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildReport: action and error events project into the timeline (text + pageUrl joined)", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    // Append well-formed action + error events (run-log 1.1). The action references an existing
    // snapshot event (snapshot-005 → pageUrl) and step S2, so the join paths are exercised.
    const eventsPath = path.join(runDir, "events.jsonl");
    const runId = readManifest(runDir).runId;
    const action = {
      runLogSchemaVersion: "1.1",
      runId,
      seq: 9001,
      ts: "2026-06-18T21:35:00.000Z",
      type: "action",
      decisionId: "decision-x",
      snapshotId: "snapshot-005",
      snapshotDigest: "sha256:irrelevant",
      ref: "e16",
      action: "click",
      refValidation: { valid: true, validatedBy: "harness" },
      resolvedFrom: "snapshot-005",
      status: "failed",
      isError: true,
      failureDetail: "element not actionable",
      failureDetailTruncated: false,
      stepId: "add-to-cart:S2",
    };
    const errorEvent = {
      runLogSchemaVersion: "1.1",
      runId,
      seq: 9002,
      ts: "2026-06-18T21:35:01.000Z",
      type: "error",
      code: "INVALID_SNAPSHOT_REF",
      detail: "ref vanished",
      stepId: "add-to-cart:S2",
    };
    fs.appendFileSync(
      eventsPath,
      JSON.stringify(action) + "\n" + JSON.stringify(errorEvent) + "\n",
    );

    const report = buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    const act = report.timeline.find((e) => e.type === "action");
    assert.ok(act, "action event projected");
    assert.equal(act!.ref, "e16");
    assert.equal(act!.status, "failed");
    assert.equal(act!.pageUrl, "http://localhost:3000/"); // joined from snapshot-005 event
    assert.equal(act!.failureDetail, "element not actionable");
    assert.equal(act!.stepText, "Open the product list."); // joined from FlowPlan S2
    const err = report.timeline.find((e) => e.type === "error");
    assert.ok(err && err.code === "INVALID_SNAPSHOT_REF" && err.detail === "ref vanished");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serializeReport: deterministic report JSON is byte-identical across two builds", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const a = serializeReport(buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }));
    const b = serializeReport(buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR }));
    assert.equal(a, b);
    assert.ok(a.endsWith("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("report generation makes no live LLM call (works with no API key)", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const report = buildReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    assert.equal(report.verification.flowVerdict, "PASS");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- secret redaction at the reporting boundary (D29) ----------

// The real add-to-cart flow's step 1 embeds the SUT credential: the report must mask it.
const SECRET = "password123";

test("redaction: the authored credential never appears in report.json or report.html", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const { report, jsonPath, htmlPath } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    const jsonText = fs.readFileSync(jsonPath, "utf8");
    const htmlText = fs.readFileSync(htmlPath, "utf8");

    assert.ok(!jsonText.includes(SECRET), "report.json must not contain the raw credential");
    assert.ok(!htmlText.includes(SECRET), "report.html must not contain the raw credential");

    // The marker replaces it in the flow step and in the joined timeline step text.
    const s1 = report.flow.steps.find((s) => s.id === "add-to-cart:S1")!;
    assert.equal(s1.text, 'Sign in as "alice" with password "[REDACTED]".');
    const tl = report.timeline.find(
      (e) => e.stepId === "add-to-cart:S1" && e.stepText !== undefined,
    )!;
    assert.ok(tl.stepText!.includes("[REDACTED]") && !tl.stepText!.includes(SECRET));
    assert.ok(htmlText.includes("[REDACTED]"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: ordinary non-secret step and criterion text is untouched", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const { report } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    const s2 = report.flow.steps.find((s) => s.id === "add-to-cart:S2")!;
    assert.equal(s2.text, "Open the product list."); // no secret keyword => unchanged
    // criteria carry no secret literal and must read exactly as authored
    const c1 = report.flow.criteria.find((c) => c.id === "add-to-cart:C1")!;
    assert.ok(c1.text.startsWith("The Subtotal equals the sum of the line totals"));
    assert.ok(!c1.text.includes("[REDACTED]"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: the source FlowPlan and planHash are unchanged (masking is presentation-only)", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const manifest = readManifest(runDir);
    const { report } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });

    // Re-parsing the source flow still yields the credential and the SAME planHash.
    const plan = parseFlowFile(path.join(FLOWS_DIR, "add-to-cart.flow.md"));
    assert.ok(plan.steps[0].text.includes(SECRET), "source flow text is not mutated");
    assert.equal(computePlanHash(plan), manifest.planHash);
    assert.equal(report.source.planHash, manifest.planHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: HTML escaping still applies to the redacted step text", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    const { htmlPath } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    const htmlText = fs.readFileSync(htmlPath, "utf8");
    // The quotes around alice/[REDACTED] are HTML-escaped, proving escaping runs after masking.
    assert.ok(htmlText.includes('Sign in as &quot;alice&quot; with password &quot;[REDACTED]&quot;.'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redaction: a secret echoed into verifier output AND event strings is masked everywhere", async () => {
  const { root, runDir, evaluationId } = await tmpRunWithEval("PASS");
  try {
    // Echo the authored credential into verifier-derived fields (reasoning, observation
    // label/observedText/normalizedValue, citation reason) — these are not FlowPlan-derived.
    const rec = readEvalFile(runDir, evaluationId);
    const c0 = rec.criteria[0];
    c0.reasoning = `The page literally showed ${SECRET} in the field.`;
    c0.observations[0].label = `field containing ${SECRET}`;
    c0.observations[0].observedText = `value was ${SECRET}`;
    c0.observations[0].normalizedValue = `${SECRET}`;
    c0.citationValidations[0].reason = `matched ${SECRET}`;
    writeEvalFile(runDir, evaluationId, rec);

    // Echo it into runtime event strings too (event detail + scrubbed failure detail).
    const eventsPath = path.join(runDir, "events.jsonl");
    const runId = readManifest(runDir).runId;
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        runLogSchemaVersion: "1.1",
        runId,
        seq: 9101,
        ts: "2026-06-18T21:35:02.000Z",
        type: "action",
        decisionId: "d-x",
        snapshotId: "snapshot-005",
        snapshotDigest: "sha256:x",
        ref: "e16",
        action: "type",
        refValidation: { valid: true, validatedBy: "harness" },
        resolvedFrom: "snapshot-005",
        status: "failed",
        isError: true,
        failureDetail: `typing ${SECRET} failed`,
        stepId: "add-to-cart:S2",
      }) +
        "\n" +
        JSON.stringify({
          runLogSchemaVersion: "1.1",
          runId,
          seq: 9102,
          ts: "2026-06-18T21:35:03.000Z",
          type: "error",
          code: "INVALID_SNAPSHOT_REF",
          detail: `ref carried ${SECRET}`,
          stepId: "add-to-cart:S2",
        }) +
        "\n",
    );

    const { report, jsonPath, htmlPath } = writeReport({ runDir, evaluationId, flowsDir: FLOWS_DIR });
    const jsonText = fs.readFileSync(jsonPath, "utf8");
    const htmlText = fs.readFileSync(htmlPath, "utf8");

    // zero occurrences in either artifact
    assert.equal(jsonText.split(SECRET).length - 1, 0, "no credential in report.json");
    assert.equal(htmlText.split(SECRET).length - 1, 0, "no credential in report.html");

    // the marker landed in each projected human-readable field
    const rc0 = report.verification.criteria[0];
    assert.ok(rc0.reasoning.includes("[REDACTED]") && !rc0.reasoning.includes(SECRET));
    assert.ok(rc0.observations[0].observedText.includes("[REDACTED]"));
    assert.ok(rc0.observations[0].label.includes("[REDACTED]"));
    assert.equal(rc0.observations[0].normalizedValue, "[REDACTED]");
    assert.ok(rc0.citationValidations[0].reason!.includes("[REDACTED]"));
    const act = report.timeline.find((e) => e.type === "action" && e.failureDetail !== undefined)!;
    assert.ok(act.failureDetail!.includes("[REDACTED]") && !act.failureDetail!.includes(SECRET));
    const err = report.timeline.find((e) => e.type === "error")!;
    assert.ok(err.detail!.includes("[REDACTED]") && !err.detail!.includes(SECRET));

    // identifiers / booleans / verdict untouched; ordinary content unchanged
    assert.equal(rc0.observations[0].snapshotId, c0.observations[0].snapshotId);
    assert.equal(rc0.verdict, "PASS");
    assert.equal(report.flow.steps.find((s) => s.id === "add-to-cart:S2")!.text, "Open the product list.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- renderer-level tests (synthetic RunReport, no disk / no LLM) ----------

const XSS = `<script>alert(1)</script><img src=x onerror=y>"&'`;

function synthReport(over: Partial<RunReport> = {}): RunReport {
  const base: RunReport = {
    reportSchemaVersion: "1.0",
    source: {
      runId: "run-1",
      evaluationId: "eval-001",
      runLogSchemaVersion: "1.1",
      evaluationRecordSchemaVersion: "1.0",
      flowPlanSchemaVersion: "1.0",
      planHash: "sha256:abc",
    },
    flow: {
      id: "add-to-cart",
      name: `Flow ${XSS}`,
      description: `Desc ${XSS}`,
      entry: "/login",
      viewport: "desktop",
      steps: [{ id: "s:S1", ordinal: 1, text: `Step ${XSS}` }],
      criteria: [{ id: "s:C1", ordinal: 1, text: `Crit ${XSS}` }],
    },
    execution: {
      status: "completed",
      model: "claude-sonnet-4-6",
      actionCount: 1,
      errorCount: 0,
      retryCount: 0,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
      latencyMs: 5,
    },
    verification: {
      flowVerdict: "FAIL",
      model: "claude-opus-4-8",
      params: { temperature: 0 },
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.002,
      latencyMs: 5,
      criteria: [
        {
          criterionId: "s:C1",
          ordinal: 1,
          text: `Crit ${XSS}`,
          verdict: "FAIL",
          reasoning: `Reasoning ${XSS}`,
          observations: [
            {
              label: `Label ${XSS}`,
              observedText: `Observed ${XSS}`,
              snapshotId: "snapshot-001",
              ref: "e1",
              normalizedValue: `Norm ${XSS}`,
            },
            { label: "no-norm", observedText: "x", snapshotId: "snapshot-001", ref: "e2" },
          ],
          citationValidations: [
            {
              snapshotProvided: true,
              digestMatches: true,
              refPresent: false,
              observedTextPresent: false,
              valid: false,
              reason: `bad ${XSS}`,
            },
            {
              snapshotProvided: true,
              digestMatches: true,
              refPresent: true,
              observedTextPresent: true,
              valid: true,
            },
          ],
          evidence: { snapshotIds: ["snapshot-001"] },
        },
      ],
    },
    timeline: [
      {
        seq: 1,
        type: "action",
        stepId: "s:S1",
        stepText: `Step ${XSS}`,
        action: "click",
        ref: "e1",
        status: "failed",
        pageUrl: `http://evil/${XSS}`,
        failureDetail: `Failure ${XSS}`,
        failureDetailTruncated: true,
      },
      { seq: 2, type: "flow_end", executionStatus: "completed" },
    ],
  };
  return { ...base, ...over };
}

test("escapeHtml: escapes the five significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(escapeHtml(42), "42");
});

test("renderReportHtml: every artifact-derived field is escaped; no live tags injected", () => {
  const html = renderReportHtml(synthReport());
  // No raw markup from artifact data survives anywhere in the document: with `<`/`>` escaped
  // every injected tag is inert text (a surviving escaped `onerror=` substring is harmless —
  // it can never be an attribute once its enclosing `<...>` is escaped).
  assert.ok(!html.includes("<script"), "no <script tag");
  assert.ok(!html.includes("<img"), "no <img tag");
  // The payload is present, but only in escaped form — covers flow/evidence/reasoning/event text.
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("Reasoning &lt;script&gt;"));
  assert.ok(html.includes("Observed &lt;script&gt;"));
  assert.ok(html.includes("Failure &lt;script&gt;"));
  // self-contained: no external resources
  assert.ok(!/<link\b/i.test(html) && !/src\s*=\s*["']https?:/i.test(html));
});

test("renderReportHtml: invalid citation checks render visibly", () => {
  const html = renderReportHtml(synthReport());
  assert.ok(html.includes("citation-invalid"), "invalid citation row is marked");
  assert.ok(html.includes("check-bad"), "a failed check is highlighted, not hidden");
});

test("renderReportHtml: normalizedValue renders only when present", () => {
  const html = renderReportHtml(synthReport());
  const count = html.split("normalized:").length - 1;
  assert.equal(count, 1, "exactly one observation carried a normalizedValue");
});

test("renderReportHtml: an optional aiSummary renders when present and is escaped", () => {
  const html = renderReportHtml(
    synthReport({
      aiSummary: {
        text: `Summary ${XSS}`,
        model: "claude-haiku-4-5",
        params: {},
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0.0001,
        latencyMs: 3,
        generatedAt: "2026-06-19T00:00:00.000Z",
      },
    }),
  );
  assert.ok(html.includes("AI summary"));
  assert.ok(html.includes("Summary &lt;script&gt;"));
  assert.ok(!html.includes("<script"));
});
