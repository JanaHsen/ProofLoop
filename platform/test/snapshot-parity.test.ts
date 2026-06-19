/**
 * Phase 5 Task 4 — frozen snapshot-parity normalizer + negative-guard suite.
 *
 * The negative guards are the teeth: with an EMPTY dropped-field allow-list the positive
 * corpus normalizes trivially (Task 2 found byte-identical headed/headless), so these
 * prove the oracle still FAILS on real behavioral flips — accessible name, disabled,
 * value, checked, selected, role, element add/remove, ordering, active, cursor, ref, and
 * unknown/typed fields. No mode differences are invented; field-level guards mutate one
 * field of a constructed model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  PARITY_DROPPED_FIELDS,
  ParityNode,
  compareSnapshotParity,
  compareSnapshotYaml,
  parseCanonicalSnapshot,
} from "../src/parity/snapshot-parity";

const FIX = path.join(__dirname, "fixtures", "parity");
const FORM_YAML = fs.readFileSync(path.join(FIX, "form.snapshot.yaml"), "utf8");
const LOGIN_YAML = fs.readFileSync(path.join(FIX, "login.snapshot.yaml"), "utf8");

function node(role: string, opts: Partial<ParityNode> = {}): ParityNode {
  return { role, attributes: {}, children: [], ...opts };
}

/** A guard helper: compare, assert NOT equal, and return the single difference. */
function onlyDiff(left: ParityNode, right: ParityNode) {
  const r = compareSnapshotParity(left, right);
  assert.equal(r.equal, false, "must detect the change");
  assert.equal(r.differences.length, 1, "exactly one difference expected");
  return r.differences[0];
}

// --- 16 negative guards: every case ⇒ equal:false with a structured diff at the path ---

test("guard 1: accessible name changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("button", { name: "Sign in", attributes: { ref: "e8" } }),
    node("button", { name: "Log in", attributes: { ref: "e8" } }),
  );
  assert.deepEqual(d, { path: "name", left: "Sign in", right: "Log in", kind: "changed" });
});

test("guard 2: disabled false → true ⇒ mismatch", () => {
  const d = onlyDiff(
    node("button", { attributes: { disabled: false } }),
    node("button", { attributes: { disabled: true } }),
  );
  assert.deepEqual(d, { path: "attributes.disabled", left: false, right: true, kind: "changed" });
});

test("guard 3: value changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("strong", { attributes: { ref: "e43" }, value: "$64.87" }),
    node("strong", { attributes: { ref: "e43" }, value: "$0.00" }),
  );
  assert.deepEqual(d, { path: "value", left: "$64.87", right: "$0.00", kind: "changed" });
});

test("guard 4: checked state changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("checkbox", { attributes: { checked: true } }),
    node("checkbox", { attributes: { checked: false } }),
  );
  assert.deepEqual(d, { path: "attributes.checked", left: true, right: false, kind: "changed" });
});

test("guard 5: selected state changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("option", { attributes: { selected: true } }),
    node("option", { attributes: { selected: false } }),
  );
  assert.deepEqual(d, { path: "attributes.selected", left: true, right: false, kind: "changed" });
});

test("guard 6: role changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("button", { name: "Go", attributes: { ref: "e8" } }),
    node("link", { name: "Go", attributes: { ref: "e8" } }),
  );
  assert.deepEqual(d, { path: "role", left: "button", right: "link", kind: "changed" });
});

test("guard 7: meaningful element removed ⇒ mismatch", () => {
  const left = node("generic", { children: [node("button", { name: "A" }), node("button", { name: "B" })] });
  const right = node("generic", { children: [node("button", { name: "A" })] });
  const d = onlyDiff(left, right);
  assert.equal(d.kind, "removed");
  assert.equal(d.path, "children[1]");
});

