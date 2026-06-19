/**
 * Phase 5 Task 7 — deterministic parity artifact generator tests. Frozen/mocked artifacts
 * only; NO live API, browser, decider, verifier, or summarizer. Proves the integrity rules,
 * byte-determinism, the verbatim caveat, and the absence of secrets/args/paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PARITY_CAVEAT,
  PARITY_REPORT_SCHEMA_VERSION,
  ParityIntegrityError,
  buildParityReport,
  serializeParityReport,
  writeParityReport,
  type CheckpointProof,
  type ParityReportSources,
} from "../src/parity/parity-report";
import { parseParityArgs } from "../src/parity/parity-report-cli";
import type { BrowserConfig, RunManifest } from "../src/run/schema";
import type { EvaluationRecord, Verdict } from "../src/verify/evaluation";

const BROWSER: BrowserConfig = {
  engine: "chromium",
  isolated: true,
  viewport: { width: 1280, height: 720 },
  accessibilitySnapshots: true,
  visionEnabled: false,
};
const HEADED_RID = "add-to-cart-headed";
const HEADLESS_RID = "add-to-cart-headless";

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runLogSchemaVersion: "1.2",
    runId: "RID",
    flowId: "add-to-cart",
    planHash: "sha256:plan",
    model: "claude-sonnet-4-6",
    mode: "headless",
    requestedMode: "headless",
    browser: BROWSER,
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:01:00.000Z",
    executionStatus: "completed",
    pricingConfigId: "anthropic-2026-06",
    totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, snapshotCount: 0, actionCount: 0, errorCount: 0, retryCount: 0 },
    ...over,
  };
}
function evaluation(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    evaluationRecordSchemaVersion: "1.0",
    evaluationId: "eval-001",
    runId: "RID",
    flowId: "add-to-cart",
    planHash: "sha256:plan",
    verifierModel: "claude-opus-4-8",
    verifierParams: { temperature: 0 },
    pricingConfigId: "anthropic-2026-06",
    startedAt: "2026-06-19T00:02:00.000Z",
    finishedAt: "2026-06-19T00:02:05.000Z",
    flowVerdict: "PASS",
    criteria: [],
    totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 },
    ...over,
  };
}

interface RunSpec {
  manifest: RunManifest;
  evaluation: EvaluationRecord;
  auditOk?: boolean;
}

function headedRun(over: { manifest?: Partial<RunManifest>; evaluation?: Partial<EvaluationRecord>; auditOk?: boolean } = {}): RunSpec {
  return {
    manifest: manifest({ runId: HEADED_RID, mode: "headed", requestedMode: "headed", ...over.manifest }),
    evaluation: evaluation({ runId: HEADED_RID, ...over.evaluation }),
    auditOk: over.auditOk ?? true,
  };
}
function headlessRun(over: { manifest?: Partial<RunManifest>; evaluation?: Partial<EvaluationRecord>; auditOk?: boolean } = {}): RunSpec {
  return {
    manifest: manifest({ runId: HEADLESS_RID, mode: "headless", requestedMode: "headless", ...over.manifest }),
    evaluation: evaluation({ runId: HEADLESS_RID, ...over.evaluation }),
    auditOk: over.auditOk ?? true,
  };
}

const created: string[] = [];
function mkSources(runs: Record<string, RunSpec>, opts: Partial<ParityReportSources> = {}): ParityReportSources {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parity-report-"));
  created.push(runsRoot);
  for (const id of Object.keys(runs)) fs.mkdirSync(path.join(runsRoot, id), { recursive: true });
  return {
    runsRoot,
    flowsDir: "/flows",
    loadManifest: (runDir) => runs[path.basename(runDir)].manifest,
    loadEvaluation: (runDir) => runs[path.basename(runDir)].evaluation,
    auditChain: (runDir) => ({ ok: runs[path.basename(runDir)].auditOk ?? true }),
    reparsePlanHash: (_flowsDir, _flowId) => "sha256:plan",
    ...opts,
  };
}

const INPUTS = {
  headedRunId: HEADED_RID,
  headedEvaluationId: "eval-001",
  headlessRunId: HEADLESS_RID,
  headlessEvaluationId: "eval-001",
};
const VALID = () => ({ [HEADED_RID]: headedRun(), [HEADLESS_RID]: headlessRun() });

test.after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// 1 ---------------------------------------------------------------------------------
test("Task7: a valid headed/headless pair produces schema 1.0", () => {
  const r = buildParityReport(INPUTS, mkSources(VALID()));
  assert.equal(r.parityReportSchemaVersion, "1.0");
  assert.equal(PARITY_REPORT_SCHEMA_VERSION, "1.0");
  assert.equal(r.demonstration.headed.effectiveMode, "headed");
  assert.equal(r.demonstration.headless.effectiveMode, "headless");
  assert.equal(r.demonstration.sameVerdict, true);
  assert.equal(r.flow.flowId, "add-to-cart");
});

// 2 ---------------------------------------------------------------------------------
test("Task7: JSON bytes are identical across repeated generation", () => {
  const s = mkSources(VALID());
  const a = serializeParityReport(buildParityReport(INPUTS, s));
  const b = serializeParityReport(buildParityReport(INPUTS, s));
  assert.equal(a, b);
});

// 3 ---------------------------------------------------------------------------------
test("Task7: explicit run+evaluation selection is required (CLI never picks latest)", () => {
  assert.equal(parseParityArgs([]).ok, false);
  assert.equal(parseParityArgs(["--headed-run", "a", "--headed-eval", "b", "--headless-run", "c"]).ok, false); // missing 4th
  const ok = parseParityArgs(["--headed-run", "a", "--headed-eval", "b", "--headless-run", "c", "--headless-eval", "d"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.inputs, { headedRunId: "a", headedEvaluationId: "b", headlessRunId: "c", headlessEvaluationId: "d" });
});

// 4 ---------------------------------------------------------------------------------
test("Task7: headed/headless order is unambiguous (swapped run ids rejected)", () => {
  const swapped = { headedRunId: HEADLESS_RID, headedEvaluationId: "eval-001", headlessRunId: HEADED_RID, headlessEvaluationId: "eval-001" };
  assert.throws(() => buildParityReport(swapped, mkSources(VALID())), ParityIntegrityError);
});

// 5 ---------------------------------------------------------------------------------
test("Task7: two headed runs are rejected", () => {
  const runs = { [HEADED_RID]: headedRun(), [HEADLESS_RID]: headedRun({ manifest: { runId: HEADLESS_RID }, evaluation: { runId: HEADLESS_RID } }) };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /records mode headed, expected headless/);
});

// 6 ---------------------------------------------------------------------------------
test("Task7: two headless runs are rejected", () => {
  const runs = { [HEADED_RID]: headlessRun({ manifest: { runId: HEADED_RID }, evaluation: { runId: HEADED_RID } }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /records mode headless, expected headed/);
});

// 7 ---------------------------------------------------------------------------------
test("Task7: requested/effective mode mismatch is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ manifest: { requestedMode: "headless" } }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /requestedMode .* effective mode/);
});

// 8 ---------------------------------------------------------------------------------
test("Task7: a non-1.2 live run is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ manifest: { runLogSchemaVersion: "1.1" } }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /not 1\.2/);
});

// 9 ---------------------------------------------------------------------------------
test("Task7: a flow-id mismatch is rejected", () => {
  const runs = { [HEADED_RID]: headedRun(), [HEADLESS_RID]: headlessRun({ manifest: { flowId: "other-flow" }, evaluation: { flowId: "other-flow" } }) };
  // reparse is keyed on flowId; give the headless flow a matching reparse so the PAIR check fires
  const reparse = (_f: string, flowId: string) => (flowId === "other-flow" ? "sha256:plan" : "sha256:plan");
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs, { reparsePlanHash: reparse })), /flowId mismatch/);
});

// 10 --------------------------------------------------------------------------------
test("Task7: a plan-hash mismatch between the two runs is rejected", () => {
  const runs = {
    [HEADED_RID]: headedRun({ manifest: { planHash: "sha256:A" }, evaluation: { planHash: "sha256:A" } }),
    [HEADLESS_RID]: headlessRun({ manifest: { planHash: "sha256:B" }, evaluation: { planHash: "sha256:B" } }),
  };
  // reparse matches each run individually (headed first, headless second) so the PAIR check fires
  let n = 0;
  const reparse = () => (n++ === 0 ? "sha256:A" : "sha256:B");
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs, { reparsePlanHash: reparse })), /planHash mismatch/);
});

// 11 --------------------------------------------------------------------------------
test("Task7: a current-flow reparse hash mismatch is rejected", () => {
  assert.throws(
    () => buildParityReport(INPUTS, mkSources(VALID(), { reparsePlanHash: () => "sha256:changed" })),
    /reparses to sha256:changed/,
  );
});

// 12 --------------------------------------------------------------------------------
test("Task7: a run/evaluation join mismatch is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ evaluation: { runId: "some-other-run" } }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /evaluation .*\.runId .* != run/);
});

// 13 --------------------------------------------------------------------------------
test("Task7: an audit failure is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ auditOk: false }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /audit chain did not verify/);
});

// 14 --------------------------------------------------------------------------------
test("Task7: a non-completed execution is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ manifest: { executionStatus: "blocked" } }), [HEADLESS_RID]: headlessRun() };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /executionStatus is blocked, not completed/);
});

// 15 --------------------------------------------------------------------------------
test("Task7: a verdict mismatch is rejected", () => {
  const runs = { [HEADED_RID]: headedRun({ evaluation: { flowVerdict: "PASS" as Verdict } }), [HEADLESS_RID]: headlessRun({ evaluation: { flowVerdict: "FAIL" as Verdict } }) };
  assert.throws(() => buildParityReport(INPUTS, mkSources(runs)), /verdict mismatch/);
});

// 16 --------------------------------------------------------------------------------
test("Task7: a missing or non-green Task 6 checkpoint proof is rejected", () => {
  assert.throws(() => buildParityReport(INPUTS, mkSources(VALID(), { checkpointProof: [] })), /checkpoint proof is missing/);
  const nonGreen: CheckpointProof[] = [
    { path: "/login", headedDigest: "sha256:a", headlessDigest: "sha256:b", yamlByteEqual: false, normalizedEqual: false, differences: [{ path: "x", left: 1, right: 2, kind: "changed" }] },
    { path: "/form", headedDigest: "sha256:c", headlessDigest: "sha256:c", yamlByteEqual: true, normalizedEqual: true, differences: [] },
  ];
  assert.throws(() => buildParityReport(INPUTS, mkSources(VALID(), { checkpointProof: nonGreen })), /checkpoint \/login is not green/);
});

// 17 --------------------------------------------------------------------------------
test("Task7: a non-empty dropped-field list is rejected", () => {
  assert.throws(() => buildParityReport(INPUTS, mkSources(VALID(), { droppedFields: ["children[].attributes.cursor"] })), /allow-list must be empty/);
});

// 18 --------------------------------------------------------------------------------
test("Task7: the exact Phase 5 caveat is present, verbatim", () => {
  const expected =
    "This is a single-run cross-mode demonstration, not a statistical proof of deterministic " +
    "parity. Both the executor and the verifier contain intentional LLM non-determinism (D18). " +
    "Verdict agreement here shows the same flow ran headed and headless to the same recorded " +
    "verdict on this run; repeated cross-mode verdict stability is measured in Phase 8.";
  assert.equal(PARITY_CAVEAT, expected);
  assert.equal(buildParityReport(INPUTS, mkSources(VALID())).caveat, expected);
});

// 19 --------------------------------------------------------------------------------
test("Task7: the artifact contains no raw MCP args, env values, secrets, or machine paths", () => {
  const json = serializeParityReport(buildParityReport(INPUTS, mkSources(VALID())));
  for (const forbidden of ["--headless", "--isolated", "--viewport-size", "--snapshot-mode", "cli.js", "sk-ant", "password123", "ANTHROPIC", "/Users/", "C:\\\\", "Temp", "outputDir"]) {
    assert.ok(!json.includes(forbidden), `artifact must not contain "${forbidden}"`);
  }
});

// 20 --------------------------------------------------------------------------------
test("Task7: the generator imports no decider/verifier/summarizer/LLM client", () => {
  for (const rel of ["parity-report.ts", "parity-report-cli.ts"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "parity", rel), "utf8");
    const importPaths = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const p of importPaths) {
      assert.ok(!/decider|verifier|summary|summarizer|anthropic/i.test(p), `${rel} must not import "${p}"`);
    }
  }
});

// atomic write -----------------------------------------------------------------------
test("Task7: writeParityReport writes the validated artifact atomically; rejects leave none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-out-"));
  created.push(dir);
  const out = path.join(dir, "phase5-parity.json");
  writeParityReport(out, INPUTS, mkSources(VALID()));
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(out + ".tmp"));
  const onDisk = fs.readFileSync(out, "utf8");
  assert.equal(onDisk, serializeParityReport(buildParityReport(INPUTS, mkSources(VALID()))));

  // a failing build writes no artifact
  const out2 = path.join(dir, "fail.json");
  assert.throws(() => writeParityReport(out2, INPUTS, mkSources(VALID(), { droppedFields: ["x"] })), ParityIntegrityError);
  assert.ok(!fs.existsSync(out2));
});
