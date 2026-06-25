/**
 * Direct-anonymous-text citation surface (Mode D) — offline regression. NO model call, no browser,
 * no SUT, no network: everything runs through the REAL validation/finalization path
 * (`validateSnapshotObservation` / `finalizeCriterion`).
 *
 * The rule under test: anonymous ref-less text that is a DIRECT (depth-1) child of the exact cited
 * ref may be attributed to that ref, for ANY role. It is a general structural rule — not specific
 * to any application phrase, ref, role, or flow. The existing approved-container subtree surface
 * (paragraph/status/alert, any depth) and every invalid-citation guard are preserved unchanged.
 *
 * Positive proof uses the sanitized G3 fixture (PR #1 run 28182045591) where the verifier cited the
 * banner label "Signed in as" to its owning `generic` container; structural positive/negative cases
 * use small synthetic snapshots built inline with real digests, so they assert the STRUCTURE, not
 * any website value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  containerSubtreeTextPresent,
  citationTextSurface,
  directChildAnonymousText,
  directChildAnonymousTextPresent,
  observedTextPresentAtRef,
  subtreeAnonymousText,
  validateSnapshotObservation,
} from "../src/verify/citation";
import { finalizeCriterion } from "../src/verify/verifier";
import { digestSnapshot } from "../src/mcp/snapshot";
import type { EvidenceWindow, ProvidedSnapshot } from "../src/verify/resolver";

// ── synthetic snapshot builder (structural cases, no website data) ─────────────────────────────

interface El { ref: string; role: string; name?: string }
function snap(
  snapshotId: string,
  yaml: string,
  elements: El[],
  extra?: { pageUrl?: string; pageTitle?: string },
): ProvidedSnapshot {
  return {
    snapshotId,
    kind: "terminal",
    digest: digestSnapshot(yaml),
    yaml,
    refs: elements.map((e) => e.ref),
    elements,
    ...(extra?.pageUrl !== undefined ? { pageUrl: extra.pageUrl } : {}),
    ...(extra?.pageTitle !== undefined ? { pageTitle: extra.pageTitle } : {}),
  };
}
function win(s: ProvidedSnapshot): EvidenceWindow {
  return { windowKind: "terminal", snapshots: [s], events: [] };
}
function valid(s: ProvidedSnapshot, ref: string, observedText: string): boolean {
  return validateSnapshotObservation({ label: "x", observedText, snapshotId: s.snapshotId, ref }, win(s)).valid;
}

/**
 * A structural fixture exercising every branch of the rule. Roles are deliberately mixed; the only
 * thing that varies the outcome is OWNERSHIP and DEPTH, never the role's identity or the text value.
 *   e1 generic [root]  — has a direct `- text:` ("Top banner") that MUST stay invalid (root excluded)
 *     e2 navigation    — its only children are ref-bearing (e3, e6); no direct anonymous text
 *       e3 generic     — direct anon text "Signed in as" (+ ref child e4); the core Mode-D case
 *         e4 strong: "alice"   — inline value owned by e4
 *       e6 generic     — wraps a ref child e7 whose text is therefore DEPTH-2 relative to e6
 *         e7 generic   — direct anon text "deep value"
 *     e8 status        — approved container; anon text "Saved" (depth-1) and "just now"
 *     e10 paragraph    — approved container with DEPTH-2 anon text under a ref child e11
 *       e11 generic    — direct anon text "nested note"
 */
const YAML = [
  '- generic [active] [ref=e1]:',
  '  - text: Top banner',
  '  - navigation [ref=e2]:',
  '    - generic [ref=e3]:',
  '      - text: Signed in as',
  '      - strong [ref=e4]: alice',
  '    - generic [ref=e6]:',
  '      - generic [ref=e7]:',
  '        - text: deep value',
  '  - status [ref=e8]:',
  '    - text: Saved',
  '    - text: just now',
  '  - paragraph [ref=e10]:',
  '    - generic [ref=e11]:',
  '      - text: nested note',
].join('\n');

const S = snap(
  'syn-001',
  YAML,
  [
    { ref: 'e1', role: 'generic' },
    { ref: 'e2', role: 'navigation' },
    { ref: 'e3', role: 'generic' },
    { ref: 'e4', role: 'strong' },
    { ref: 'e6', role: 'generic' },
    { ref: 'e7', role: 'generic' },
    { ref: 'e8', role: 'status' },
    { ref: 'e10', role: 'paragraph' },
    { ref: 'e11', role: 'generic' },
  ],
  { pageUrl: 'http://localhost:3000/x', pageTitle: 'X' },
);