test("guard 8: meaningful element added ⇒ mismatch", () => {
  const left = node("generic", { children: [node("button", { name: "A" })] });
  const right = node("generic", { children: [node("button", { name: "A" }), node("button", { name: "B" })] });
  const d = onlyDiff(left, right);
  assert.equal(d.kind, "added");
  assert.equal(d.path, "children[1]");
});

test("guard 9: element ordering changed ⇒ mismatch", () => {
  const left = node("generic", { children: [node("button", { name: "A" }), node("link", { name: "B" })] });
  const right = node("generic", { children: [node("link", { name: "B" }), node("button", { name: "A" })] });
  const r = compareSnapshotParity(left, right);
  assert.equal(r.equal, false);
  // both positions changed (role + name swapped) — ordering is significant, never collapsed.
  assert.ok(r.differences.some((d) => d.path.startsWith("children[0]")));
  assert.ok(r.differences.some((d) => d.path.startsWith("children[1]")));
});

test("guard 10: active state changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("generic", { attributes: { active: true, ref: "e1" } }),
    node("generic", { attributes: { active: false, ref: "e1" } }),
  );
  assert.deepEqual(d, { path: "attributes.active", left: true, right: false, kind: "changed" });
});

test("guard 11: cursor information changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("link", { name: "Go", attributes: { ref: "e3", cursor: "pointer" } }),
    node("link", { name: "Go", attributes: { ref: "e3", cursor: "default" } }),
  );
  assert.deepEqual(d, { path: "attributes.cursor", left: "pointer", right: "default", kind: "changed" });
});

test("guard 12: ref changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("textbox", { name: "Username", attributes: { ref: "e5" } }),
    node("textbox", { name: "Username", attributes: { ref: "e6" } }),
  );
  assert.deepEqual(d, { path: "attributes.ref", left: "e5", right: "e6", kind: "changed" });
});

test("guard 13: unknown field added ⇒ mismatch (not silently dropped)", () => {
  const d = onlyDiff(
    node("button", { attributes: { ref: "e1" } }),
    node("button", { attributes: { ref: "e1", mysteryFlag: true } }),
  );
  assert.deepEqual(d, { path: "attributes.mysteryFlag", left: undefined, right: true, kind: "added" });
});

test("guard 14: unknown field removed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("button", { attributes: { ref: "e1", mysteryFlag: true } }),
    node("button", { attributes: { ref: "e1" } }),
  );
  assert.deepEqual(d, { path: "attributes.mysteryFlag", left: true, right: undefined, kind: "removed" });
});

test("guard 15: unknown field value changed ⇒ mismatch", () => {
  const d = onlyDiff(
    node("x", { attributes: { mystery: "a" } }),
    node("x", { attributes: { mystery: "b" } }),
  );
  assert.deepEqual(d, { path: "attributes.mystery", left: "a", right: "b", kind: "changed" });
});

test("guard 16: scalar type changed (\"false\" → false) ⇒ type_changed", () => {
  const d = onlyDiff(
    node("x", { attributes: { flag: "false" } }),
    node("x", { attributes: { flag: false } }),
  );
  assert.deepEqual(d, { path: "attributes.flag", left: "false", right: false, kind: "type_changed" });
});

// --- positive tests -----------------------------------------------------------------

test("positive: identical scrubbed canonical snapshots compare equal", () => {
  // Provenance: platform/test/investigation/FINDINGS.md — Task 2 observed byte-identical
  // headed/headless captures at /form, so a re-parse of the committed sample is the
  // faithful stand-in for the cross-mode pair.
  const r = compareSnapshotYaml(FORM_YAML, FORM_YAML, { left: "headed", right: "headless" });
  assert.equal(r.equal, true);
  assert.deepEqual(r.differences, []);
  assert.deepEqual(r.labels, { left: "headed", right: "headless" });
});

test("positive: the committed /login Task 2 sample compares equal across modes", () => {
  const r = compareSnapshotYaml(LOGIN_YAML, LOGIN_YAML, { left: "headed", right: "headless" });
  assert.equal(r.equal, true);
  assert.deepEqual(r.differences, []);
});

