/**
 * Citation-surface correction — offline regression over the clean Phase 6 dispatch (CI run
 * 27985544723). NO model call: everything runs through the REAL finalization path
 * (`validateSnapshotObservation` / `finalizeCriterion`) against sanitized, verbatim snapshots.
 *
 * Proves the three added SAME-REF surfaces (canonical decorated line; anonymous text inside an
 * approved semantic container; page title/URL on the page/root node) validate the diagnosed
 * citations, while the invalid-citation guard and every genuine mis-citation stay invalid.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  matchesCanonicalLine,
  observedTextPresentAtRef,
  pageRootRef,
  parseCanonicalLine,
  subtreeAnonymousText,
  validateSnapshotObservation,
} from "../src/verify/citation";
import { finalizeCriterion } from "../src/verify/verifier";
import type { EvidenceWindow, ProvidedSnapshot } from "../src/verify/resolver";

// ── fixture ──────────────────────────────────────────────────────────────────────────────────

interface FixtureObs { label: string; observedText: string; snapshotId: string; ref: string }
interface FixtureCase { window: ProvidedSnapshot[]; observations: FixtureObs[] }
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "citation", "clean-run-27985544723.json"), "utf8"),
) as { provenance: unknown; cases: Record<string, FixtureCase> };

function windowFor(key: string): EvidenceWindow {
  return { windowKind: "terminal", snapshots: FIXTURE.cases[key].window, events: [] };
}
function snapOf(key: string, snapshotId: string): ProvidedSnapshot {
  const s = FIXTURE.cases[key].window.find((w) => w.snapshotId === snapshotId);
  assert.ok(s, `fixture ${key} missing snapshot ${snapshotId}`);
  return s!;
}
/** Find the recorded observation by cited ref (+ optional snapshotId). */
function obsAt(key: string, ref: string, snapshotId?: string): FixtureObs {
  const o = FIXTURE.cases[key].observations.find(
    (x) => x.ref === ref && (snapshotId === undefined || x.snapshotId === snapshotId),
  );
  assert.ok(o, `fixture ${key} has no observation at ref ${ref}`);
  return o!;
}
function isValid(o: FixtureObs, win: EvidenceWindow): boolean {
  return validateSnapshotObservation(o, win).valid;
}
function replay(key: string, verdict: "PASS" | "FAIL" = "PASS") {
  return finalizeCriterion(
    { criterionId: key, criterionText: "(replay)", window: windowFor(key) },
    { verdict, observations: FIXTURE.cases[key].observations, reasoning: "offline replay" },
    1,
  );
}

// ── §6 positive: the seven supported same-ref surfaces (real data) ─────────────────────────────

test("surface 1 — canonical decorated BUTTON line validates at its own ref", () => {
  const win = windowFor("checkout-mobile:C1");
  const o = obsAt("checkout-mobile:C1", "e47", "snapshot-015"); // `button "Place Order" [ref=e47] [cursor=pointer]`
  assert.ok(isValid(o, win));
});

test("surface 2 — canonical decorated HEADING line validates at its own ref", () => {
  const win = windowFor("checkout-mobile:C1");
  const o = obsAt("checkout-mobile:C1", "e13", "snapshot-018"); // `heading "Order placed" [level=1] [ref=e13]`
  assert.ok(isValid(o, win));
});

test("surface 3 — canonical decorated TEXTBOX name/value line validates at its own ref", () => {
  const win = windowFor("form:C2");
  for (const ref of ["e17", "e13", "e15"]) assert.ok(isValid(obsAt("form:C2", ref), win), `textbox line @ ${ref}`);
});

test("surface 4 — anonymous PARAGRAPH text validates against the paragraph ref", () => {
  const win = windowFor("checkout:C1");
  assert.ok(isValid(obsAt("checkout:C1", "e14"), win)); // "has been recorded." inside paragraph e14
});

