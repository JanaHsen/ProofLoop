/**
 * Phase 5 Task 5 — mode-isolation architecture proof (D32). Enforces, by runtime invariance
 * and a static source-surface guard, that mode only ever changes runtime browser behavior at
 * the launch seam (`resolveLaunchArgs`). Companion record:
 * platform/test/architecture/mode-isolation.md. No live browser/MCP/decider/verifier/summary
 * or API call: deciders/actuators/verifiers are mocked and deterministic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { parseSnapshot, type ParsedSnapshot, type ValidatedRef } from "../src/mcp/snapshot";
import {
  HEADLESS_FLAG,
  browserConfigFor,
  buildServerArgs,
  resolveLaunchArgs,
  type ToolResult,
} from "../src/mcp/client";
import { BrowserActuator, runFlow } from "../src/engine/loop";
import { SYSTEM_PROMPT, type Decider, type DecisionContext, type DeciderResult } from "../src/engine/decider";
import { readEvents } from "../src/run/audit";
import type { BrowserConfig, BrowserMode, RunManifest } from "../src/run/schema";
import { resolveEvidence, type EvidenceWindow } from "../src/verify/resolver";
import { buildVerifierInput } from "../src/verify/prompt";
import { citationTextSurface } from "../src/verify/citation";
import { finalizeCriterion, VERIFIER_PARAMS, type Verifier, type VerifierCriterionInput, type VerifierResult } from "../src/verify/verifier";
import { writeEvaluation } from "../src/verify/writer";
import { buildReport } from "../src/report/builder";
import { buildSummaryInput, serializeSummaryInput } from "../src/report/summary";
import type { Verdict } from "../src/verify/evaluation";
import type { RawUsage } from "../src/run/pricing";

const NOW = () => new Date("2026-06-18T00:00:00.000Z");
const USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const HEADLESS: ModeMeta = { mode: "headless", requestedMode: "headless", browser: browserConfigFor("desktop") };
const HEADED: ModeMeta = { mode: "headed", requestedMode: "headed", browser: browserConfigFor("desktop") };

interface ModeMeta {
  mode: BrowserMode;
  requestedMode: BrowserMode;
  browser: BrowserConfig;
}

function plan() {
  return parseFlow(
    "---\nname: T\nentry: /login\n---\n\n## Steps\n1. Sign in.\n\n## Acceptance Criteria\n- the user is signed in.\n",
    "login",
  );
}
function loginSnap(): ParsedSnapshot {
  return parseSnapshot(
    '- generic [ref=e1]:\n  - button "Sign in" [ref=e8]',
    "### Page\n- Page URL: http://x/login\n- Page Title: Login",
  );
}

class MockDecider implements Decider {
  readonly seen: DecisionContext[] = [];
  private calls = 0;
  constructor(private readonly script: (ctx: DecisionContext, call: number) => unknown) {}
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    this.seen.push(ctx);
    const inner = this.script(ctx, this.calls++);
    return { rawDecision: inner === undefined ? undefined : { decision: inner }, usage: { ...USAGE }, latencyMs: 5, model: "claude-sonnet-4-6" };
  }
}

class MockActuator implements BrowserActuator {
  readonly clicks: { ref: string; element: string }[] = [];
  private i = 0;
  constructor(private readonly snaps: (i: number) => ParsedSnapshot) {}
  async launch() {}
  async navigate() {}
  async snapshot() {
    return this.snaps(this.i++);
  }
  async clickRef(ref: ValidatedRef, element: string): Promise<ToolResult> {
    this.clicks.push({ ref, element });
    return { text: "ok", isError: false };
  }
  async typeRef(): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async close() {}
}

interface ScenarioResult {
  manifest: RunManifest;
  events: ReturnType<typeof readEvents>["events"];
  seen: DecisionContext[];
  clicks: { ref: string; element: string }[];
  runDir: string;
  root: string;
}

/** Run the identical fixed scenario, varying ONLY the recorded mode metadata. */
async function runScenario(modeMeta: ModeMeta): Promise<ScenarioResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-iso-"));
  const decider = new MockDecider((_ctx, call) =>
    call === 0
      ? { kind: "action", action: "click", ref: "e8", rationale: "click sign in" }
      : { kind: "step_complete", rationale: "signed in" },
  );
  const actuator = new MockActuator(() => loginSnap());
  const manifest = await runFlow({
    plan: plan(),
    baseUrl: "http://x",
    runId: "r",
    runsRoot: root,
    model: "claude-sonnet-4-6",
    pricingConfigId: "anthropic-2026-06",
    decider,
    actuator,
    now: NOW,
    ...modeMeta,
  });
  const runDir = path.join(root, "r");
  return { manifest, events: readEvents(path.join(runDir, "events.jsonl")).events, seen: decider.seen, clicks: actuator.clicks, runDir, root };
}

