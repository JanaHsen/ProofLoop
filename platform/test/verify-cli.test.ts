/**
 * Phase 6 Task 1 — verify-cli: the D38 exit-code contract + the D39 --id-file emission.
 * Uses the frozen Phase 2 run fixture with a MOCKED verifier (no live Opus call). We assert
 * the PROCESS EXIT CODE for every approved branch and that --id-file holds exactly the
 * evaluationId.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseVerifyArgs, verifyCli, type VerifyCliDeps } from "../src/verify-cli";
import type { EngineConfig } from "../src/config";
import { citationTextSurface } from "../src/verify/citation";
import type { Verdict } from "../src/verify/evaluation";
import type { EvidenceWindow } from "../src/verify/resolver";
import {
  finalizeCriterion,
  type Verifier,
  type VerifierCriterionInput,
  type VerifierResult,
} from "../src/verify/verifier";
import { writeEvaluation } from "../src/verify/writer";

const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
const MODEL = "claude-opus-4-8"; // priced in the run's pricing config; no live call anywhere
const USAGE = { input_tokens: 1000, output_tokens: 200 };
const LATENCY = 42;

const CONFIG: EngineConfig = {
  baseUrl: "http://localhost:3000",
  model: "claude-sonnet-4-6",
  verifierModel: MODEL,
  summaryModel: undefined,
  anthropicApiKey: "test-key-never-used",
  pricingConfigId: "anthropic-2026-06",
};

function capture() {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    write(s: string) {
      chunks.push(s);
      return true;
    },
  };
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

/** A mock verifier returning `verdict` for every criterion, citing one valid observation. */
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

/** A tmp runs-root holding a copy of the frozen run under <runId>. Caller removes `root`. */
function tmpRuns(runId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-verify-cli-"));
  fs.cpSync(FROZEN, path.join(root, runId), { recursive: true });
  return root;
}

function baseDeps(verdict: Verdict, root: string, over: Partial<VerifyCliDeps>): Partial<VerifyCliDeps> {
  return {
    readConfig: () => CONFIG,
    makeVerifier: () => mockVerifier(verdict),
    runsRoot: root,
    flowsDir: FLOWS_DIR,
    ...over,
  };
}

// ---------------------------------------------------------------------------------
// parseVerifyArgs — surface (now exported + extended with --id-file)
// ---------------------------------------------------------------------------------

test("parseVerifyArgs: --run required; --id-file optional/order-independent; unknown rejected", () => {
  assert.deepEqual(parseVerifyArgs(["--run", "r"]), { runId: "r" });
  assert.deepEqual(parseVerifyArgs(["--run", "r", "--id-file", "e.txt"]), {
    runId: "r",
    idFilePath: "e.txt",
  });
  assert.deepEqual(parseVerifyArgs(["--id-file", "e.txt", "--run", "r"]), {
    runId: "r",
    idFilePath: "e.txt",
  });
  assert.equal(parseVerifyArgs([]), null);
  assert.equal(parseVerifyArgs(["--run"]), null);
  assert.equal(parseVerifyArgs(["--run", ""]), null);
  assert.equal(parseVerifyArgs(["--id-file", "e.txt"]), null, "no --run");
  assert.equal(parseVerifyArgs(["--run", "r", "--id-file"]), null);
  assert.equal(parseVerifyArgs(["--run", "r", "--bogus"]), null);
});

// ---------------------------------------------------------------------------------
// D38 exit-code contract — a trustworthy record exits 0 for EVERY verdict
// ---------------------------------------------------------------------------------

test("verifyCli: exits 0 for PASS, FAIL, and INCONCLUSIVE; --id-file holds the evaluationId", async () => {
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
    const root = tmpRuns("the-run");
    const idFile = path.join(root, "eval-id.txt");
    const out = capture();
    try {
      const code = await verifyCli(
        ["node", "verify", "--run", "the-run", "--id-file", idFile],
        baseDeps(verdict, root, { out, err: capture() }),
      );
      assert.equal(code, 0, `verdict ${verdict} must exit 0`);
      const content = fs.readFileSync(idFile, "utf8");
      assert.equal(content, "eval-001\n", "exactly the id + a single trailing newline");
      assert.ok(
        out.text().includes("eval-001:"),
        "the id file equals the evaluationId printed on stdout",
      );
      assert.ok(out.text().includes(`flowVerdict=${verdict}`));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("verifyCli: exits 2 on invalid args", async () => {
  assert.equal(await verifyCli(["node", "verify"], { out: capture(), err: capture() }), 2);
  assert.equal(
    await verifyCli(["node", "verify", "--run"], { out: capture(), err: capture() }),
    2,
  );
  assert.equal(
    await verifyCli(["node", "verify", "--bogus", "x"], { out: capture(), err: capture() }),
    2,
  );
});

test("verifyCli: exits 2 on missing API key", async () => {
  const code = await verifyCli(["node", "verify", "--run", "x"], {
    readConfig: () => ({ ...CONFIG, anthropicApiKey: undefined }),
    out: capture(),
    err: capture(),
  });
  assert.equal(code, 2);
});

test("verifyCli: exits 2 on missing verifier model (no default)", async () => {
  const code = await verifyCli(["node", "verify", "--run", "x"], {
    readConfig: () => ({ ...CONFIG, verifierModel: undefined }),
    out: capture(),
    err: capture(),
  });
  assert.equal(code, 2);
});

test("verifyCli: exits 1 on a plan-hash mismatch (real writer integrity check)", async () => {
  const root = tmpRuns("the-run");
  try {
    const manifestPath = path.join(root, "the-run", "run.json");
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.planHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const code = await verifyCli(
      ["node", "verify", "--run", "the-run"],
      baseDeps("PASS", root, { out: capture(), err: capture() }),
    );
    assert.equal(code, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verifyCli: a missing run exits non-zero (no trustworthy record produced)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-verify-cli-"));
  try {
    await assert.rejects(() =>
      verifyCli(
        ["node", "verify", "--run", "does-not-exist"],
        baseDeps("PASS", root, { out: capture(), err: capture() }),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verifyCli: a non-plan-hash writer error (integrity/schema/write) exits non-zero", async () => {
  // EvidenceIntegrityError, unsupported-schema, and write failures all bubble identically:
  // verify-cli rethrows everything except PlanHashMismatchError, so the process exits non-zero.
  class FakeIntegrityError extends Error {}
  const throwing = (async () => {
    throw new FakeIntegrityError("evidence digest mismatch");
  }) as unknown as typeof writeEvaluation;
  await assert.rejects(() =>
    verifyCli(["node", "verify", "--run", "x"], {
      readConfig: () => CONFIG,
      makeVerifier: () => mockVerifier("PASS"),
      writeEvaluationFn: throwing,
      runsRoot: "/unused",
      flowsDir: FLOWS_DIR,
      out: capture(),
      err: capture(),
    }),
  );
});

test("verifyCli: an --id-file write failure exits non-zero after a real record is written", async () => {
  const root = tmpRuns("the-run");
  const err = capture();
  try {
    const code = await verifyCli(
      ["node", "verify", "--run", "the-run", "--id-file", "/definitely/not/writable/eval-id.txt"],
      baseDeps("PASS", root, {
        writeIdFile: () => {
          throw new Error("EACCES: simulated write failure");
        },
        out: capture(),
        err,
      }),
    );
    assert.equal(code, 1);
    assert.ok(err.text().includes("failed to write --id-file"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