test("surface 5 — anonymous STATUS-region text validates against the status ref", () => {
  const win = windowFor("form:C1");
  // both anonymous fragments of the status region are cited to e11
  for (const o of FIXTURE.cases["form:C1"].observations.filter((x) => x.ref === "e11")) {
    assert.ok(isValid(o, win), `status text "${o.observedText}"`);
  }
});

test("surface 6 — explicit PAGE-TITLE metadata validates against the page/root ref", () => {
  const win = windowFor("checkout:C1");
  assert.ok(isValid(obsAt("checkout:C1", "e1"), win)); // "Order O-00001" == pageTitle, cited to root e1
});

test("surface 7 — explicit PAGE-URL metadata validates against the page/root ref", () => {
  // No recorded observation cited a bare URL; build an equivalent probe from real snapshot data.
  const win = windowFor("checkout:C1");
  const snap = snapOf("checkout:C1", "snapshot-016");
  const rootRef = pageRootRef(snap.yaml)!;
  const probe: FixtureObs = { label: "page url", observedText: snap.pageUrl!, snapshotId: snap.snapshotId, ref: rootRef };
  assert.ok(isValid(probe, win), "bare page URL cited to the root ref validates");
});

// ── §6 per-criterion replay of the five affected criteria ──────────────────────────────────────

test("checkout:C1 — all citations now attributable → no INVALID_CITATION (clears to PASS)", () => {
  const win = windowFor("checkout:C1");
  assert.ok(FIXTURE.cases["checkout:C1"].observations.every((o) => isValid(o, win)), "every obs valid");
  assert.equal(replay("checkout:C1").verdict, "PASS");
});

test("form:C1 — status-region anonymous text resolved → clears to PASS", () => {
  const win = windowFor("form:C1");
  assert.ok(FIXTURE.cases["form:C1"].observations.every((o) => isValid(o, win)));
  assert.equal(replay("form:C1").verdict, "PASS");
});

test("form:C2 — canonical decorated textbox lines resolved → clears to PASS", () => {
  const win = windowFor("form:C2");
  assert.ok(FIXTURE.cases["form:C2"].observations.every((o) => isValid(o, win)));
  assert.equal(replay("form:C2").verdict, "PASS");
});

test("checkout-mobile:C1 — diagnosed surfaces resolve; a genuine non-canonical page pseudo-line stays invalid", () => {
  const win = windowFor("checkout-mobile:C1");
  // The diagnosed-surface citations now validate:
  assert.ok(isValid(obsAt("checkout-mobile:C1", "e47", "snapshot-015"), win), "button line");
  assert.ok(isValid(obsAt("checkout-mobile:C1", "e13", "snapshot-018"), win), "heading line");
  assert.ok(isValid(obsAt("checkout-mobile:C1", "e14", "snapshot-018"), win), "paragraph text");
  // The lone residual invalid is the model-invented `page "…", url …` pseudo-line cited to root —
  // arbitrary prose, NOT a diagnosed surface; the guard correctly keeps it invalid.
  const e1 = obsAt("checkout-mobile:C1", "e1", "snapshot-018");
  assert.ok(!isValid(e1, win), "non-canonical page pseudo-line remains invalid");
  const res = replay("checkout-mobile:C1");
  assert.equal(res.verdict, "INCONCLUSIVE");
  assert.equal((res.inconclusiveDetail as any)?.code, "INVALID_CITATION");
  // exactly one invalid citation remains
  assert.equal(res.citationValidations.filter((v) => !v.valid).length, 1);
});

test("checkout:C3 — lone invalid is a genuine SIBLING mis-citation; correctly stays INVALID_CITATION", () => {
  const win = windowFor("checkout:C3");
  // "has been recorded." was cited to e15 (a <strong> sibling), not the paragraph that owns it.
  const e15 = obsAt("checkout:C3", "e15");
  assert.ok(!isValid(e15, win), "sibling mis-citation stays invalid");
  // The same text cited to the OWNING paragraph (e14) would validate — proving the surface works
  // and the failure is the wrong ref, not the surface:
  const corrected: FixtureObs = { ...e15, ref: "e14" };
  assert.ok(isValid(corrected, win), "same text cited to the owning paragraph e14 validates");
  const res = replay("checkout:C3");
  assert.equal(res.verdict, "INCONCLUSIVE");
  assert.equal((res.inconclusiveDetail as any)?.code, "INVALID_CITATION");
  assert.equal(res.citationValidations.filter((v) => !v.valid).length, 1);
});