test("positive: independently constructed structurally identical values compare equal", () => {
  const build = (): ParityNode =>
    node("generic", {
      attributes: { active: true, ref: "e1" },
      children: [
        node("textbox", { name: "Username", attributes: { ref: "e13" } }),
        node("button", { name: "Log in", attributes: { ref: "e16", cursor: "pointer" } }),
      ],
    });
  const r = compareSnapshotParity(build(), build());
  assert.equal(r.equal, true);
  assert.deepEqual(r.differences, []);
});

test("positive: comparison is deterministic — byte-identical serialized result on repeat", () => {
  // a genuine MISMATCH pair (form vs login) so the difference ORDER is also exercised.
  const once = JSON.stringify(compareSnapshotYaml(FORM_YAML, LOGIN_YAML));
  const twice = JSON.stringify(compareSnapshotYaml(FORM_YAML, LOGIN_YAML));
  assert.equal(once, twice);
  assert.notEqual(JSON.parse(once).differences.length, 0);
});

test("positive: the frozen dropped-field allow-list is empty and immutable", () => {
  assert.equal(PARITY_DROPPED_FIELDS.length, 0);
  assert.ok(Object.isFrozen(PARITY_DROPPED_FIELDS));
});

test("positive: normalizeForProgress is neither imported nor reused", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "parity", "snapshot-parity.ts"),
    "utf8",
  );
  // ignore the one prose mention that explains the non-reuse, by stripping block comments
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");
  assert.ok(!/normalizeForProgress|progressKey/.test(code), "must not call the Phase 2 fingerprint");
  assert.ok(!/engine\/guards/.test(code), "must not import engine/guards");
});

// --- parser is field-aware and lossless (preserves the full surface, unknown included) ---

test("parser: preserves role/name/ref/active/cursor/value across the canonical tree", () => {
  const root = parseCanonicalSnapshot(FORM_YAML);
  const top = root.children[0];
  assert.equal(top.role, "generic");
  assert.equal(top.attributes.active, true);
  assert.equal(top.attributes.ref, "e1");

  // banner > link "ProofLoop SUT" carries a cursor and a /url child with a value
  const homeLink = top.children[0].children[0];
  assert.equal(homeLink.role, "link");
  assert.equal(homeLink.name, "ProofLoop SUT");
  assert.equal(homeLink.attributes.cursor, "pointer");
  assert.equal(homeLink.children[0].role, "/url");
  assert.equal(homeLink.children[0].value, "/");

  // heading keeps its level attribute and accessible name
  const heading = top.children[1].children[0];
  assert.equal(heading.role, "heading");
  assert.equal(heading.name, "Submit a request");
  assert.equal(heading.attributes.level, "1");
});

test("parser: captures unknown brackets and bare flags generically (nothing hidden)", () => {
  const root = parseCanonicalSnapshot('- widget "X" [ref=e1] [mystery=foo] [checked] [disabled]');
  const n = root.children[0];
  assert.equal(n.role, "widget");
  assert.equal(n.name, "X");
  assert.equal(n.attributes.ref, "e1");
  assert.equal(n.attributes.mystery, "foo"); // unknown key=value preserved
  assert.equal(n.attributes.checked, true); // bare flag → boolean true
  assert.equal(n.attributes.disabled, true);
});

test("parser: an inline value with a colon-space is captured as the node value", () => {
  const root = parseCanonicalSnapshot("- code [ref=e18]: alice / ***********");
  const n = root.children[0];
  assert.equal(n.role, "code");
  assert.equal(n.attributes.ref, "e18");
  assert.equal(n.value, "alice / ***********");
});

test("parser: a non-list line is retained as a #raw node, never silently dropped", () => {
  const root = parseCanonicalSnapshot("- generic [ref=e1]:\n  unexpected stray line");
  const stray = root.children[0].children[0];
  assert.equal(stray.role, "#raw");
  assert.equal(stray.extra, "unexpected stray line");
});

