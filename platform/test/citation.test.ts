import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EvidenceWindow, ProvidedSnapshot } from "../src/verify/resolver";
import {
  citationTextSurface,
  directTextAtRef,
  validateSnapshotObservation,
} from "../src/verify/citation";

// The frozen clean cart. e42 is `cell "$64.87"` (parsed name) wrapping `strong [ref=e43]: $64.87`
// (NO parsed name — its value lives only in the YAML direct text). e41 is the same for "Total".
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

const WINDOW: EvidenceWindow = { windowKind: "terminal", snapshots: [SNAP], events: [] };

const obs = (ref: string, observedText: string, snapshotId = "snapshot-022") => ({
  label: "x",
  observedText,
  snapshotId,
  ref,
});
const valid = (o: any) => validateSnapshotObservation(o, WINDOW).valid;

// ---- the per-ref citation text surface ----

test("surface of an inline `strong` ref is its YAML direct text (no parsed name)", () => {
  // `- strong [ref=e43]: $64.87` — no quoted accessible name, value after the colon.
  assert.equal(SNAP.elements.find((e) => e.ref === "e43")?.name, undefined);
  assert.equal(directTextAtRef(SNAP.yaml, "e43"), "$64.87");
  assert.deepEqual(citationTextSurface(SNAP, "e43"), ["$64.87"]);
});

test("surface of a named cell is its accessible name; trailing-colon lines carry no direct text", () => {
  // `- cell "$64.87" [ref=e42]:` — name present, no inline text after the colon.
  assert.equal(directTextAtRef(SNAP.yaml, "e42"), undefined);
  assert.deepEqual(citationTextSurface(SNAP, "e42"), ["$64.87"]);
  // `- row "Total $64.87" [ref=e39]:` — coarse accessible name, no direct text.
  assert.deepEqual(citationTextSurface(SNAP, "e39"), ["Total $64.87"]);
});

test("directTextAtRef matches the exact ref token, not a prefix (e4 ≠ e43)", () => {
  // e4 is `- navigation [ref=e4]:` with children — no direct text. It must NOT pick up e43's "$64.87".
  assert.equal(directTextAtRef(SNAP.yaml, "e4"), undefined);
});

// ---- the five mandated validation cases ----

test("1) `strong [ref=e43]: $64.87` — observedText $64.87 validates for ref=e43", () => {
  assert.equal(valid(obs("e43", "$64.87")), true);
});

test("2) containment against a coarser accessible name — $64.87 ⊆ `Total $64.87` at ref=e39", () => {
  assert.equal(valid(obs("e39", "$64.87")), true);
});

test("3) wrong text at the correct ref fails — $99.99 is not at ref=e43", () => {
  assert.equal(valid(obs("e43", "$99.99")), false);
});

test("4) correct text at the wrong ref fails — $64.87 is not at the Tax cell ref=e38", () => {
  // e38 is `cell "$5.90"` (the Tax amount). $64.87 is not in its surface.
  assert.deepEqual(citationTextSurface(SNAP, "e38"), ["$5.90"]);
  assert.equal(valid(obs("e38", "$64.87")), false);
});

test("5) text elsewhere in the snapshot does NOT rescue the wrong ref — $64.87 cited at the Subtotal cell e34", () => {
  // $64.87 really is displayed elsewhere (at e42/e43), but never at e34 (`cell "Subtotal"`).
  assert.deepEqual(citationTextSurface(SNAP, "e34"), ["Subtotal"]);
  assert.equal(valid(obs("e34", "$64.87")), false);
});

// ---- digest / snapshot-provided / ref-present checks are unchanged ----

test("snapshot-not-provided fails (unknown snapshotId)", () => {
  assert.equal(valid(obs("e43", "$64.87", "snapshot-999")), false);
});

test("ref-not-present fails (ref absent from this snapshot)", () => {
  assert.equal(valid(obs("e999", "$64.87")), false);
});

test("digest mismatch fails even when ref + text would otherwise validate", () => {
  const tampered: ProvidedSnapshot = { ...SNAP, digest: "sha256:deadbeef" };
  const w: EvidenceWindow = { windowKind: "terminal", snapshots: [tampered], events: [] };
  assert.equal(validateSnapshotObservation(obs("e43", "$64.87"), w).valid, false);
});