// ── §7 negative tests — these MUST remain invalid ──────────────────────────────────────────────

test("negative — decorated line whose embedded ref differs from the cited ref", () => {
  const win = windowFor("checkout-mobile:C1");
  const line = obsAt("checkout-mobile:C1", "e47", "snapshot-015").observedText; // embeds [ref=e47]
  const o: FixtureObs = { label: "x", observedText: line, snapshotId: "snapshot-015", ref: "e13" }; // cited e13
  assert.ok(!isValid(o, win));
});

test("negative — correct text found only in a sibling subtree", () => {
  // (the real checkout:C3 e15 case) — covered above; also assert directly here
  const win = windowFor("checkout:C3");
  assert.ok(!isValid(obsAt("checkout:C3", "e15"), win));
});

test("negative — correct text elsewhere on the page but outside the cited subtree", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "Continue shopping", snapshotId: "snapshot-016", ref: "e14" };
  assert.ok(!isValid(o, win)); // "Continue shopping" is link e47 under paragraph e46, not under e14
});

test("negative — anonymous text cited to a non-ancestor ref", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "has been recorded.", snapshotId: "snapshot-016", ref: "e13" };
  assert.ok(!isValid(o, win)); // e13 is the heading, not the paragraph that owns the text
});

test("negative — arbitrary document text cited to the page/root ref", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "Desk Lamp", snapshotId: "snapshot-016", ref: "e1" };
  assert.ok(!isValid(o, win)); // not the title or URL
});

test("negative — page title cited to a non-page ref", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "Order O-00001", snapshotId: "snapshot-016", ref: "e13" };
  assert.ok(!isValid(o, win)); // title only attributable to the page/root ref
});

test("negative — decoration-only content without matching visible name", () => {
  const win = windowFor("checkout-mobile:C1");
  const o: FixtureObs = { label: "x", observedText: 'button "Ghost Button" [ref=e47] [cursor=pointer]', snapshotId: "snapshot-015", ref: "e47" };
  assert.ok(!isValid(o, win)); // parsed name != canonical "Place Order"
});

test("negative — altered accessible name in a canonical line", () => {
  const win = windowFor("checkout-mobile:C1");
  const o: FixtureObs = { label: "x", observedText: 'heading "Order shipped" [level=1] [ref=e13]', snapshotId: "snapshot-018", ref: "e13" };
  assert.ok(!isValid(o, win));
});

test("negative — altered inline value in a canonical line", () => {
  const win = windowFor("form:C2");
  const o: FixtureObs = { label: "x", observedText: 'textbox "Email" [ref=e15]: evil@example.com', snapshotId: "snapshot-012", ref: "e15" };
  assert.ok(!isValid(o, win)); // canonical value is jana@example.com
});

test("negative — malformed decorated syntax", () => {
  const win = windowFor("checkout-mobile:C1");
  const o: FixtureObs = { label: "x", observedText: 'button "Place Order [ref=e47]', snapshotId: "snapshot-015", ref: "e47" };
  assert.ok(!isValid(o, win)); // unterminated quote → not a canonical line
});

test("negative — missing ref (not in snapshot)", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "anything", snapshotId: "snapshot-016", ref: "e999" };
  const v = validateSnapshotObservation(o, win);
  assert.equal(v.refPresent, false);
  assert.equal(v.valid, false);
});

test("negative — snapshot not provided", () => {
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "Order placed", snapshotId: "snapshot-999", ref: "e13" };
  const v = validateSnapshotObservation(o, win);
  assert.equal(v.snapshotProvided, false);
  assert.equal(v.valid, false);
});

