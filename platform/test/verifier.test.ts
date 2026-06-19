/**
 * Mocked per-criterion verifier tests (Phase 3 Task 4). NO live spend: the deterministic
 * downgrade core `finalizeCriterion` is tested directly against canned model payloads, and
 * the one end-to-end test injects a fake `messages.create` (no SDK client, no API key).
 *
 * What's covered: valid PASS / FAIL / AMBIGUOUS_EVIDENCE; zero-observation PASS|FAIL
 * downgrade; invalid snapshot citation (preserved in the record); invalid event citation;
 * detail-less INCONCLUSIVE schema error; non-completing FAIL requiring BOTH a valid snapshot
 * and a valid event; exactly-one-tool-call enforcement; usage/latency recording + forced
 * tool params; and no execution-success / ground-truth leakage in the assembled prompt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { readEngineConfig, requireVerifierModel } from "../src/config";
import { resolveEvidence } from "../src/verify/resolver";
import type { EvidenceWindow, ProvidedSnapshot } from "../src/verify/resolver";
import { buildVerifierInput, VERDICT_TOOL_SCHEMA } from "../src/verify/prompt";
import {
  AnthropicVerifier,
  finalizeCriterion,
  VERIFIER_MAX_TOKENS,
  VERIFIER_PARAMS,
  type VerifierCriterionInput,
} from "../src/verify/verifier";
import type { ActionEvent, ErrorEvent } from "../src/run/schema";
import { computeCostUsd, loadPricing, ratesFor } from "../src/run/pricing";

// ---- the frozen clean cart (Subtotal $58.97, Tax $5.90, Total $64.87) ----
const BLOB = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen", "snapshots", "snapshot-022.json"),
    "utf8",
  ),
);
const SNAP: ProvidedSnapshot = {
  snapshotId: BLOB.snapshotId,
  kind: "terminal",
  digest: BLOB.digest,
  yaml: BLOB.yaml,
  refs: BLOB.refs,
  elements: BLOB.elements,
  ...(BLOB.pageUrl !== undefined ? { pageUrl: BLOB.pageUrl } : {}),
  ...(BLOB.pageTitle !== undefined ? { pageTitle: BLOB.pageTitle } : {}),
};

const terminalWindow = (): EvidenceWindow => ({ windowKind: "terminal", snapshots: [SNAP], events: [] });

function actionEvent(seq: number, ref: string, failureDetail: string): ActionEvent {
  return {
    runLogSchemaVersion: "1.1",
    runId: "run-test",
    seq,
    ts: "2026-01-01T00:00:00.000Z",
    type: "action",
    stepId: "s1",
    decisionId: "d1",
    snapshotId: SNAP.snapshotId,
    snapshotDigest: SNAP.digest,
    ref,
    action: "click",
    refValidation: { valid: true, validatedBy: "harness" },
    resolvedFrom: SNAP.snapshotId,
    status: "failed",
    isError: true,
    failureDetail,
  };
}
function errorEvent(seq: number, code: string, detail: string): ErrorEvent {
  return {
    runLogSchemaVersion: "1.1",
    runId: "run-test",
    seq,
    ts: "2026-01-01T00:00:00.000Z",
    type: "error",
    stepId: "s1",
    code,
    detail,
  };
}

const FAILURE_DETAIL = "locator.click: Timeout 30000ms exceeded; element intercepts pointer events";
const nonCompletingWindow = (): EvidenceWindow => ({
  windowKind: "non_completing",
  snapshots: [SNAP],
  events: [actionEvent(7, "e35", FAILURE_DETAIL), errorEvent(8, "ACTION_TIMEOUT", "step did not complete")],
});

const input = (window: EvidenceWindow): VerifierCriterionInput => ({
  criterionId: "c1",
  criterionText: "The Subtotal plus the Tax equals the Total.",
  window,
});

// Observation builders against the clean cart.
const snapObs = (ref: string, observedText: string, snapshotId = SNAP.snapshotId) => ({
  label: ref,
  observedText,
  snapshotId,
  ref,
});
const evObs = (eventSeq: number, observedText: string, eventType = "action") => ({
  label: `ev${eventSeq}`,
  eventType,
  eventSeq,
  observedText,
});

// ---- 1. valid PASS ----
test("valid PASS: model PASS resting on valid snapshot citations stands", () => {
  const raw = {
    verdict: "PASS",
    observations: [snapObs("e35", "$58.97"), snapObs("e38", "$5.90")],
    eventObservations: [],
    reasoning: "subtotal + tax reconciles to total",
  };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "PASS");
  assert.equal(ev.inconclusiveDetail, undefined);
  assert.equal(ev.observations.length, 2);
  assert.equal(ev.citationValidations.length, 2);
  assert.ok(ev.citationValidations.every((v) => v.valid));
});

// ---- 2. valid FAIL ----
test("valid FAIL: model FAIL resting on a valid snapshot citation stands", () => {
  const raw = {
    verdict: "FAIL",
    observations: [snapObs("e38", "$5.90")],
    eventObservations: [],
    reasoning: "tax line contradicts the criterion",
  };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "FAIL");
  assert.equal(ev.inconclusiveDetail, undefined);
  assert.equal(ev.citationValidations[0].valid, true);
});

// ---- 3. valid AMBIGUOUS_EVIDENCE ----
test("valid AMBIGUOUS_EVIDENCE: INCONCLUSIVE with a well-formed detail stands, explanation preserved", () => {
  const raw = {
    verdict: "INCONCLUSIVE",
    inconclusiveDetail: { kind: "AMBIGUOUS_EVIDENCE", explanation: "the deciding value is not present in the evidence" },
    observations: [],
    eventObservations: [],
    reasoning: "cannot tell",
  };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.equal(ev.inconclusiveDetail?.kind, "AMBIGUOUS_EVIDENCE");
  assert.equal(
    (ev.inconclusiveDetail as { explanation: string }).explanation,
    "the deciding value is not present in the evidence",
  );
});

// ---- 4. zero-observation PASS/FAIL downgrade ----
test("zero-observation PASS downgrades to INCONCLUSIVE / ERROR / VERIFICATION / INVALID_CITATION", () => {
  const raw = { verdict: "PASS", observations: [], eventObservations: [], reasoning: "looks fine" };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.deepEqual(
    { kind: ev.inconclusiveDetail?.kind, ...(ev.inconclusiveDetail as any) },
    { kind: "ERROR", origin: "VERIFICATION", code: "INVALID_CITATION", explanation: (ev.inconclusiveDetail as any).explanation },
  );
});

test("zero-observation FAIL downgrades the same way", () => {
  const raw = { verdict: "FAIL", observations: [], eventObservations: [], reasoning: "looks wrong" };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.equal((ev.inconclusiveDetail as any).code, "INVALID_CITATION");
  assert.equal((ev.inconclusiveDetail as any).origin, "VERIFICATION");
});

// ---- 5. invalid snapshot citation (preserved in the record) ----
test("invalid snapshot citation downgrades to INVALID_CITATION AND is preserved in the record", () => {
  // $64.87 is the Total — it is NOT displayed at e34 (the `Subtotal` cell).
  const raw = {
    verdict: "PASS",
    observations: [snapObs("e34", "$64.87")],
    eventObservations: [],
    reasoning: "misattributed reading",
  };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.equal((ev.inconclusiveDetail as any).code, "INVALID_CITATION");
  // The failed citation is NOT discarded: the observation + its failed validation remain.
  assert.equal(ev.observations.length, 1);
  assert.equal(ev.observations[0].ref, "e34");
  assert.equal(ev.citationValidations.length, 1);
  assert.equal(ev.citationValidations[0].valid, false);
  assert.equal(ev.citationValidations[0].refPresent, true); // the ref exists…
  assert.equal(ev.citationValidations[0].observedTextPresent, false); // …but the text isn't there
  assert.ok(ev.citationValidations[0].reason && ev.citationValidations[0].reason.length > 0);
});

// ---- 6. invalid event citation ----
test("invalid event citation (valid snapshot, bad event) downgrades to INVALID_CITATION", () => {
  const raw = {
    verdict: "FAIL",
    observations: [snapObs("e35", "$58.97")], // valid snapshot obs
    eventObservations: [evObs(999, "Timeout")], // seq 999 is not in the window
    reasoning: "claims an actuation failure",
  };
  const ev = finalizeCriterion(input(nonCompletingWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.equal((ev.inconclusiveDetail as any).code, "INVALID_CITATION");
  // The snapshot citation itself was fine — it was the event citation that failed.
  assert.equal(ev.citationValidations[0].valid, true);
});

// ---- 7. detail-less INCONCLUSIVE schema error (STRICT — never invented) ----
test("detail-less INCONCLUSIVE becomes INCONCLUSIVE / ERROR / VERIFICATION / VERIFIER_SCHEMA_ERROR", () => {
  const raw = { verdict: "INCONCLUSIVE", observations: [], eventObservations: [], reasoning: "unsure" };
  const ev = finalizeCriterion(input(terminalWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  const d = ev.inconclusiveDetail as any;
  assert.equal(d.kind, "ERROR");
  assert.equal(d.origin, "VERIFICATION");
  assert.equal(d.code, "VERIFIER_SCHEMA_ERROR");
});

// ---- 8. non-completing FAIL requires BOTH a valid snapshot and a valid event ----
test("non-completing FAIL with a valid snapshot but NO valid event downgrades to INVALID_CITATION", () => {
  const raw = {
    verdict: "FAIL",
    observations: [snapObs("e35", "$58.97")], // valid snapshot, control present
    eventObservations: [], // but no event substantiating the failure
    reasoning: "control present, action failed",
  };
  const ev = finalizeCriterion(input(nonCompletingWindow()), raw, 1);
  assert.equal(ev.verdict, "INCONCLUSIVE");
  assert.equal((ev.inconclusiveDetail as any).code, "INVALID_CITATION");
});

test("non-completing FAIL with BOTH a valid snapshot AND a valid event stands as FAIL", () => {
  const raw = {
    verdict: "FAIL",
    observations: [snapObs("e35", "$58.97")], // valid snapshot (control present)
    eventObservations: [evObs(7, "Timeout")], // valid event (Timeout ⊆ failureDetail)
    reasoning: "control present and the action failed with a timeout",
  };
  const ev = finalizeCriterion(input(nonCompletingWindow()), raw, 1);
  assert.equal(ev.verdict, "FAIL");
  assert.equal(ev.inconclusiveDetail, undefined);
  // events are summarized in the record, not persisted as per-observation validations.
  assert.deepEqual(ev.evidence.eventRefs, [
    { seq: 7, type: "action" },
    { seq: 8, type: "error" },
  ]);
});

// ---- exactly-one-tool-call enforcement ----
test("zero or multiple tool calls => VERIFIER_SCHEMA_ERROR regardless of payload", () => {
  const goodRaw = {
    verdict: "PASS",
    observations: [snapObs("e35", "$58.97")],
    eventObservations: [],
    reasoning: "ok",
  };
  for (const count of [0, 2]) {
    const ev = finalizeCriterion(input(terminalWindow()), goodRaw, count);
    assert.equal(ev.verdict, "INCONCLUSIVE");
    assert.equal((ev.inconclusiveDetail as any).code, "VERIFIER_SCHEMA_ERROR");
  }
});

// ---- end-to-end with an injected create (no live spend, no API key) ----
test("AnthropicVerifier records usage/latency, forces the tool, sends no sampling/thinking params", async () => {
  let captured: any;
  const fakeResp = {
    content: [
      {
        type: "tool_use",
        name: "record_verdict",
        id: "t1",
        input: {
          verdict: "PASS",
          observations: [snapObs("e35", "$58.97"), snapObs("e38", "$5.90")],
          eventObservations: [],
          reasoning: "reconciles",
        },
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 64, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  const verifier = new AnthropicVerifier({
    model: "claude-opus-4-8",
    create: async (req: any) => {
      captured = req;
      return fakeResp as any;
    },
  });

  const res = await verifier.verify(input(terminalWindow()));

  // forced tool + lowest-variance params
  assert.deepEqual(captured.tool_choice, {
    type: "tool",
    name: "record_verdict",
    disable_parallel_tool_use: true,
  });
  assert.equal(captured.max_tokens, VERIFIER_MAX_TOKENS);
  assert.equal(captured.tools[0].name, "record_verdict");
  assert.equal(captured.temperature, undefined);
  assert.equal(captured.top_p, undefined);
  assert.equal(captured.top_k, undefined);
  assert.equal(captured.thinking, undefined);

  // usage / latency / model recorded
  assert.equal(res.usage.input_tokens, 1200);
  assert.equal(res.usage.output_tokens, 64);
  assert.equal(res.model, "claude-opus-4-8");
  assert.equal(res.toolCallCount, 1);
  assert.equal(res.rawVerdict, "PASS");
  assert.ok(typeof res.latencyMs === "number" && res.latencyMs >= 0);
  assert.equal(res.evaluation.verdict, "PASS");

  // cost recomputes from the recorded raw usage + the committed pricing
  const rates = ratesFor(loadPricing("anthropic-2026-06"), "claude-opus-4-8");
  assert.ok(computeCostUsd(res.usage, rates) > 0);

  // sanity: the recorded params object is exactly the lowest-variance config
  assert.equal(VERIFIER_PARAMS.tool_choice, "record_verdict");
  assert.equal(VERIFIER_PARAMS.disable_parallel_tool_use, true);
  assert.equal(VERIFIER_PARAMS.sampling, "none");
  assert.equal(VERIFIER_PARAMS.thinking, "off");
});

// ---- tool schema requires both observations and eventObservations ----
test("VERDICT_TOOL_SCHEMA requires verdict, observations, eventObservations, and reasoning", () => {
  assert.deepEqual(
    [...VERDICT_TOOL_SCHEMA.required].sort(),
    ["eventObservations", "observations", "reasoning", "verdict"],
  );
  // eventObservations stays a top-level required array (the model must emit [] when there
  // are no actuation events on an ordinary snapshot-only criterion).
  assert.equal(VERDICT_TOOL_SCHEMA.properties.eventObservations.type, "array");
});

// ---- cost-safety: the verifier model has no silent default ----
test("requireVerifierModel fails loudly when PROOFLOOP_VERIFIER_MODEL is absent", () => {
  const cfg = readEngineConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.verifierModel, undefined);
  assert.throws(() => requireVerifierModel(cfg), /PROOFLOOP_VERIFIER_MODEL is not set/);
});

test("requireVerifierModel returns the explicitly configured model", () => {
  const cfg = readEngineConfig({ PROOFLOOP_VERIFIER_MODEL: "claude-opus-4-8" } as NodeJS.ProcessEnv);
  assert.equal(requireVerifierModel(cfg), "claude-opus-4-8");
});

// ---- 9. no execution-success / ground-truth leakage in the assembled prompt ----
test("assembled prompt for a BUGGY run carries only the criterion + evidence — no status/ground truth", () => {
  // Real assembly path: resolve the buggy fixture's evidence window, then build the input.
  const stepLines = "1. step 1.";
  const plan = parseFlow(
    `---\nname: bug002-cart\nentry: /x\n---\n\n## Steps\n${stepLines}\n\n## Acceptance Criteria\n- The Tax equals 10% of the Subtotal.\n`,
    "bug002-cart",
  );
  const resolved = resolveEvidence(plan, path.join(__dirname, "fixtures", "runs", "buggy-cart-bug002"))[0];
  assert.ok(resolved.evidence, "buggy fixture should resolve to an evidence window");
  const { system, user } = buildVerifierInput(plan.criteria[0].text, resolved.evidence!);
  const blob = `${system}\n${user}`;

  // the criterion text and the buggy evidence ARE present
  assert.ok(blob.includes("The Tax equals 10% of the Subtotal."));
  assert.ok(blob.includes("$0.00")); // the injected buggy tax line — evidence flows through

  // NONE of the execution-status / decider / ground-truth surfaces leak
  for (const forbidden of [
    "executionStatus",
    "execution status",
    "all steps",
    "completed successfully",
    "step_complete",
    "rationale",
    "decider",
    "PROOFLOOP_BUGS",
    "BUG-002",
    "bug-ledger",
    "ledger",
    "debug-only",
    "DEBUG_TOKEN",
    "step 1.", // the run's step text is never shown to the verifier
  ]) {
    assert.ok(!blob.includes(forbidden), `assembled prompt must not contain ${JSON.stringify(forbidden)}`);
  }
});