/** Manifest copy with the three explicitly-permitted mode metadata fields removed. */
function withoutModeMeta(m: RunManifest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...m };
  delete copy.mode;
  delete copy.requestedMode;
  delete copy.browser;
  return copy;
}

const rmrf = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

// === 1. Launch seam ================================================================

test("D32/launch: headed vs headless args differ ONLY by one --headless; all else identical", () => {
  const opts = { viewport: "desktop", outputDir: "/tmp/o" } as const;
  const headed = resolveLaunchArgs({ ...opts, mode: "headed" });
  const headless = resolveLaunchArgs({ ...opts, mode: "headless" });

  // exactly one --headless toggles the pair; nothing else moves
  assert.deepEqual(headless.filter((a) => a !== HEADLESS_FLAG), headed);
  assert.equal(headless.filter((a) => a === HEADLESS_FLAG).length, 1);
  assert.equal(headed.filter((a) => a === HEADLESS_FLAG).length, 0);
  // headed is byte-identical to the mode-agnostic base
  assert.deepEqual(headed, buildServerArgs(opts));
  // viewport / isolation / engine / snapshot-mode / output-mode are present and shared
  for (const flag of ["--isolated", "--browser", "chromium", "--viewport-size", "1280x720", "--snapshot-mode", "full", "--output-mode", "stdout"]) {
    assert.ok(headed.includes(flag) && headless.includes(flag), `both modes keep ${flag}`);
  }
  // no silent fallback: a headed request never yields --headless
  assert.ok(!headed.includes(HEADLESS_FLAG));
});

// === 2. Execution-loop invariance (covers guards/retries/errors/totals too) =========

test("D32/loop: identical execution under headed vs headless, save the recorded mode metadata", async () => {
  const a = await runScenario(HEADLESS);
  const b = await runScenario(HEADED);
  try {
    // same snapshots requested, same decisions, same actions, same retries/errors/guards,
    // same event types + payloads — the whole event stream is byte-identical.
    assert.deepEqual(a.events, b.events);
    // same decision INPUTS (the decider's only per-run context)
    assert.deepEqual(a.seen, b.seen);
    // same actions dispatched
    assert.deepEqual(a.clicks, b.clicks);
    // same execution status + totals (guard/retry/cost accounting) — manifest minus mode meta
    assert.deepEqual(withoutModeMeta(a.manifest), withoutModeMeta(b.manifest));
    assert.equal(a.manifest.executionStatus, "completed");
    // the ONLY difference is the explicitly recorded mode metadata
    assert.equal(a.manifest.mode, "headless");
    assert.equal(b.manifest.mode, "headed");
    assert.notDeepEqual(a.manifest.browser, undefined);
  } finally {
    rmrf(a.root);
    rmrf(b.root);
  }
});

// === 3. Prompt isolation ===========================================================

test("D32/prompt: decider prompt + verifier input + summary input carry no mode", async () => {
  // decider: the static system prompt has no mode; the per-run context (Test 2) is identical
  // across modes, so the assembled decider prompt cannot contain mode.
  assert.ok(!/\bheaded\b|\bheadless\b|browsermode|requestedmode/i.test(SYSTEM_PROMPT));

  const a = await runScenario(HEADLESS);
  try {
    assert.ok(!/headed|headless/i.test(JSON.stringify(a.seen)), "decider context carries no mode token");

    // verifier: buildVerifierInput takes (criterionText, window) — no mode anywhere
    const resolved = resolveEvidence(plan(), a.runDir);
    const withEvidence = resolved.find((r) => r.evidence);
    assert.ok(withEvidence?.evidence, "scenario produced a gradeable evidence window");
    const vinput = buildVerifierInput("Is the user signed in?", withEvidence.evidence as EvidenceWindow);
    assert.ok(!/headed|headless/i.test(JSON.stringify(vinput)), "verifier input carries no mode token");
  } finally {
    rmrf(a.root);
  }

  // summary: derived purely from the deterministic report projection, which has no mode field
  const A = tmpFrozen("headed");
  try {
    const e = await writeFrozenEval(A.runDir);
    const report = buildReport({ runDir: A.runDir, evaluationId: e.evaluationId, flowsDir: FLOWS_DIR });
    const summaryInput = serializeSummaryInput(buildSummaryInput(report));
    assert.ok(!/headed|headless/i.test(summaryInput), "summary input carries no mode token");
  } finally {
    rmrf(A.root);
  }
});

// === 4. Verification & evidence invariance =========================================

test("D32/verify: evidence resolution is identical across modes", async () => {
  const a = await runScenario(HEADLESS);
  const b = await runScenario(HEADED);
  try {
    assert.deepEqual(resolveEvidence(plan(), a.runDir), resolveEvidence(plan(), b.runDir));
  } finally {
    rmrf(a.root);
    rmrf(b.root);
  }
});