// ── positive: a direct anonymous child is attributable to its owning ref, regardless of role ───

test('positive — direct anonymous text under a generic container is valid at that exact ref', () => {
  assert.ok(valid(S, 'e3', 'Signed in as'));
  // and it is Mode D doing the work — neither the base surface nor the approved-container surface:
  assert.deepEqual(citationTextSurface(S, 'e3'), [], 'generic e3 has no name and no inline text');
  assert.equal(containerSubtreeTextPresent(S, 'e3', 'Signed in as'), false, 'generic is not an approved container');
  assert.equal(directChildAnonymousTextPresent(S, 'e3', 'Signed in as'), true, 'Mode D attributes it');
});

test('positive — a deeper generic still owns ITS OWN direct child', () => {
  assert.ok(valid(S, 'e7', 'deep value')); // e7 is a generic; "deep value" is its direct child
});

test('positive (preserved) — approved status container still validates its anonymous text', () => {
  assert.ok(valid(S, 'e8', 'Saved'));
  assert.ok(valid(S, 'e8', 'just now'));
});

test('positive (preserved) — approved paragraph still validates DEPTH-2 subtree text (Mode B)', () => {
  // "nested note" is depth-2 under paragraph e10; the approved-container subtree surface permits it.
  assert.ok(valid(S, 'e10', 'nested note'));
  assert.equal(directChildAnonymousTextPresent(S, 'e10', 'nested note'), false, 'not a DIRECT child of e10');
  assert.ok(subtreeAnonymousText(S.yaml, 'e10')?.includes('nested note'), 'but Mode B subtree covers it');
});

// ── negative: ownership/depth/scope guards MUST remain invalid ──────────────────────────────────

test('negative — text owned by a referenced child is NOT attributable to the parent (Mode D)', () => {
  // "alice" is the inline value of strong e4, a ref child of e3 — it belongs to e4, not e3.
  assert.equal(valid(S, 'e3', 'alice'), false);
  assert.ok(valid(S, 'e4', 'alice'), 'but alice IS valid at its own ref e4'); // control
});

test('negative — the same text cited to a SIBLING ref stays invalid', () => {
  // "Signed in as" cited to e4 (sibling strong) — e4 owns only "alice".
  assert.equal(valid(S, 'e4', 'Signed in as'), false);
});

test('negative — the same text cited to an ANCESTOR ref stays invalid', () => {
  // e2 (navigation) and e1 (root) are ancestors; neither directly owns "Signed in as".
  assert.equal(valid(S, 'e2', 'Signed in as'), false);
});

test('negative — anonymous text at DEPTH 2 under a non-approved (generic) parent stays invalid', () => {
  // "deep value" is depth-2 relative to generic e6 (under ref child e7); e6 is not approved.
  assert.equal(valid(S, 'e6', 'deep value'), false);
  assert.equal(directChildAnonymousTextPresent(S, 'e6', 'deep value'), false);
  assert.equal(containerSubtreeTextPresent(S, 'e6', 'deep value'), false, 'generic gets no subtree surface');
});

test('negative — arbitrary direct text on the PAGE/ROOT node stays invalid (root excluded)', () => {
  assert.equal(valid(S, 'e1', 'Top banner'), false);
  assert.equal(directChildAnonymousTextPresent(S, 'e1', 'Top banner'), false, 'root excluded from Mode D');
  // the only root-attributable strings remain title/URL (Mode C):
  assert.ok(valid(S, 'e1', 'http://localhost:3000/x'));
  assert.ok(valid(S, 'e1', 'X'));
});

test('negative — a WRONG ref that does not own the text stays invalid', () => {
  assert.equal(valid(S, 'e8', 'Signed in as'), false); // status e8 owns "Saved"/"just now", not this
});

test('negative — cross-ref: text present only at another ref is not rescued', () => {
  assert.equal(valid(S, 'e3', 'Saved'), false); // "Saved" lives under e8, cited to e3
});

