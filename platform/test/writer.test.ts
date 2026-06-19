import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readManifest } from "../src/run/audit";
import {
  computeCostUsd,
  loadPricing,
  ratesFor,
  type RawUsage,
} from "../src/run/pricing";
import { citationTextSurface } from "../src/verify/citation";
import {
  EVALUATION_RECORD_SCHEMA_VERSION,
  type Verdict,
} from "../src/verify/evaluation";
import type { EvidenceWindow } from "../src/verify/resolver";
import {
  finalizeCriterion,
  VERIFIER_PARAMS,
  type Verifier,
  type VerifierCriterionInput,
  type VerifierResult,
} from "../src/verify/verifier";
import {
  nextEvaluationId,
  PlanHashMismatchError,
  writeEvaluation,
} from "../src/verify/writer";

// The frozen Phase 2 exit run + the real flow it executed. Their planHash matches (the
// writer asserts equality), so add-to-cart-frozen is a valid end-to-end happy-path fixture.
const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");

// Mocked-verifier budget rules (Task 5): no live Opus call anywhere here. We use a model
// that IS priced in the run's pricing config so the cost recompute exercises the real path.
const MODEL = "claude-opus-4-8";
const USAGE: RawUsage = { input_tokens: 1000, output_tokens: 200 };
const LATENCY = 42;

/** A two-value clock so startedAt/finishedAt are deterministic in the record. */
function fixedClock(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function tmpRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-writer-"));
  const runDir = path.join(dir, "run");
  fs.cpSync(FROZEN, runDir, { recursive: true });
  return runDir;
}

/**
 * A guaranteed-VALID snapshot observation derived from the live evidence window: the first
 * ref whose per-ref citation text surface is non-empty, citing that exact text. This is how
 * a mocked verifier produces a citation the harness will accept without hardcoding refs.
 */
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

/** A mock verifier that returns `verdict` for every criterion, citing one valid observation. */
function mockVerifier(verdict: Verdict): Verifier {
  return {
    async verify(input: VerifierCriterionInput): Promise<VerifierResult> {
      const raw =
        verdict === "INCONCLUSIVE"
          ? {
              verdict,
              observations: [validObservation(input.window)],
              eventObservations: [],
              reasoning: "ambiguous",
              inconclusiveDetail: { kind: "AMBIGUOUS_EVIDENCE", explanation: "unclear" },
            }
          : {
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
        ...(verdict === "INCONCLUSIVE" ? { rawDetailKind: "AMBIGUOUS_EVIDENCE" } : {}),
      };
    },
  };
}

test("nextEvaluationId: starts at eval-001 and counts past the highest on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-evalid-"));
  try {
    assert.equal(nextEvaluationId(path.join(dir, "evaluations")), "eval-001");
    fs.mkdirSync(path.join(dir, "evaluations", "eval-001"), { recursive: true });
    fs.mkdirSync(path.join(dir, "evaluations", "eval-002"), { recursive: true });
    assert.equal(nextEvaluationId(path.join(dir, "evaluations")), "eval-003");
    // a stray non-matching dir must not perturb the counter
    fs.mkdirSync(path.join(dir, "evaluations", "scratch"), { recursive: true });
    assert.equal(nextEvaluationId(path.join(dir, "evaluations")), "eval-003");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEvaluation: end-to-end PASS record is schema-valid with the correct flowVerdict", async () => {
  const runDir = tmpRunDir();
  try {
    const manifest = readManifest(runDir);
    const { record, evaluationId, evaluationPath } = await writeEvaluation({
      runDir,
      flowsDir: FLOWS_DIR,
      verifier: mockVerifier("PASS"),
      verifierModel: MODEL,
      verifierParams: VERIFIER_PARAMS,
      clock: fixedClock(["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"]),
    });

    // ----- the returned record is schema-shaped and pinned to the executed plan -----
    assert.equal(record.evaluationRecordSchemaVersion, EVALUATION_RECORD_SCHEMA_VERSION);
    assert.equal(evaluationId, "eval-001");
    assert.equal(record.evaluationId, "eval-001");
    assert.equal(record.runId, manifest.runId);
    assert.equal(record.flowId, "add-to-cart");
    assert.equal(record.planHash, manifest.planHash);
    assert.equal(record.verifierModel, MODEL);
    assert.deepEqual(record.verifierParams, VERIFIER_PARAMS);
    assert.equal(record.pricingConfigId, manifest.pricingConfigId);
    assert.equal(record.startedAt, "2026-06-19T00:00:00.000Z");
    assert.equal(record.finishedAt, "2026-06-19T00:00:05.000Z");

    // ----- three terminal criteria, all PASS ⇒ flow PASS (D23) -----
    assert.equal(record.criteria.length, 3);
    assert.deepEqual(
      record.criteria.map((c) => c.criterionId),
      ["add-to-cart:C1", "add-to-cart:C2", "add-to-cart:C3"],
    );
    assert.ok(record.criteria.every((c) => c.verdict === "PASS"), "every criterion is PASS");
    assert.equal(record.flowVerdict, "PASS");
    // each criterion preserves its observation + its 1:1 citation validation, all valid
    for (const c of record.criteria) {
      assert.equal(c.observations.length, 1);
      assert.equal(c.citationValidations.length, 1);
      assert.equal(c.citationValidations[0].valid, true);
      assert.ok(c.inconclusiveDetail === undefined, "PASS carries no inconclusiveDetail");
      assert.ok(c.evidence.snapshotIds.length >= 1);
    }

    // ----- totals recompute from raw usage + the versioned pricing config -----
    const rates = ratesFor(loadPricing(manifest.pricingConfigId), MODEL);
    const perCall = computeCostUsd(USAGE, rates);
    assert.equal(record.totals.promptTokens, 3 * 1000);
    assert.equal(record.totals.completionTokens, 3 * 200);
    assert.equal(record.totals.latencyMs, 3 * LATENCY);
    assert.ok(Math.abs(record.totals.costUsd - 3 * perCall) < 1e-12);

    // ----- the record is actually on disk, parses, and round-trips -----
    assert.equal(
      evaluationPath,
      path.join(runDir, "evaluations", "eval-001", "evaluation.json"),
    );
    const onDisk = JSON.parse(fs.readFileSync(evaluationPath, "utf8"));
    assert.deepEqual(onDisk, record);
  } finally {
    fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
  }
});