test("D32/verify: evaluation record (verdict/observations/citations/aggregation) identical when only manifest.mode differs", async () => {
  const A = tmpFrozen("headed");
  const B = tmpFrozen("headless");
  try {
    const ra = await writeFrozenEval(A.runDir);
    const rb = await writeFrozenEval(B.runDir);
    assert.deepEqual(ra.record, rb.record);
  } finally {
    rmrf(A.root);
    rmrf(B.root);
  }
});

// === 5. Guard / redaction / pricing invariance =====================================
//
// guards.ts, redaction.ts, and pricing.ts take no mode parameter (enforced by the static
// surface guard below) and the loop-invariance test proves guard_tripped / retry / error
// events and the cost/token TOTALS are byte-identical across modes. This test pins the
// totals equivalence explicitly.

test("D32/guard+cost: guard/retry/error events and cost-token totals are mode-invariant", async () => {
  const a = await runScenario(HEADLESS);
  const b = await runScenario(HEADED);
  try {
    const kinds = (r: ScenarioResult) => r.events.filter((e) => e.type === "guard_tripped" || e.type === "retry" || e.type === "error");
    assert.deepEqual(kinds(a), kinds(b));
    assert.deepEqual(a.manifest.totals, b.manifest.totals);
  } finally {
    rmrf(a.root);
    rmrf(b.root);
  }
});

// === 6. Reporting invariance =======================================================

test("D32/report: the report is identical when only manifest.mode differs", async () => {
  const A = tmpFrozen("headed");
  const B = tmpFrozen("headless");
  try {
    const ea = await writeFrozenEval(A.runDir);
    const eb = await writeFrozenEval(B.runDir);
    const repA = buildReport({ runDir: A.runDir, evaluationId: ea.evaluationId, flowsDir: FLOWS_DIR });
    const repB = buildReport({ runDir: B.runDir, evaluationId: eb.evaluationId, flowsDir: FLOWS_DIR });
    assert.deepEqual(repA, repB);
  } finally {
    rmrf(A.root);
    rmrf(B.root);
  }
});

// === 7. Static source-surface guard ================================================

test("D32/static: no mode-bearing identifier leaks into forbidden production modules", () => {
  const SRC = path.join(__dirname, "..", "src");
  const FORBIDDEN_FILES = [
    "engine/decider.ts", "verify/verifier.ts", "verify/prompt.ts", "verify/resolver.ts",
    "verify/citation.ts", "verify/evaluation.ts", "verify/writer.ts", "engine/guards.ts",
    "run/redaction.ts", "run/pricing.ts", "report/summary.ts", "report/builder.ts",
    "report/compare.ts", "report/html.ts", "report/manifest.ts", "report/labels.ts",
  ];
  // Unambiguous mode identifiers only — bare "mode" is deliberately excluded so ordinary
  // phrases ("failure mode") and the `--snapshot-mode` / `--output-mode` flags never trip it.
  const FORBIDDEN = /\b(BrowserMode|requestedMode|browserConfigFor|resolveLaunchArgs|effectiveMode|assertHeadedDisplay|isDisplayAvailable|HeadedDisplayUnavailableError|HEADLESS_FLAG)\b|--headless|\bheadless\b|\bheaded\b|\.mode\b/i;
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const violations: string[] = [];
  for (const rel of FORBIDDEN_FILES) {
    const lines = stripComments(fs.readFileSync(path.join(SRC, rel), "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = FORBIDDEN.exec(line);
      if (m) violations.push(`${rel}:${i + 1}  «${m[0]}»  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    violations,
    [],
    `mode-bearing identifiers leaked into forbidden modules:\n${violations.join("\n")}`,
  );
});

// --- offline frozen-run helpers (copy of the writer/report test pattern) ------------

const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
const VERIFIER_MODEL = "claude-opus-4-8";
const VUSAGE: RawUsage = { input_tokens: 1000, output_tokens: 200 };
const CLOCK = ["2026-06-19T00:00:00.000Z", "2026-06-19T00:00:05.000Z"];

function fixedClock(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function validObservation(window: EvidenceWindow): unknown {
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
      return { evaluation, usage: { ...VUSAGE }, latencyMs: 42, model: VERIFIER_MODEL, toolCallCount: 1, rawVerdict: verdict };
    },
  };
}

/** Copy the frozen run, then flip ONLY the manifest's `mode` field (a 1.0 manifest, so no
 *  1.2 validation) — the cleanest single-variable change to prove downstream invariance. */
function tmpFrozen(mode: BrowserMode): { root: string; runDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-iso-frozen-"));
  const runDir = path.join(root, "run");
  fs.cpSync(FROZEN, runDir, { recursive: true });
  const mp = path.join(runDir, "run.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  manifest.mode = mode;
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  return { root, runDir };
}

function writeFrozenEval(runDir: string) {
  return writeEvaluation({
    runDir,
    flowsDir: FLOWS_DIR,
    verifier: mockVerifier("PASS"),
    verifierModel: VERIFIER_MODEL,
    verifierParams: VERIFIER_PARAMS,
    clock: fixedClock(CLOCK),
  });
}
