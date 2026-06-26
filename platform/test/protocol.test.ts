import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DECISION_TOOL_SCHEMA,
  DECISION_TOOL_STRICT,
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
//
// The tool input wraps the chosen variant under a single `decision` property (the
// provider-enforced discriminated union); parseDecision unwraps it then re-validates
// every field. `wrap` mirrors that envelope so each case documents the real contract.

const wrap = (decision: unknown) => ({ decision });

// helper to read the anyOf branches out of either the base or a built schema
const branchesOf = (schema: unknown): Array<Record<string, any>> =>
  (((schema as any).properties.decision.anyOf) as Array<Record<string, any>>);

test("parseDecision: valid click action", () => {
  const r = parseDecision(wrap({ kind: "action", action: "click", ref: "e8", rationale: "submit" }));
  assert.ok(r.ok && r.decision.kind === "action" && r.decision.action === "click");
});

test("parseDecision: valid type action carries the value", () => {
  const ok = parseDecision(wrap({ kind: "action", action: "type", ref: "e5", value: "alice", rationale: "fill" }));
  assert.ok(ok.ok && ok.decision.kind === "action" && ok.decision.value === "alice");
});

test("parseDecision: valid step_complete and blocked", () => {
  const sc = parseDecision(wrap({ kind: "step_complete", rationale: "done" }));
  assert.ok(sc.ok && sc.decision.kind === "step_complete");
  const bl = parseDecision(wrap({ kind: "blocked", reason: "no control" }));
  assert.ok(bl.ok && bl.decision.kind === "blocked");
});

test("parseDecision: type requires a value", () => {
  const bad = parseDecision(wrap({ kind: "action", action: "type", ref: "e5", rationale: "fill" }));
  assert.ok(!bad.ok && /value/.test(bad.error));
});

test("parseDecision: action requires ref and rationale", () => {
  assert.ok(!parseDecision(wrap({ kind: "action", action: "click", rationale: "x" })).ok); // missing ref
  assert.ok(!parseDecision(wrap({ kind: "action", action: "click", ref: "e8" })).ok); // missing rationale
});

test("parseDecision: action requires a supported verb", () => {
  assert.ok(!parseDecision(wrap({ kind: "action", ref: "e8", rationale: "x" })).ok); // no verb
  assert.ok(!parseDecision(wrap({ kind: "action", action: "hover", ref: "e8", rationale: "x" })).ok); // unsupported verb
});

test("parseDecision: valid navigate_to_observed_url (D48) keeps only the snapshot id", () => {
  const r = parseDecision(wrap({ kind: "navigate_to_observed_url", snapshotId: "snapshot-016", rationale: "revisit the order" }));
  assert.ok(r.ok && r.decision.kind === "navigate_to_observed_url");
  if (r.ok && r.decision.kind === "navigate_to_observed_url") {
    assert.equal(r.decision.snapshotId, "snapshot-016");
  }
});

test("parseDecision: navigate_to_observed_url requires a snapshotId and a rationale", () => {
  assert.ok(!parseDecision(wrap({ kind: "navigate_to_observed_url", rationale: "x" })).ok); // missing snapshotId
  assert.ok(!parseDecision(wrap({ kind: "navigate_to_observed_url", snapshotId: "snapshot-016" })).ok); // missing rationale
  assert.ok(!parseDecision(wrap({ kind: "navigate_to_observed_url", snapshotId: "", rationale: "x" })).ok); // empty id
});

test("parseDecision: a model-supplied URL on navigate_to_observed_url is never read (only the snapshot id is)", () => {
  const r = parseDecision(
    wrap({ kind: "navigate_to_observed_url", snapshotId: "snapshot-016", rationale: "x", url: "http://evil.example/pwn" } as Record<string, unknown>),
  );
  assert.ok(r.ok && r.decision.kind === "navigate_to_observed_url");
  // the parsed decision carries no url field at all — there is no path for model URL text
  assert.ok(!("url" in (r as any).decision));
});