test("negative — digest mismatch (tampered yaml) keeps the citation invalid", () => {
  const snap = snapOf("checkout:C1", "snapshot-016");
  const tampered: ProvidedSnapshot = { ...snap, yaml: snap.yaml + "\n  - text: injected" }; // digest no longer matches
  const win: EvidenceWindow = { windowKind: "terminal", snapshots: [tampered], events: [] };
  const o: FixtureObs = { label: "x", observedText: "Order placed", snapshotId: "snapshot-016", ref: "e13" };
  const v = validateSnapshotObservation(o, win);
  assert.equal(v.digestMatches, false);
  assert.equal(v.valid, false);
});

test("negative — existing cross-ref citation (value present at another ref) stays invalid", () => {
  const win = windowFor("checkout:C1");
  // "$49.98" is cell e28; citing it to e26 ("$24.99") must remain invalid (unchanged behavior).
  const o: FixtureObs = { label: "x", observedText: "$49.98", snapshotId: "snapshot-016", ref: "e26" };
  assert.ok(!isValid(o, win));
});

test("negative — arbitrary prose containing a [ref=…] token is NOT accepted", () => {
  assert.equal(parseCanonicalLine("the order was placed, see [ref=e13] for details"), null);
  const win = windowFor("checkout:C1");
  const o: FixtureObs = { label: "x", observedText: "the order was placed, see [ref=e13] for details", snapshotId: "snapshot-016", ref: "e13" };
  assert.ok(!isValid(o, win));
});

// ── parser / helper unit tests ─────────────────────────────────────────────────────────────────

test("parseCanonicalLine extracts role/name/ref/value and rejects non-lines", () => {
  assert.deepEqual(parseCanonicalLine('button "Place Order" [ref=e47] [cursor=pointer]'), {
    role: "button", name: "Place Order", ref: "e47",
  });
  assert.deepEqual(parseCanonicalLine('textbox "Email" [ref=e15]: jana@example.com'), {
    role: "textbox", name: "Email", ref: "e15", value: "jana@example.com",
  });
  assert.deepEqual(parseCanonicalLine('heading "Order placed" [level=1] [ref=e13]'), {
    role: "heading", name: "Order placed", ref: "e13",
  });
  assert.equal(parseCanonicalLine("just some prose"), null);
  assert.equal(parseCanonicalLine("Order O-00001"), null); // bare value, no ref → not a citable line
});

test("subtreeAnonymousText collects only the cited ref's own anonymous text", () => {
  const snap = snapOf("checkout:C1", "snapshot-016");
  const para = subtreeAnonymousText(snap.yaml, "e14");
  assert.ok(para && para.includes("Thank you. Your order") && para.includes("has been recorded."));
  assert.ok(!para!.includes("O-00001"), "the <strong> child's text is owned by e15, not folded in");
  assert.equal(subtreeAnonymousText(snap.yaml, "e13"), undefined, "a leaf heading has no anonymous descendant text");
});

test("matchesCanonicalLine is bound to the exact cited ref", () => {
  const snap = snapOf("checkout-mobile:C1", "snapshot-015");
  assert.ok(matchesCanonicalLine(snap, "e47", 'button "Place Order" [ref=e47] [cursor=pointer]'));
  assert.ok(!matchesCanonicalLine(snap, "e13", 'button "Place Order" [ref=e47] [cursor=pointer]'));
});

test("observedTextPresentAtRef still accepts the plain base surface (unchanged)", () => {
  const snap = snapOf("checkout:C1", "snapshot-016");
  assert.ok(observedTextPresentAtRef(snap, "e13", "Order placed")); // accessible name
  assert.ok(observedTextPresentAtRef(snap, "e44", "$64.87")); // cell name containment
  assert.ok(!observedTextPresentAtRef(snap, "e13", "Order shipped"));
});
