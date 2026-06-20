/**
 * Phase 6 Task 4 — local proof for the zero-model synthetic corruption gate (§2 of the gate
 * correction). It proves the temporary corruption test exercises the RIGHT failure path: an
 * otherwise fully-valid completed report is rejected SOLELY because its `source.runId` disagrees
 * with the ledger — not because of schema version, missing fields, malformed criteria, an
 * unsupported shape, or path resolution.
 *
 * Method (mirrors the revised temporary workflow step): deep-clone a REAL committed valid report
 * and reassign only the synthetic `source` IDs. No LLM/API/SUT/browser is involved.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { REPORT_SCHEMA_VERSION } from "../src/report/schema";
import { aggregateCiResults, CiReportError } from "../src/ci/report-ci";
import { initialLedger, recordEntry, serializeLedger } from "../src/ci/ledger";

// The authoritative real, valid, committed report used as the clone template.
const TEMPLATE_REPORT = path.resolve(
  __dirname, "..", "..", "presentation", "runs", "clean", "report.json",
);

const FIVE_FLOWS = [
  "fixtures/flows/login.flow.md",
  "fixtures/flows/add-to-cart.flow.md",
  "fixtures/flows/checkout.flow.md",
  "fixtures/flows/checkout-mobile.flow.md",
  "fixtures/flows/form.flow.md",
];

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Build a synthetic repo root: for each flow, deep-clone the real valid report, reassign a
 * deterministic synthetic `source.runId`/`source.evaluationId`, write it under the same
 * `platform/runs/**` layout report:ci expects, and record MATCHING ids in the ledger. When
 * `corruptIndex` is set, ONLY that flow's `source.runId` is mutated to a different deterministic
 * value — every other field is left exactly as cloned.
 */
function buildSynthetic(opts: { corruptIndex?: number } = {}): { repoRoot: string; ledgerPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-synth-"));
  tmpDirs.push(repoRoot);

  const template = JSON.parse(fs.readFileSync(TEMPLATE_REPORT, "utf8"));
  assert.equal(
    template.reportSchemaVersion,
    REPORT_SCHEMA_VERSION,
    "the clone template must be a CURRENT valid report (schema drift would invalidate the proof)",
  );

  let ledger = initialLedger(FIVE_FLOWS);
  FIVE_FLOWS.forEach((flowPath, i) => {
    const runId = `synthetic-run-${i}`;
    const evalId = `eval-00${i + 1}`;
    const reportRel = `platform/runs/${runId}/reports/${evalId}/report.json`;

    const report = JSON.parse(JSON.stringify(template)); // deep clone of a fully valid report
    report.source.runId = runId;
    report.source.evaluationId = evalId;
    if (opts.corruptIndex === i) {
      report.source.runId = `${runId}-MISMATCH`; // change ONLY this field
    }

    const abs = path.join(repoRoot, reportRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(report, null, 2));

    // The ledger always records the MATCHING (uncorrupted) synthetic ids.
    ledger = recordEntry(ledger, {
      flowPath, stage: "complete", runId, evaluationId: evalId, reportPath: reportRel,
    });
  });

  const ledgerPath = path.join(repoRoot, "ci-results.json");
  fs.writeFileSync(ledgerPath, serializeLedger(ledger));
  return { repoRoot, ledgerPath };
}

test("control: five cloned valid reports with matching source IDs aggregate to a summary", () => {
  const { repoRoot, ledgerPath } = buildSynthetic();
  const out = aggregateCiResults({ resultsPath: ledgerPath, repoRoot });
  assert.ok(out.summaryJson.length > 0, "summary.json is produced");
  assert.equal(out.summary.flows.length, 5, "all five flows aggregate");
  // The clean template is a PASS report, so the control aggregate clears.
  assert.equal(out.summary.allPass, true);
});

test("single-mutation: changing ONE report's source.runId fails with the run-ID join mismatch", () => {
  const { repoRoot, ledgerPath } = buildSynthetic({ corruptIndex: 2 });
  assert.throws(
    () => aggregateCiResults({ resultsPath: ledgerPath, repoRoot }),
    (e: unknown) => {
      // Typed error class — the completed-report join failure, not a generic Error.
      assert.ok(e instanceof CiReportError, `expected CiReportError, got ${String(e)}`);
      const m = (e as Error).message;
      // Specifically the run-ID join.
      assert.match(m, /source\.runId/, "failure must be the completed-report run-ID join");
      // Prove it is NOT some other integrity/shape/path condition:
      assert.ok(!/schemaVersion/i.test(m), "not a schema-version failure");
      assert.ok(!/not valid JSON|must be a JSON object|missing/i.test(m), "not a malformed/missing-field failure");
      assert.ok(!/criteria/i.test(m), "not a malformed-criteria failure");
      assert.ok(!/absolute|traverse|outside/i.test(m), "not a path-resolution failure");
      assert.ok(!/source\.evaluationId/.test(m), "specifically runId, not evaluationId");
      return true;
    },
  );
});

test("the corrupt clone differs from the control clone in source.runId ONLY", () => {
  const ctrl = buildSynthetic();
  const corrupt = buildSynthetic({ corruptIndex: 2 });
  const rel = "platform/runs/synthetic-run-2/reports/eval-003/report.json";
  const a = JSON.parse(fs.readFileSync(path.join(ctrl.repoRoot, rel), "utf8"));
  const b = JSON.parse(fs.readFileSync(path.join(corrupt.repoRoot, rel), "utf8"));
  assert.notEqual(a.source.runId, b.source.runId, "the run IDs differ");
  b.source.runId = a.source.runId; // restore the only changed field
  assert.deepEqual(b, a, "after restoring source.runId the two reports are identical — nothing else changed");
});
