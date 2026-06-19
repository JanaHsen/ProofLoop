/**
 * Phase 6 Task 1 — report-cli D38 contract (CONFIRM ONLY: report-cli already conforms, so its
 * production code is unchanged). report-cli's exit-code logic is the only un-exported part, so
 * these tests drive the REAL process via subprocess (the exact `npm run report` invocation) and
 * assert the process exit code: 0 on a valid deterministic report; non-zero on a missing
 * artifact, an integrity/plan-hash failure, and invalid args. No LLM call (report is offline).
 *
 * The fixture run is seeded under platform/runs/<id> (gitignored, cleaned up) because report-cli
 * resolves runs from that fixed root; the evaluation is generated in-process with a MOCKED
 * verifier (no live Opus call), reusing the frozen Phase 2 run whose planHash matches the flow.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

const PLATFORM = path.join(__dirname, "..");
const REPORT_CLI = path.join(PLATFORM, "src", "report-cli.ts");
const RUNS_ROOT = path.join(PLATFORM, "runs");
const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
const MODEL = "claude-opus-4-8";
const USAGE = { input_tokens: 1000, output_tokens: 200 };

function fixedClock(): () => string {
  const values = ["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"];
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

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
      const evaluation = finalizeCriterion(
        input,
        {
          verdict,
          observations: [validObservation(input.window)],
          eventObservations: [],
          reasoning: `decided ${verdict}`,
        },
        1,
      );
      return {
        evaluation,
        usage: { ...USAGE },
        latencyMs: 42,
        model: MODEL,
        toolCallCount: 1,
        rawVerdict: verdict,
      };
    },
  };
}

/** Run report-cli exactly as `npm run report` does, returning the spawn result. */
function runReportCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--require", "ts-node/register/transpile-only", REPORT_CLI, ...args],
    { cwd: PLATFORM, encoding: "utf8" },
  );
}

/** Seed a real run + one generated evaluation under platform/runs/<id>. Returns the evaluationId. */
async function seedRun(id: string, verdict: Verdict): Promise<string> {
  const runDir = path.join(RUNS_ROOT, id);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.cpSync(FROZEN, runDir, { recursive: true });
  const { evaluationId } = await writeEvaluation({
    runDir,
    flowsDir: FLOWS_DIR,
    verifier: mockVerifier(verdict),
    verifierModel: MODEL,
    verifierParams: VERIFIER_PARAMS,
    clock: fixedClock(),
  });
  return evaluationId;
}

test("report-cli: exits 0 on a valid report and writes report.json/html", async () => {
  const id = `__report-cli-test-valid-${process.pid}`;
  const runDir = path.join(RUNS_ROOT, id);
  try {
    const evalId = await seedRun(id, "PASS");
    const r = runReportCli(["--run", id, "--evaluation", evalId]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.existsSync(path.join(runDir, "reports", evalId, "report.json")));
    assert.ok(fs.existsSync(path.join(runDir, "reports", evalId, "report.html")));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("report-cli: exits non-zero on a missing evaluation artifact (never falls back)", async () => {
  const id = `__report-cli-test-missing-${process.pid}`;
  const runDir = path.join(RUNS_ROOT, id);
  try {
    await seedRun(id, "PASS");
    const r = runReportCli(["--run", id, "--evaluation", "eval-999"]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("report-cli: exits non-zero on an integrity / plan-hash failure (D28)", async () => {
  const id = `__report-cli-test-integrity-${process.pid}`;
  const runDir = path.join(RUNS_ROOT, id);
  try {
    const evalId = await seedRun(id, "PASS");
    // Tamper the evaluation's planHash so it no longer matches the run → ReportIntegrityError.
    const evalFile = path.join(runDir, "evaluations", evalId, "evaluation.json");
    const rec = JSON.parse(fs.readFileSync(evalFile, "utf8"));
    rec.planHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    fs.writeFileSync(evalFile, JSON.stringify(rec, null, 2) + "\n");
    const r = runReportCli(["--run", id, "--evaluation", evalId]);
    assert.equal(r.status, 1, r.stderr || r.stdout);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("report-cli: exits 2 on invalid args (both --run and --evaluation required)", () => {
  const r = runReportCli(["--run", "only-run-no-evaluation"]);
  assert.equal(r.status, 2, r.stderr || r.stdout);
});
