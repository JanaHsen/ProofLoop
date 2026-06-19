import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DECISION_TOOL_SCHEMA,
  INVALID_SNAPSHOT_REF,
  MAX_CORRECTIONS_PER_DECISION,
  buildCorrectionNotice,
  buildDecisionToolSchema,
  parseDecision,
} from "../src/engine/protocol";
import {
  extractYamlBlock,
  parseSnapshot,
  validateRef,
} from "../src/mcp/snapshot";

const SNAP = parseSnapshot(
  extractYamlBlock(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "snapshot-result.txt"),
      "utf8",
    ),
  )!,
);

// --- decision schema validation ---------------------------------------------------

test("parseDecision: valid click action", () => {
  const r = parseDecision({ kind: "action", action: "click", ref: "e8", rationale: "submit" });
  assert.ok(r.ok && r.decision.kind === "action" && r.decision.action === "click");
});

test("parseDecision: type requires value", () => {
  const ok = parseDecision({ kind: "action", action: "type", ref: "e5", value: "alice", rationale: "fill" });
  assert.ok(ok.ok && ok.decision.kind === "action" && ok.decision.value === "alice");
  const bad = parseDecision({ kind: "action", action: "type", ref: "e5", rationale: "fill" });
  assert.ok(!bad.ok && /value/.test(bad.error));
});

test("parseDecision: action requires ref and rationale", () => {
  assert.ok(!parseDecision({ kind: "action", action: "click", rationale: "x" }).ok);
  assert.ok(!parseDecision({ kind: "action", action: "click", ref: "e8" }).ok);
});

test("parseDecision: step_complete needs rationale, blocked needs reason", () => {
  assert.ok(parseDecision({ kind: "step_complete", rationale: "done" }).ok);
  assert.ok(!parseDecision({ kind: "step_complete" }).ok);
  assert.ok(parseDecision({ kind: "blocked", reason: "no control" }).ok);
  assert.ok(!parseDecision({ kind: "blocked" }).ok);
});

test("parseDecision: rejects unknown kind / non-object", () => {
  assert.ok(!parseDecision({ kind: "navigate" }).ok);
  assert.ok(!parseDecision("nope").ok);
  assert.ok(!parseDecision(null).ok);
});

test("buildDecisionToolSchema: steers ref to the current snapshot's refs", () => {
  const schema = buildDecisionToolSchema(SNAP.refs);
  const refProp = (schema.properties as Record<string, Record<string, unknown>>).ref;
  assert.deepEqual([...(refProp.enum as string[])].sort(), [...SNAP.refs].sort());
  // base schema is untouched (no enum) — steering is per-call only
  assert.equal((DECISION_TOOL_SCHEMA.properties as { ref: { enum?: unknown } }).ref.enum, undefined);
  // empty refs => no enum injected
  assert.equal(
    (buildDecisionToolSchema([]).properties as Record<string, Record<string, unknown>>).ref.enum,
    undefined,
  );
});

// --- ref validation (the authoritative check) -------------------------------------

test("validateRef: accepts a snapshot ref, marks validatedBy harness", () => {
  const v = validateRef(SNAP, "e5");
  assert.ok(v.valid && v.ref === "e5" && v.validatedBy === "harness");
});

test("validateRef: rejects non-token and not-in-snapshot", () => {
  assert.deepEqual(
    (() => {
      const v = validateRef(SNAP, "#username");
      return v.valid ? null : v.reason;
    })(),
    "not_a_ref_token",
  );
  const stale = validateRef(SNAP, "e99");
  assert.ok(!stale.valid && stale.reason === "not_in_snapshot");
});

// --- informed single correction ---------------------------------------------------

test("buildCorrectionNotice: invalid ref names the bad ref and lists choices", () => {
  const notice = buildCorrectionNotice(
    { kind: "invalid_ref", reason: "not_in_snapshot", detail: "stale", attemptedRef: "e42" },
    SNAP,
  );
  assert.match(notice, /e42/);
  assert.match(notice, /Available refs:/);
  assert.match(notice, /e8 \(button "Sign in"\)/);
});

test("buildCorrectionNotice: schema failure is directive and quotes the violation", () => {
  const notice = buildCorrectionNotice({ kind: "schema", detail: "missing rationale" }, SNAP);
  assert.match(notice, /invalid: missing rationale/);
  assert.match(notice, /non-empty rationale/);
});

test("buildCorrectionNotice: repeated-no-effect tells the model not to repeat", () => {
  const notice = buildCorrectionNotice(
    { kind: "repeated_no_effect", detail: "type on e34 had no observable effect", attemptedRef: "e34" },
    SNAP,
  );
  assert.match(notice, /no observable effect/);
  assert.match(notice, /Do not repeat/);
});

test("policy constants are frozen as agreed", () => {
  assert.equal(MAX_CORRECTIONS_PER_DECISION, 1);
  assert.equal(INVALID_SNAPSHOT_REF, "INVALID_SNAPSHOT_REF");
});
