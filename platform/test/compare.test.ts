import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RawUsage } from "../src/run/pricing";
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
  buildComparison,
  COMPARISON_CAVEAT,
  COMPARISON_SECTION_LABEL,
  renderComparisonHtml,
} from "../src/report/compare";
import {
  loadManifest,
  ManifestError,
  parseManifest,
  slugify,
} from "../src/report/manifest";

const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
// A test-tree fixture with the same verified mapping shape — the source tests never depend
// on the real presentation/ manifest (that is reviewed as an artifact at the Task 4 gate).
const FIXTURE_MANIFEST = path.join(__dirname, "fixtures", "presentation", "phase3-demo-manifest.json");
const MODEL = "claude-opus-4-8";
const USAGE: RawUsage = { input_tokens: 1000, output_tokens: 200 };
const CLOCK = ["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"];

function fixedClock(values: string[]): () => string {
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
        { verdict, observations: [validObservation(input.window)], eventObservations: [], reasoning: `decided ${verdict}` },
        1,
      );
      return { evaluation, usage: { ...USAGE }, latencyMs: 42, model: MODEL, toolCallCount: 1, rawVerdict: verdict };
    },
  };
}

/** Create runsRoot/<runId> (a copy of the frozen run, runId re-stamped) with a generated eval-001. */
async function tmpRunInRoot(runsRoot: string, runId: string, verdict: Verdict): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  fs.cpSync(FROZEN, runDir, { recursive: true });
  const mf = path.join(runDir, "run.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.runId = runId; // dir name must equal the internal runId, as in real runs/
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  await writeEvaluation({
    runDir,
    flowsDir: FLOWS_DIR,
    verifier: mockVerifier(verdict),
    verifierModel: MODEL,
    verifierParams: VERIFIER_PARAMS,
    clock: fixedClock(CLOCK),
  });
}

// ---------------- manifest validation (D27 presentation-only boundary) ----------------

test("parseManifest: a well-formed manifest parses", () => {
  const m = parseManifest({
    schemaVersion: "1.0",
    title: "Demo",
    runs: [{ label: "Clean", runId: "r1", evaluationId: "eval-001" }],
  });
  assert.equal(m.title, "Demo");
  assert.equal(m.runs.length, 1);
});

test("parseManifest: rejects an unknown top-level key (no bug-ledger/expected verdicts)", () => {
  assert.throws(
    () =>
      parseManifest({
        schemaVersion: "1.0",
        title: "Demo",
        runs: [{ label: "Clean", runId: "r1", evaluationId: "eval-001" }],
        bugLedger: { "BUG-002": "FAIL" },
      }),
    ManifestError,
  );
});

test("parseManifest: rejects an unknown per-run key (e.g. expectedVerdict)", () => {
  assert.throws(
    () =>
      parseManifest({
        schemaVersion: "1.0",
        title: "Demo",
        runs: [{ label: "Clean", runId: "r1", evaluationId: "eval-001", expectedVerdict: "PASS" }],
      }),
    ManifestError,
  );
});

test("parseManifest: rejects bad schemaVersion, empty runs, and non-string fields", () => {
  assert.throws(() => parseManifest({ schemaVersion: "2.0", title: "x", runs: [{ label: "a", runId: "b", evaluationId: "c" }] }), ManifestError);
  assert.throws(() => parseManifest({ schemaVersion: "1.0", title: "x", runs: [] }), ManifestError);
  assert.throws(() => parseManifest({ schemaVersion: "1.0", title: "", runs: [{ label: "a", runId: "b", evaluationId: "c" }] }), ManifestError);
  assert.throws(() => parseManifest({ schemaVersion: "1.0", title: "x", runs: [{ label: "a", runId: 5, evaluationId: "c" }] }), ManifestError);
});

test("slugify: deterministic label slugs match the Task 4 folder names", () => {
  assert.equal(slugify("Clean"), "clean");
  assert.equal(slugify("Renamed control"), "renamed-control");
  assert.equal(slugify("Broken tax"), "broken-tax");
  assert.equal(slugify("Renamed control + broken tax"), "renamed-control-broken-tax");
});

test("a manifest with the verified mappings is valid, presentation-only, and well-formed", () => {
  const m = loadManifest(FIXTURE_MANIFEST);
  assert.equal(m.title, "Phase 3 regression demonstration");
  assert.deepEqual(
    m.runs.map((r) => [r.label, r.runId, r.evaluationId]),
    [
      ["Clean", "add-to-cart-2026-06-18T21-34-32-463Z-d1908fac", "eval-001"],
      ["Renamed control", "add-to-cart-2026-06-19T11-17-07-018Z-51cd9564", "eval-001"],
      ["Broken tax", "add-to-cart-2026-06-19T11-21-55-992Z-57f2c78f", "eval-001"],
      ["Renamed control + broken tax", "add-to-cart-2026-06-19T11-23-44-691Z-8686ccd2", "eval-001"],
    ],
  );
});

// ---------------- comparison build + render ----------------