// --- closed raw-source fallback: any byte difference ⇒ equal:false ------------------

/** Assert the parsed models agree yet the YAML comparison fails via the raw-source fallback. */
function caughtOnlyByRaw(left: string, right: string) {
  const modelsEqual = compareSnapshotParity(
    parseCanonicalSnapshot(left),
    parseCanonicalSnapshot(right),
  ).equal;
  assert.equal(modelsEqual, true, "parsed models must be equal (so the raw fallback is what catches it)");
  const r = compareSnapshotYaml(left, right);
  assert.equal(r.equal, false, "a raw byte difference must yield equal:false");
  assert.ok(r.differences.length > 0 && r.differences.every((d) => d.path.startsWith("$raw")));
  return r;
}

test("raw 1: spacing change with equivalent parsed fields ⇒ mismatch", () => {
  caughtOnlyByRaw('- button "Go" [ref=e1]', '- button  "Go"  [ref=e1]');
});

test("raw 2: a blank line added ⇒ mismatch", () => {
  const r = caughtOnlyByRaw(
    "- generic [ref=e1]:\n  - text: Hi",
    "- generic [ref=e1]:\n\n  - text: Hi",
  );
  assert.ok(r.differences.some((d) => d.path.startsWith("$raw.lines[")));
});

test("raw 3: differently escaped source for the same parsed text ⇒ mismatch", () => {
  // YAML `"a\\b"` and `"a\b"` both parse to the name `a\b`, but the bytes differ.
  caughtOnlyByRaw('- t "a\\\\b" [ref=e1]', '- t "a\\b" [ref=e1]');
});

test("raw 4: an otherwise-unrepresented raw line change (trailing whitespace) ⇒ mismatch", () => {
  caughtOnlyByRaw('- button "Go" [ref=e1]', '- button "Go" [ref=e1]   ');
});

test("raw 5: duplicate bracket syntax collapsed by Record ⇒ mismatch", () => {
  // both collapse to {dup:"2", ref:"e1"}; the dropped `[dup=1]` must not vanish silently.
  caughtOnlyByRaw("- x [dup=1] [dup=2] [ref=e1]", "- x [dup=2] [ref=e1]");
});

test("raw 6: two byte-identical YAML strings compare equal", () => {
  const yaml = '- generic [active] [ref=e1]:\n  - button "Go" [ref=e8] [cursor=pointer]';
  const r = compareSnapshotYaml(yaml, yaml);
  assert.equal(r.equal, true);
  assert.deepEqual(r.differences, []);
});

test("raw 7: repeated raw-difference comparison serializes byte-identically", () => {
  const a = '- button "Go" [ref=e1]';
  const b = '- button  "Go" [ref=e1]';
  const once = JSON.stringify(compareSnapshotYaml(a, b));
  const twice = JSON.stringify(compareSnapshotYaml(a, b));
  assert.equal(once, twice);
  assert.equal(JSON.parse(once).equal, false);
});

test("raw 8: the Task 2 /login and /form fixtures remain equal under the fallback", () => {
  assert.equal(compareSnapshotYaml(LOGIN_YAML, LOGIN_YAML).equal, true);
  assert.equal(compareSnapshotYaml(FORM_YAML, FORM_YAML).equal, true);
});

test("raw fallback is suppressed when the models already differ (no duplicate noise)", () => {
  // a real semantic change (name) ⇒ structured diff only; no $raw lines appended.
  const a = '- button "Go" [ref=e1]';
  const b = '- button "Stop" [ref=e1]';
  const r = compareSnapshotYaml(a, b);
  assert.equal(r.equal, false);
  assert.ok(r.differences.some((d) => d.path.endsWith("name")));
  assert.ok(!r.differences.some((d) => d.path.startsWith("$raw")), "no raw noise when a field diff explains it");
});