test("writeEvaluation: a single FAIL drives the flow verdict to FAIL", async () => {
  const runDir = tmpRunDir();
  try {
    // FAIL for every criterion ⇒ any-FAIL ⇒ FAIL (the regression guard wins).
    const { record } = await writeEvaluation({
      runDir,
      flowsDir: FLOWS_DIR,
      verifier: mockVerifier("FAIL"),
      verifierModel: MODEL,
      verifierParams: VERIFIER_PARAMS,
      clock: fixedClock(["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"]),
    });
    assert.ok(record.criteria.every((c) => c.verdict === "FAIL"));
    assert.equal(record.flowVerdict, "FAIL");
  } finally {
    fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
  }
});

test("writeEvaluation: planHash mismatch fails loud and writes nothing", async () => {
  const runDir = tmpRunDir();
  try {
    // Simulate the flow having changed since the run: tamper the manifest's recorded hash.
    const manifestPath = path.join(runDir, "run.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.planHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await assert.rejects(
      () =>
        writeEvaluation({
          runDir,
          flowsDir: FLOWS_DIR,
          verifier: mockVerifier("PASS"),
          verifierModel: MODEL,
          verifierParams: VERIFIER_PARAMS,
        }),
      PlanHashMismatchError,
    );
    // nothing was written — no evaluation could rest on a plan that was not executed
    assert.ok(
      !fs.existsSync(path.join(runDir, "evaluations")),
      "no evaluation directory is created on a planHash mismatch",
    );
  } finally {
    fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
  }
});

test("writeEvaluation: evaluationId increments across two passes without overwriting", async () => {
  const runDir = tmpRunDir();
  try {
    const common = {
      runDir,
      flowsDir: FLOWS_DIR,
      verifierModel: MODEL,
      verifierParams: VERIFIER_PARAMS,
      clock: fixedClock(["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"]),
    };
    const first = await writeEvaluation({ ...common, verifier: mockVerifier("PASS") });
    const second = await writeEvaluation({ ...common, verifier: mockVerifier("FAIL") });

    assert.equal(first.evaluationId, "eval-001");
    assert.equal(second.evaluationId, "eval-002");
    assert.notEqual(first.evaluationPath, second.evaluationPath);

    // both passes are intact on disk — the second never overwrote the first
    const r1 = JSON.parse(fs.readFileSync(first.evaluationPath, "utf8"));
    const r2 = JSON.parse(fs.readFileSync(second.evaluationPath, "utf8"));
    assert.equal(r1.evaluationId, "eval-001");
    assert.equal(r1.flowVerdict, "PASS");
    assert.equal(r2.evaluationId, "eval-002");
    assert.equal(r2.flowVerdict, "FAIL");

    assert.deepEqual(
      fs.readdirSync(path.join(runDir, "evaluations")).sort(),
      ["eval-001", "eval-002"],
    );
  } finally {
    fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
  }
});
