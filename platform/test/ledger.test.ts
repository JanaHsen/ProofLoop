/**
 * Phase 6 Task 4 — deterministic CI ledger transitions (§8). Pure functions, no IO, no LLM.
 * The final test proves a ledger BUILT by these helpers is accepted by report:ci's own
 * validation (init → record-complete for every flow → aggregate → allPass), so the two
 * contracts cannot drift apart.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  initialLedger,
  LedgerError,
  markAllError,
  recordEntry,
  serializeLedger,
  type LedgerEntry,
} from "../src/ci/ledger";
import { aggregateCiResults } from "../src/ci/report-ci";

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── initialLedger ────────────────────────────────────────────────────────────────────────

test("initialLedger: one stage:run entry per flow, order preserved", () => {
  const l = initialLedger(["fixtures/flows/a.flow.md", "fixtures/flows/b.flow.md"]);
  assert.deepEqual(l, [
    { flowPath: "fixtures/flows/a.flow.md", stage: "run" },
    { flowPath: "fixtures/flows/b.flow.md", stage: "run" },
  ]);
});

test("initialLedger: empty list and duplicates are rejected", () => {
  assert.throws(() => initialLedger([]), LedgerError);
  assert.throws(() => initialLedger(["x", "x"]), (e: unknown) => e instanceof LedgerError && /duplicate/.test((e as Error).message));
});

// ── recordEntry: complete ──────────────────────────────────────────────────────────────────

test("recordEntry complete: sets ids + reportPath, no errorClass", () => {
  const l = initialLedger(["a", "b"]);
  const next = recordEntry(l, {
    flowPath: "a", stage: "complete",
    runId: "run-1", evaluationId: "eval-001", reportPath: "platform/runs/run-1/reports/eval-001/report.json",
  });
  assert.deepEqual(next[0], {
    flowPath: "a", stage: "complete",
    runId: "run-1", evaluationId: "eval-001", reportPath: "platform/runs/run-1/reports/eval-001/report.json",
  });
  assert.deepEqual(next[1], { flowPath: "b", stage: "run" }, "other entries untouched");
});

test("recordEntry complete missing reportPath fails; complete + errorClass fails", () => {
  const l = initialLedger(["a"]);
  assert.throws(() => recordEntry(l, { flowPath: "a", stage: "complete", runId: "r", evaluationId: "e" }), LedgerError);
  assert.throws(
    () => recordEntry(l, { flowPath: "a", stage: "complete", runId: "r", evaluationId: "e", reportPath: "p", errorClass: "X" }),
    (e: unknown) => e instanceof LedgerError && /must not carry an errorClass/.test((e as Error).message),
  );
});

// ── recordEntry: failed stages ─────────────────────────────────────────────────────────────

test("recordEntry run-failed: errorClass only, no ids", () => {
  const l = initialLedger(["a"]);
  const next = recordEntry(l, { flowPath: "a", stage: "run", errorClass: "RUN_FAILED", errorMessage: "safe text" });
  assert.deepEqual(next[0], { flowPath: "a", stage: "run", errorClass: "RUN_FAILED", errorMessage: "safe text" });
});

test("recordEntry run-failed must not carry a runId", () => {
  const l = initialLedger(["a"]);
  assert.throws(
    () => recordEntry(l, { flowPath: "a", stage: "run", errorClass: "RUN_FAILED", runId: "r" }),
    (e: unknown) => e instanceof LedgerError && /must not carry runId/.test((e as Error).message),
  );
});

test("recordEntry verify-failed: errorClass + runId; missing runId or extra ids fail", () => {
  const l = initialLedger(["a"]);
  const next = recordEntry(l, { flowPath: "a", stage: "verify", runId: "run-1", errorClass: "VERIFY_FAILED" });
  assert.deepEqual(next[0], { flowPath: "a", stage: "verify", runId: "run-1", errorClass: "VERIFY_FAILED" });
  assert.throws(() => recordEntry(l, { flowPath: "a", stage: "verify", errorClass: "VERIFY_FAILED" }), LedgerError);
  assert.throws(
    () => recordEntry(l, { flowPath: "a", stage: "verify", runId: "r", evaluationId: "e", errorClass: "VERIFY_FAILED" }),
    (e: unknown) => e instanceof LedgerError && /must not carry evaluationId/.test((e as Error).message),
  );
});

test("recordEntry report-failed: errorClass + runId + evaluationId; missing evaluationId fails", () => {
  const l = initialLedger(["a"]);
  const next = recordEntry(l, { flowPath: "a", stage: "report", runId: "run-1", evaluationId: "eval-001", errorClass: "REPORT_FAILED" });
  assert.deepEqual(next[0], { flowPath: "a", stage: "report", runId: "run-1", evaluationId: "eval-001", errorClass: "REPORT_FAILED" });
  assert.throws(() => recordEntry(l, { flowPath: "a", stage: "report", runId: "r", errorClass: "REPORT_FAILED" }), LedgerError);
});

test("recordEntry on an unknown flow fails loud", () => {
  const l = initialLedger(["a"]);
  assert.throws(
    () => recordEntry(l, { flowPath: "nope", stage: "run", errorClass: "RUN_FAILED" }),
    (e: unknown) => e instanceof LedgerError && /not in the ledger/.test((e as Error).message),
  );
});

test("recordEntry does not mutate the input ledger", () => {
  const l = initialLedger(["a"]);
  recordEntry(l, { flowPath: "a", stage: "run", errorClass: "RUN_FAILED" });
  assert.deepEqual(l[0], { flowPath: "a", stage: "run" }, "input unchanged (pure)");
});

// ── markAllError ───────────────────────────────────────────────────────────────────────────

test("markAllError: every entry becomes the same failed terminal state (APP_NOT_READY)", () => {
  const l = initialLedger(["a", "b", "c"]);
  const next = markAllError(l, { stage: "run", errorClass: "APP_NOT_READY", errorMessage: "SUT not ready" });
  for (const e of next) {
    assert.equal(e.stage, "run");
    assert.equal(e.errorClass, "APP_NOT_READY");
    assert.equal(e.errorMessage, "SUT not ready");
    assert.equal(e.runId, undefined);
  }
});

test("markAllError refuses to set stage complete", () => {
  const l = initialLedger(["a"]);
  assert.throws(() => markAllError(l, { stage: "complete", errorClass: "X" }), LedgerError);
});

// ── serialization determinism ──────────────────────────────────────────────────────────────

test("serializeLedger is deterministic and newline-terminated", () => {
  const l: LedgerEntry[] = [{ flowPath: "a", stage: "run" }];
  const s1 = serializeLedger(l);
  const s2 = serializeLedger(l);
  assert.equal(s1, s2);
  assert.ok(s1.endsWith("\n"));
});

// ── integration: a ledger built by these helpers is accepted by report:ci ────────────────────

test("a fully-complete ledger built via the helpers aggregates to allPass=true", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-ledger-"));
  tmpDirs.push(tmpDir);

  const flows = ["fixtures/flows/a.flow.md", "fixtures/flows/b.flow.md"];
  let ledger = initialLedger(flows);

  flows.forEach((flowPath, i) => {
    const runId = `run-${i}`;
    const evalId = `eval-00${i}`;
    const reportRel = `reports/flow-${i}/report.json`;
    // Seed a minimal valid report.json that the aggregator will read + join-check.
    const absReport = path.join(tmpDir, reportRel);
    fs.mkdirSync(path.dirname(absReport), { recursive: true });
    fs.writeFileSync(
      absReport,
      JSON.stringify({
        reportSchemaVersion: "1.0",
        source: { runId, evaluationId: evalId },
        execution: { costUsd: 0.001, latencyMs: 100 },
        verification: { flowVerdict: "PASS", costUsd: 0.002, latencyMs: 200, criteria: [] },
      }),
      "utf8",
    );
    ledger = recordEntry(ledger, {
      flowPath, stage: "complete", runId, evaluationId: evalId, reportPath: reportRel,
    });
  });

  const ledgerPath = path.join(tmpDir, "ci-results.json");
  fs.writeFileSync(ledgerPath, serializeLedger(ledger), "utf8");

  const out = aggregateCiResults({ resultsPath: ledgerPath, repoRoot: tmpDir });
  assert.equal(out.summary.allPass, true);
  assert.deepEqual(out.summary.counts, { pass: 2, fail: 0, inconclusive: 0, error: 0 });
});