test("parseDecision: a bare navigate-with-url decision (no snapshot id) is rejected as an unknown kind", () => {
  assert.ok(!parseDecision(wrap({ kind: "navigate", url: "http://evil.example" })).ok);
});

test("parseDecision: step_complete needs rationale, blocked needs reason", () => {
  assert.ok(!parseDecision(wrap({ kind: "step_complete" })).ok);
  assert.ok(!parseDecision(wrap({ kind: "blocked" })).ok);
});

test("parseDecision: rejects unknown kind, missing wrapper, and non-object", () => {
  assert.ok(!parseDecision(wrap({ kind: "navigate" })).ok);
  // an UNWRAPPED decision (no `decision` envelope) is rejected — it never validates as-is
  const unwrapped = parseDecision({ kind: "action", action: "click", ref: "e8", rationale: "x" });
  assert.ok(!unwrapped.ok && /decision/.test(unwrapped.error));
  // a wrapper whose decision is not an object is rejected
  assert.ok(!parseDecision({ decision: "nope" }).ok);
  assert.ok(!parseDecision({ decision: null }).ok);
  // non-object / null raw input is rejected before unwrapping
  assert.ok(!parseDecision("nope").ok);
  assert.ok(!parseDecision(null).ok);
});

test("buildDecisionToolSchema: steers ref to the snapshot's refs in the action branches", () => {
  const refBranches = branchesOf(buildDecisionToolSchema(SNAP.refs)).filter((b) => b.properties.ref);
  // both action branches (click, type) carry a ref and receive the enum
  assert.equal(refBranches.length, 2);
  for (const b of refBranches) {
    assert.deepEqual([...(b.properties.ref.enum as string[])].sort(), [...SNAP.refs].sort());
  }
  // base schema is untouched (no enum) — steering is per-call only
  for (const b of branchesOf(DECISION_TOOL_SCHEMA)) {
    if (b.properties.ref) assert.equal(b.properties.ref.enum, undefined);
  }
  // empty refs => no enum injected
  for (const b of branchesOf(buildDecisionToolSchema([]))) {
    if (b.properties.ref) assert.equal(b.properties.ref.enum, undefined);
  }
});

test("DECISION_TOOL_SCHEMA: plain-object top level wrapping a 5-branch decision union", () => {
  // top level must NOT use anyOf/oneOf/allOf — Anthropic rejects those at the top level
  assert.equal((DECISION_TOOL_SCHEMA as any).type, "object");
  assert.equal((DECISION_TOOL_SCHEMA as any).additionalProperties, false);
  assert.deepEqual([...(DECISION_TOOL_SCHEMA as any).required], ["decision"]);
  assert.ok(!("anyOf" in DECISION_TOOL_SCHEMA));
  assert.ok(!("oneOf" in DECISION_TOOL_SCHEMA));
  assert.ok(!("allOf" in DECISION_TOOL_SCHEMA));
  const branches = branchesOf(DECISION_TOOL_SCHEMA);
  assert.equal(branches.length, 5); // click, type, step_complete, blocked, navigate_to_observed_url (D48)
  // every branch is a closed object with a const kind discriminator and complete required
  for (const b of branches) {
    assert.equal(b.type, "object");
    assert.equal(b.additionalProperties, false);
    assert.equal(typeof b.properties.kind.const, "string");
    for (const key of b.required as string[]) assert.ok(key in b.properties);
  }
  // exactly the five supported variants are present
  const variantKeys = branches
    .map((b) => (b.properties.action ? `action:${b.properties.action.const}` : `${b.properties.kind.const}`))
    .sort();
  assert.deepEqual(variantKeys, [
    "action:click",
    "action:type",
    "blocked",
    "navigate_to_observed_url",
    "step_complete",
  ]);
  assert.equal(DECISION_TOOL_STRICT, true);
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