test('negative — missing ref / missing snapshot / digest mismatch remain invalid', () => {
  // missing ref
  let v = validateSnapshotObservation({ label: 'x', observedText: 'Signed in as', snapshotId: 'syn-001', ref: 'e999' }, win(S));
  assert.equal(v.refPresent, false);
  assert.equal(v.valid, false);
  // snapshot not provided
  v = validateSnapshotObservation({ label: 'x', observedText: 'Signed in as', snapshotId: 'nope', ref: 'e3' }, win(S));
  assert.equal(v.snapshotProvided, false);
  assert.equal(v.valid, false);
  // digest mismatch (tampered yaml, even though the text is physically present)
  const tampered: ProvidedSnapshot = { ...S, yaml: S.yaml + '\n  - text: injected' };
  v = validateSnapshotObservation(
    { label: 'x', observedText: 'Signed in as', snapshotId: 'syn-001', ref: 'e3' },
    { windowKind: 'terminal', snapshots: [tampered], events: [] },
  );
  assert.equal(v.digestMatches, false);
  assert.equal(v.valid, false);
});

// ── directChildAnonymousText unit behavior ─────────────────────────────────────────────────────

test('directChildAnonymousText returns only depth-1 anonymous text of the cited ref', () => {
  assert.equal(directChildAnonymousText(YAML, 'e3'), 'Signed in as');
  assert.equal(directChildAnonymousText(YAML, 'e7'), 'deep value');
  assert.equal(directChildAnonymousText(YAML, 'e8'), 'Saved just now'); // two direct fragments, joined
  assert.equal(directChildAnonymousText(YAML, 'e2'), undefined, 'only ref-bearing children → no direct text');
  assert.equal(directChildAnonymousText(YAML, 'e6'), undefined, 'its text lives at depth 2 under e7');
  assert.equal(directChildAnonymousText(YAML, 'e4'), undefined, 'a leaf strong has no anonymous child');
  assert.equal(directChildAnonymousText(YAML, 'e999'), undefined, 'absent ref');
});

// ── REQUIRED PROOF: the stored G3 login:C1, replayed through the real finalization path ─────────

interface FxObs { label: string; observedText: string; snapshotId: string; ref: string }
const G3 = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'citation', 'direct-anon-text-run-28182045591.json'), 'utf8'),
) as { provenance: unknown; cases: Record<string, { window: ProvidedSnapshot[]; observations: FxObs[] }> };
const G3C = G3.cases['login:C1'];
const G3Win: EvidenceWindow = { windowKind: 'terminal', snapshots: G3C.window, events: [] };
const G3Snap = G3C.window[0];

test('G3 positive — "Signed in as" is valid at its exact owning generic ref e8 (direct anonymous child)', () => {
  const o = G3C.observations.find((x) => x.ref === 'e8');
  assert.ok(o && o.observedText === 'Signed in as', 'the diagnosed observation is present in the fixture');
  // It is the direct-child surface — not the base, canonical, or approved-container surfaces:
  assert.deepEqual(citationTextSurface(G3Snap, 'e8'), []);
  assert.equal(containerSubtreeTextPresent(G3Snap, 'e8', 'Signed in as'), false);
  assert.equal(directChildAnonymousTextPresent(G3Snap, 'e8', 'Signed in as'), true);
  assert.equal(validateSnapshotObservation(o!, G3Win).valid, true);
});

test('G3 required proof — replaying stored login:C1 (PASS) yields PASS with all five citations valid', () => {
  const res = finalizeCriterion(
    { criterionId: 'login:C1', criterionText: '(G3 replay)', window: G3Win },
    { verdict: 'PASS', observations: G3C.observations, reasoning: 'offline replay of stored G3 login:C1' },
    1,
  );
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.citationValidations.length, 5);
  assert.ok(res.citationValidations.every((v) => v.valid), 'all five citations are valid');
  assert.equal(res.inconclusiveDetail, undefined, 'no INVALID_CITATION downgrade');
});

test('G3 control — the other four citations were already valid (independent of Mode D)', () => {
  for (const ref of ['e1', 'e13', 'e9', 'e16']) {
    const o = G3C.observations.find((x) => x.ref === ref)!;
    assert.equal(validateSnapshotObservation(o, G3Win).valid, true, `obs @ ${ref}`);
  }
});

test('G3 negative — "Signed in as" cited to the strong child e9 (its sibling) stays invalid', () => {
  // Guard: Mode D must not let the banner label attach to the username ref e9.
  assert.equal(valid(G3Snap, 'e9', 'Signed in as'), false);
});