test("buildComparison: builds only from the selected reports and re-states their verdicts/costs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-compare-"));
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  try {
    await tmpRunInRoot(runsRoot, "run-clean", "PASS");
    await tmpRunInRoot(runsRoot, "run-broken", "FAIL");
    // Stamp a Tax-labelled observation into each evaluation so Tax-evidence derivation (which
    // reads the report's OWN recorded observation) has something to find.
    for (const [rid, tax] of [["run-clean", "$5.90"], ["run-broken", "$0.00"]] as const) {
      const p = path.join(runsRoot, rid, "evaluations", "eval-001", "evaluation.json");
      const rec = JSON.parse(fs.readFileSync(p, "utf8"));
      const c2 = rec.criteria.find((c: any) => c.criterionId === "add-to-cart:C2");
      c2.observations[0].label = "Tax";
      c2.observations[0].observedText = tax;
      fs.writeFileSync(p, JSON.stringify(rec, null, 2) + "\n");
    }
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0",
        title: "Phase 3 regression demonstration",
        runs: [
          { label: "Clean", runId: "run-clean", evaluationId: "eval-001" },
          { label: "Broken tax", runId: "run-broken", evaluationId: "eval-001" },
        ],
      }),
    );

    const model = buildComparison({ manifestPath, runsRoot, flowsDir: FLOWS_DIR });
    assert.equal(model.title, "Phase 3 regression demonstration");
    assert.deepEqual(model.criterionIds, ["add-to-cart:C1", "add-to-cart:C2", "add-to-cart:C3"]);
    assert.equal(model.runs.length, 2);

    const clean = model.runs[0];
    assert.equal(clean.label, "Clean");
    assert.equal(clean.slug, "clean");
    assert.equal(clean.runId, "run-clean");
    assert.equal(clean.executionStatus, "completed");
    assert.equal(clean.flowVerdict, "PASS");
    assert.equal(clean.reportHref, "runs/clean/report.html");
    assert.equal(clean.taxEvidence, "$5.90"); // derived from the report's own observation
    assert.ok(clean.deciderCostUsd > 0 && clean.verifierCostUsd > 0);

    const broken = model.runs[1];
    assert.equal(broken.flowVerdict, "FAIL");
    assert.equal(broken.reportHref, "runs/broken-tax/report.html");
    assert.equal(broken.taxEvidence, "$0.00");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildComparison: a missing selected run fails loud (inherits builder integrity)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-compare-"));
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  try {
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0",
        title: "Demo",
        runs: [{ label: "Clean", runId: "does-not-exist", evaluationId: "eval-001" }],
      }),
    );
    assert.throws(() => buildComparison({ manifestPath, runsRoot, flowsDir: FLOWS_DIR }), Error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderComparisonHtml: carries the exact label + caveat, escapes labels, links reports, no scripts", () => {
  const model = {
    title: `Demo <script>alert(1)</script>`,
    criterionIds: ["add-to-cart:C1", "add-to-cart:C2", "add-to-cart:C3"],
    runs: [
      {
        label: `Clean <img src=x>`,
        slug: "clean",
        runId: "run-clean",
        evaluationId: "eval-001",
        executionStatus: "completed",
        flowVerdict: "PASS" as Verdict,
        criteria: [
          { criterionId: "add-to-cart:C1", verdict: "PASS" as Verdict },
          { criterionId: "add-to-cart:C2", verdict: "PASS" as Verdict },
          { criterionId: "add-to-cart:C3", verdict: "PASS" as Verdict },
        ],
        taxEvidence: "$5.90",
        deciderCostUsd: 0.11,
        verifierCostUsd: 0.13,
        reportHref: "runs/clean/report.html",
      },
      {
        label: "Broken tax",
        slug: "broken-tax",
        runId: "run-broken",
        evaluationId: "eval-001",
        executionStatus: "completed",
        flowVerdict: "FAIL" as Verdict,
        criteria: [
          { criterionId: "add-to-cart:C1", verdict: "PASS" as Verdict },
          { criterionId: "add-to-cart:C2", verdict: "FAIL" as Verdict },
          { criterionId: "add-to-cart:C3", verdict: "PASS" as Verdict },
        ],
        taxEvidence: "$0.00",
        deciderCostUsd: 0.11,
        verifierCostUsd: 0.14,
        reportHref: "runs/broken-tax/report.html",
      },
    ],
  };
  const html = renderComparisonHtml(model);

  assert.ok(html.includes(`<h1>${COMPARISON_SECTION_LABEL}</h1>`));
  assert.ok(html.includes(COMPARISON_CAVEAT));
  assert.ok(!/accuracy results/i.test(html), "never labelled as accuracy results");
  // the duplicate muted subtitle is gone: the title appears only once, inside <title>
  assert.equal(html.split("Demo &lt;script&gt;").length - 1, 1, "title not duplicated as a subtitle");
  // escaping: no live tags from manifest/report data
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("Clean &lt;img src=x&gt;"));
  // friendly criterion headers, with the stable id kept as secondary text
  assert.ok(html.includes("Line totals") && html.includes("Proportional tax") && html.includes("Total reconciliation"));
  assert.ok(html.includes("<code>add-to-cart:C2</code>"));
  // Tax evidence column derived per run
  assert.ok(html.includes("Tax evidence"));
  assert.ok(html.includes("<td>$5.90</td>") && html.includes("<td>$0.00</td>"));
  // execution status rendered as a neutral badge, distinct from verdict badges
  assert.ok(html.includes('class="badge badge-neutral">completed</span>'));
  // costs formatted to 4 decimals
  assert.ok(html.includes("$0.1100") && html.includes("$0.1300"));
  // link text is descriptive, not a filename
  assert.ok(html.includes("View evidence report") && !html.includes(">report.html<"));
  // relative links to the committed per-run reports; responsive scroll wrapper; no external resources
  assert.ok(html.includes('href="runs/clean/report.html"'));
  assert.ok(html.includes('href="runs/broken-tax/report.html"'));
  assert.ok(html.includes('class="table-wrap"'));
  assert.ok(!/<link\b/i.test(html) && !/src\s*=\s*["']https?:/i.test(html));
  assert.ok(html.startsWith("<!DOCTYPE html>"));
});
