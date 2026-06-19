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

test("parseDecision: kind=action without an action verb is rejected", () => {
  // The incident shape: kind:"action" with no `action` field. The old flat schema
  // accepted this at the provider layer (only `kind` was required); parseDecision is the
  // backstop that still refuses it.
  const r = parseDecision({ kind: "action", ref: "e8", rationale: "add to bag" });
  assert.ok(!r.ok && /action to be "click" or "type"/.test(r.error));
});

test("parseDecision: an unsupported action verb is rejected", () => {
  // e.g. trying to drive the Qty spinbutton with a verb the actuator does not support.
  const r = parseDecision({ kind: "action", action: "select", ref: "e34", value: "2", rationale: "set qty" });
  assert.ok(!r.ok && /action to be "click" or "type"/.test(r.error));
});

test("parseDecision: type without ref is rejected", () => {
  const r = parseDecision({ kind: "action", action: "type", value: "alice", rationale: "fill" });
  assert.ok(!r.ok && /ref/.test(r.error));
});

test("parseDecision: step_complete needs rationale, blocked needs reason", () => {
  assert.ok(parseDecision({ kind: "step_complete", rationale: "done" }).ok);
  assert.ok(!parseDecision({ kind: "step_complete" }).ok);
  assert.ok(parseDecision({ kind: "blocked", reason: "no control" }).ok);
  assert.ok(!parseDecision({ kind: "blocked" }).ok);
});

test("parseDecision: each valid variant parses", () => {
  assert.ok(parseDecision({ kind: "action", action: "click", ref: "e8", rationale: "add" }).ok);
  assert.ok(parseDecision({ kind: "action", action: "type", ref: "e5", value: "alice", rationale: "fill" }).ok);
  assert.ok(parseDecision({ kind: "step_complete", rationale: "responded" }).ok);
  assert.ok(parseDecision({ kind: "blocked", reason: "no control" }).ok);
});

test("parseDecision: rejects unknown kind / non-object", () => {
  assert.ok(!parseDecision({ kind: "navigate" }).ok);
  assert.ok(!parseDecision("nope").ok);
  assert.ok(!parseDecision(null).ok);
});

// --- the provider-visible discriminated contract ----------------------------------
//
// The model-facing schema is a `oneOf` of four COMPLETE branches. Unlike the old flat
// object (which required only `kind`), each branch makes its own fields required, so a
// kind=action with a missing/unsupported verb satisfies no branch at the provider layer.
// parseDecision (above) is the authoritative backstop; this proves the contract shape.

function branches(schema: { oneOf?: unknown }): Array<{
  properties: Record<string, { enum?: unknown }>;
  required: string[];
}> {
  return (schema.oneOf as Array<{
    properties: Record<string, { enum?: unknown }>;
    required: string[];
  }>);
}

test("DECISION_TOOL_SCHEMA: four complete discriminated branches", () => {
  const b = branches(DECISION_TOOL_SCHEMA as { oneOf: unknown });
  assert.equal(b.length, 4);
  const byDiscriminator = (kind: string, action?: string) =>
    b.find(
      (br) =>
        (br.properties.kind.enum as string[])[0] === kind &&
        (action === undefined ||
          (br.properties.action?.enum as string[] | undefined)?.[0] === action),
    )!;

  const click = byDiscriminator("action", "click");
  assert.deepEqual(click.required, ["kind", "action", "ref", "rationale"]);

  const type = byDiscriminator("action", "type");
  assert.deepEqual(type.required, ["kind", "action", "ref", "value", "rationale"]);

  const stepComplete = byDiscriminator("step_complete");
  assert.deepEqual(stepComplete.required, ["kind", "rationale"]);
  assert.ok(!("action" in stepComplete.properties) && !("ref" in stepComplete.properties));

  const blocked = byDiscriminator("blocked");
  assert.deepEqual(blocked.required, ["kind", "reason"]);
  assert.ok(!("action" in blocked.properties) && !("ref" in blocked.properties));
});

test("buildDecisionToolSchema: steers ref to the current snapshot's refs", () => {
  const schema = buildDecisionToolSchema(SNAP.refs);
  const refBearing = branches(schema).filter((br) => "ref" in br.properties);
  // exactly the two action branches carry a ref, and both are steered to the snapshot
  assert.equal(refBearing.length, 2);
  for (const br of refBearing) {
    assert.deepEqual([...(br.properties.ref.enum as string[])].sort(), [...SNAP.refs].sort());
  }
  // base schema is untouched (no enum) — steering is per-call only
  for (const br of branches(DECISION_TOOL_SCHEMA as { oneOf: unknown })) {
    if ("ref" in br.properties) assert.equal(br.properties.ref.enum, undefined);
  }
  // empty refs => no enum injected on any branch
  for (const br of branches(buildDecisionToolSchema([]))) {
    if ("ref" in br.properties) assert.equal(br.properties.ref.enum, undefined);
  }
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
