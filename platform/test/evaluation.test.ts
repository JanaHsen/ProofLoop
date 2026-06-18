import test from "node:test";
import assert from "node:assert/strict";

import {
  EVALUATION_RECORD_SCHEMA_VERSION,
  INCONCLUSIVE_ERROR_CODES,
  aggregateVerdict,
  errorDetail,
  type CriterionEvaluation,
  type EvaluationRecord,
  type InconclusiveErrorCode,
  type Verdict,
} from "../src/verify/evaluation";

test("schema version is frozen at 1.0", () => {
  assert.equal(EVALUATION_RECORD_SCHEMA_VERSION, "1.0");
});

// --- aggregation: every combination, with FAIL precedence and the empty guard --------

test("aggregateVerdict: all PASS ⇒ PASS", () => {
  assert.equal(aggregateVerdict(["PASS"]), "PASS");
  assert.equal(aggregateVerdict(["PASS", "PASS", "PASS"]), "PASS");
});

test("aggregateVerdict: any FAIL ⇒ FAIL (regardless of position or company)", () => {
  assert.equal(aggregateVerdict(["FAIL"]), "FAIL");
  assert.equal(aggregateVerdict(["PASS", "FAIL"]), "FAIL");
  assert.equal(aggregateVerdict(["FAIL", "PASS"]), "FAIL");
  assert.equal(aggregateVerdict(["PASS", "PASS", "FAIL", "PASS"]), "FAIL");
});

test("aggregateVerdict: FAIL beats INCONCLUSIVE (the guard wins)", () => {
  assert.equal(aggregateVerdict(["FAIL", "INCONCLUSIVE"]), "FAIL");
  assert.equal(aggregateVerdict(["INCONCLUSIVE", "FAIL"]), "FAIL");
  assert.equal(aggregateVerdict(["PASS", "FAIL", "INCONCLUSIVE"]), "FAIL");
});

test("aggregateVerdict: INCONCLUSIVE without FAIL ⇒ INCONCLUSIVE", () => {
  assert.equal(aggregateVerdict(["INCONCLUSIVE"]), "INCONCLUSIVE");
  assert.equal(aggregateVerdict(["PASS", "INCONCLUSIVE"]), "INCONCLUSIVE");
  assert.equal(aggregateVerdict(["INCONCLUSIVE", "PASS"]), "INCONCLUSIVE");
  assert.equal(aggregateVerdict(["PASS", "PASS", "INCONCLUSIVE"]), "INCONCLUSIVE");
});

test("aggregateVerdict: empty criteria set ⇒ INCONCLUSIVE (no vacuous PASS)", () => {
  assert.equal(aggregateVerdict([]), "INCONCLUSIVE");
});

test("aggregateVerdict is exhaustive over the 3^n small cases (n=1,2)", () => {
  const space: Verdict[] = ["PASS", "FAIL", "INCONCLUSIVE"];
  const expected = (vs: Verdict[]): Verdict =>
    vs.includes("FAIL") ? "FAIL" : vs.every((v) => v === "PASS") ? "PASS" : "INCONCLUSIVE";
  for (const a of space) {
    assert.equal(aggregateVerdict([a]), expected([a]));
    for (const b of space) {
      assert.equal(aggregateVerdict([a, b]), expected([a, b]), `${a},${b}`);
    }
  }
});

// --- the InconclusiveDetail code→origin table ----------------------------------------

test("every enumerated code is bound to the correct origin", () => {
  assert.deepEqual(INCONCLUSIVE_ERROR_CODES, {
    COULD_NOT_EXECUTE: "EXECUTION",
    MISSING_BOUNDARY_SNAPSHOT: "EXECUTION",
    MCP_TRANSPORT_ERROR: "EXECUTION",
    VERIFIER_SCHEMA_ERROR: "VERIFICATION",
    INVALID_CITATION: "VERIFICATION",
  });
});

test("every code resolves to a valid origin (no orphan codes)", () => {
  const codes = Object.keys(INCONCLUSIVE_ERROR_CODES) as InconclusiveErrorCode[];
  for (const code of codes) {
    assert.ok(["EXECUTION", "VERIFICATION"].includes(INCONCLUSIVE_ERROR_CODES[code]), code);
  }
});

test("errorDetail derives origin from the table for each code", () => {
  assert.deepEqual(errorDetail("COULD_NOT_EXECUTE", "flow ended early"), {
    kind: "ERROR",
    origin: "EXECUTION",
    code: "COULD_NOT_EXECUTE",
    explanation: "flow ended early",
  });
  assert.deepEqual(errorDetail("INVALID_CITATION", "ref not in snapshot"), {
    kind: "ERROR",
    origin: "VERIFICATION",
    code: "INVALID_CITATION",
    explanation: "ref not in snapshot",
  });
  // origin always matches the table, for every code
  for (const code of Object.keys(INCONCLUSIVE_ERROR_CODES) as InconclusiveErrorCode[]) {
    assert.equal(errorDetail(code, "x").origin, INCONCLUSIVE_ERROR_CODES[code]);
  }
});

// --- the record shape composes (compile-time contract, exercised at runtime) ----------

test("a well-formed evaluation record composes and its flowVerdict agrees with aggregation", () => {
  const criteria: CriterionEvaluation[] = [
    {
      criterionId: "add-to-cart:C1",
      verdict: "PASS",
      observations: [
        { label: "Total", observedText: "$64.87", snapshotId: "snapshot-022", ref: "e42" },
      ],
      citationValidations: [
        { snapshotProvided: true, digestMatches: true, refPresent: true, observedTextPresent: true, valid: true },
      ],
      reasoning: "Total reads $64.87 as required.",
      evidence: { snapshotIds: ["snapshot-022"] },
    },
    {
      criterionId: "add-to-cart:C2",
      verdict: "FAIL",
      observations: [],
      citationValidations: [],
      reasoning: "Tax was $0.00, not 10% of subtotal.",
      evidence: { snapshotIds: ["snapshot-022"], eventRefs: [{ seq: 60, type: "snapshot" }] },
    },
  ];
  const record: EvaluationRecord = {
    evaluationRecordSchemaVersion: EVALUATION_RECORD_SCHEMA_VERSION,
    evaluationId: "eval-001",
    runId: "add-to-cart-2026-06-18T21-34-32-463Z-d1908fac",
    flowId: "add-to-cart",
    planHash: "sha256:ad29fd82a319402998f7c169321d47e49fcf84d188e0cdb74820d47e049f1352",
    verifierModel: "claude-sonnet-4-6",
    verifierParams: { temperature: 0 },
    pricingConfigId: "anthropic-2026-06",
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:05.000Z",
    flowVerdict: aggregateVerdict(criteria.map((c) => c.verdict)),
    criteria,
    totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 },
  };
  assert.equal(record.flowVerdict, "FAIL");
  assert.equal(record.criteria.length, 2);
});
