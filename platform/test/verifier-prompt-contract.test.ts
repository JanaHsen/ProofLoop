/**
 * Verifier prompt-contract tests (citation clarification). These are DETERMINISTIC and assert
 * only that the assembled verifier prompt CONTAINS the required generic citation constraints, so
 * they cannot be silently removed. They do NOT (and cannot) prove the LLM will always comply —
 * compliance is a reliability question (Phase 8), not a static-contract one. No model call.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildVerifierInput } from "../src/verify/prompt";
import type { EvidenceWindow } from "../src/verify/resolver";

/** The system prompt is fixed for a completing window; events are absent. */
function systemPrompt(): string {
  const window: EvidenceWindow = { windowKind: "terminal", snapshots: [], events: [] };
  return buildVerifierInput("(criterion)", window).system;
}

test("prompt requires citing the OWNING semantic-container ref for anonymous text", () => {
  const s = systemPrompt();
  assert.match(s, /paragraph, status, or alert/);
  assert.match(s, /OWNED BY THAT CONTAINER/);
  assert.match(s, /cite the container's ref/);
});

test("prompt forbids citing a nearby sibling/child ref for container text", () => {
  const s = systemPrompt();
  assert.match(s, /Do NOT cite a\s+nearby child, sibling, strong, link, heading, or textbox ref/);
});

test("prompt requires SEPARATE page-title and page-URL observations at the page/root ref", () => {
  const s = systemPrompt();
  assert.match(s, /cite the page\/root ref/);
  assert.match(s, /page title as its OWN observation/);
  assert.match(s, /URL as a SEPARATE observation/);
});

test("prompt forbids inventing a combined page pseudo-line", () => {
  const s = systemPrompt();
  assert.match(s, /Do NOT combine them into invented prose/);
  assert.match(s, /page "\.\.\.", url \.\.\./);
});

test("prompt requires exact attributable observed text (no summary/paraphrase/synthetic line)", () => {
  const s = systemPrompt();
  assert.match(s, /attributable to the supplied snapshotId and that EXACT ref/);
  assert.match(s, /never a summary, a\s+paraphrase, or a synthetic line/);
  assert.match(s, /ONLY if you copy\s+it verbatim from the evidence for that same ref/);
});

test("prompt requires INCONCLUSIVE when no supplied ref can safely own the fact", () => {
  const s = systemPrompt();
  assert.match(s, /Never guess or substitute a nearby ref/);
  assert.match(s, /return INCONCLUSIVE \(AMBIGUOUS_EVIDENCE\) rather than manufacture a citation/);
});

test("prompt asks for the smallest exact evidence fragment", () => {
  assert.match(systemPrompt(), /SMALLEST exact evidence fragment/);
});

test("prompt carries neutral citation examples (no app-specific wording or known answers)", () => {
  const s = systemPrompt();
  assert.match(s, /Citation examples \(neutral placeholders\)/);
  assert.match(s, /Anonymous text "Saved\." inside `paragraph \[ref=e10\]`/);
  assert.match(s, /is WRONG/);
  // Must NOT leak ProofLoop's actual flow wording / known criterion answers into the contract.
  for (const banned of ["Place Order", "Order placed", "has been recorded", "Request received", "O-00001", "O-00002", "jana@example.com", "checkout", "Subtotal"]) {
    assert.ok(!s.includes(banned), `prompt must stay generic — found app-specific "${banned}"`);
  }
});

test("the citation contract is present for BOTH completing and non-completing windows", () => {
  const completing = buildVerifierInput("(c)", { windowKind: "terminal", snapshots: [], events: [] }).system;
  const nonCompleting = buildVerifierInput("(c)", { windowKind: "non_completing", snapshots: [], events: [] }).system;
  for (const s of [completing, nonCompleting]) {
    assert.match(s, /OWNED BY THAT CONTAINER/);
    assert.match(s, /cite the page\/root ref/);
  }
});
