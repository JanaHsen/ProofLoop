import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseFlowFile, serializeFlowPlan, FlowParseError } from "../src/parser";

const FLOWS_DIR = path.resolve(__dirname, "../../fixtures/flows");
const GOLDEN_DIR = path.resolve(__dirname, "golden");
const NEG_DIR = path.resolve(__dirname, "fixtures");

const CANONICAL = ["login", "add-to-cart", "checkout", "checkout-mobile", "form"];

// --- Golden: each flow parses to its committed canonical plan (byte-for-byte). ---
for (const id of CANONICAL) {
  test(`golden: ${id} parses to its committed plan`, () => {
    const plan = parseFlowFile(path.join(FLOWS_DIR, `${id}.flow.md`));
    const got = serializeFlowPlan(plan);
    const want = fs.readFileSync(path.join(GOLDEN_DIR, `${id}.json`), "utf8");
    assert.equal(got, want);
  });
}

// --- Criteria-intact (the Done-when): verbatim text + after resolution. ---
test("criteria-intact: every criterion text is verbatim (minus a stripped after-suffix)", () => {
  for (const id of CANONICAL) {
    const file = path.join(FLOWS_DIR, `${id}.flow.md`);
    const rawCriteria = extractCriterionLines(fs.readFileSync(file, "utf8"));
    const plan = parseFlowFile(file);
    assert.equal(plan.criteria.length, rawCriteria.length, `${id}: criterion count`);
    plan.criteria.forEach((c, i) => {
      const raw = rawCriteria[i];
      const m = /^(.*\S)\s*\(after step \d+\)\s*$/.exec(raw);
      const expected = m ? m[1] : raw;
      assert.equal(c.text, expected, `${id} ${c.id}: verbatim text`);
    });
  }
});

test("criteria-intact: checkout persistence criterion is pinned to the revisit step", () => {
  const plan = parseFlowFile(path.join(FLOWS_DIR, "checkout.flow.md"));
  const c3 = plan.criteria.find((c) => c.id === "checkout:C3");
  assert.ok(c3, "checkout:C3 exists");
  assert.equal(c3!.after, "checkout:S4");
  assert.match(c3!.text, /still retrievable/);
  assert.ok(!/\(after step/.test(c3!.text), "after-suffix stripped from text");
});

// --- Determinism: re-parse identical (deep-equal AND identical serialized bytes). ---
test("determinism: re-parsing each flow yields an identical plan", () => {
  for (const id of CANONICAL) {
    const file = path.join(FLOWS_DIR, `${id}.flow.md`);
    const a = parseFlowFile(file);
    const b = parseFlowFile(file);
    assert.deepEqual(a, b, `${id}: deep-equal`);
    assert.equal(serializeFlowPlan(a), serializeFlowPlan(b), `${id}: identical bytes`);
  }
});

// --- Negative: each malformed throwaway fixture throws FlowParseError. ---
const NEGATIVES: Array<[string, RegExp]> = [
  ["no-criteria", /Acceptance Criteria/],
  ["bad-viewport", /viewport/],
  ["bad-after", /non-existent step/],
  ["unknown-key", /unknown front-matter key/],
];
for (const [id, re] of NEGATIVES) {
  test(`negative: ${id} throws FlowParseError`, () => {
    assert.throws(
      () => parseFlowFile(path.join(NEG_DIR, `${id}.flow.md`)),
      (e: unknown) => e instanceof FlowParseError && re.test((e as Error).message),
    );
  });
}

// Independently reconstruct the raw "- " criterion lines from a flow file, so the
// verbatim check compares against the source, not against the parser's own output.
function extractCriterionLines(src: string): string[] {
  const out: string[] = [];
  let inCriteria = false;
  for (const line of src.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inCriteria = heading[1] === "Acceptance Criteria";
      continue;
    }
    if (!inCriteria) continue;
    const item = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (item) out.push(item[1]);
  }
  return out;
}
