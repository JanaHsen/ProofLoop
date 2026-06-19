/**
 * Deterministic citation validation — part of the FROZEN Task 4 post-schema contract
 * (D14). The harness validates every observation the verifier cites; it never trusts the
 * model's claim. Pure: no model call, no clock, no randomness, so it is independently
 * re-verifiable and unit-testable.
 *
 * Citation validity of a SNAPSHOT observation =
 *   snapshotProvided && digestMatches && refPresent && observedTextPresent
 * where `observedTextPresent` is decided against the PER-REF citation text surface — the
 * text that is attributable to that EXACT ref, and nothing else on the page.
 *
 * The per-ref citation text surface is the union of, for one ref, ONLY:
 *   (a) `elements[ref].name` — the parsed accessible name, when the node carried one; and
 *   (b) the direct text attached to that exact ref's line in the stored snapshot YAML
 *       (the text after `[ref=…]: ` on that line), for inline nodes such as `strong`
 *       that have no parsed accessible name.
 * It is NEVER a whole-snapshot search: a value that appears at some OTHER ref does not
 * rescue a citation against the ref the model actually named. This is what stops a model
 * from citing a value at a ref where that value is not, in fact, displayed.
 */

import { digestSnapshot } from "../mcp/snapshot";
import type { CitationValidation } from "./evaluation";
import type { EvidenceWindow, ProvidedSnapshot } from "./resolver";

/**
 * The direct text attached to `ref` on its own line in the snapshot YAML, or `undefined`
 * when the ref's line carries no trailing inline text (it has a quoted accessible name
 * and/or children instead). Examples, for the line shown:
 *   `- strong [ref=e43]: $64.87`            → "$64.87"
 *   `- cell "$64.87" [ref=e42]:`            → undefined (value is the accessible name)
 *   `- button "Log out" [ref=e11] [cursor=pointer]` → undefined
 * Matches only the exact `[ref=<ref>]` token (the closing bracket anchors it, so `e4`
 * never matches inside `e43`); refs are unique within a snapshot, so at most one line hits.
 */
export function directTextAtRef(yaml: string, ref: string): string | undefined {
  const marker = `[ref=${ref}]`;
  for (const line of yaml.split(/\r?\n/)) {
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    // Everything after the ref token, with any trailing `[modifier]` groups (e.g.
    // `[cursor=pointer]`) stripped. Direct text exists only when a colon then follows.
    const rest = line.slice(idx + marker.length).replace(/^(?:\s*\[[^\]]*\])*/, "");
    const m = /^\s*:\s*(.*)$/.exec(rest);
    if (!m) return undefined;
    const text = m[1].trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/**
 * The per-ref citation text surface: the strings a citation against `ref` may be checked
 * for containment in — the parsed accessible name (when present) and the ref's own direct
 * YAML text (when present). Order is name-first, then direct text. Deterministic; derived
 * only from this snapshot, only from this ref.
 */
export function citationTextSurface(snap: ProvidedSnapshot, ref: string): string[] {
  const surface: string[] = [];
  const el = snap.elements.find((e) => e.ref === ref);
  if (el?.name) surface.push(el.name);
  const direct = directTextAtRef(snap.yaml, ref);
  if (direct !== undefined) surface.push(direct);
  return surface;
}

/**
 * True iff `observedText` is non-empty and is contained in the citation text surface of
 * THIS ref. Containment (not equality) lets a model cite a precise value off a coarser
 * accessible name — "$64.87" ⊆ "Total $64.87" — while still rejecting a value that is not
 * attributable to the named ref at all.
 */
export function observedTextPresentAtRef(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: unknown,
): boolean {
  if (typeof observedText !== "string" || observedText.length === 0) return false;
  return citationTextSurface(snap, ref).some((s) => s.includes(observedText));
}

/**
 * Validate one SNAPSHOT observation against the evidence window, returning the FULL
 * `CitationValidation` breakdown (the frozen evaluation-record shape) — not just `valid`.
 * Every field is preserved so a failed citation, and the exact sub-check it failed, stays
 * in the evaluation record for reliability work; the verdict harness only reads `.valid`.
 * Digest, snapshot-provided and ref-present checks are unchanged from the frozen contract;
 * only the text check consults the per-ref citation text surface. `reason` names the FIRST
 * failing sub-check (the others are then not meaningful), and is absent when valid.
 */
export function validateSnapshotObservation(o: any, window: EvidenceWindow): CitationValidation {
  const snap = window.snapshots.find((s) => s.snapshotId === o?.snapshotId);
  const snapshotProvided = !!snap;
  const digestMatches = snap ? digestSnapshot(snap.yaml) === snap.digest : false;
  const refPresent = !!(snap && typeof o?.ref === "string" && snap.refs.includes(o.ref));
  const observedTextPresent =
    !!snap && refPresent && observedTextPresentAtRef(snap, o.ref, o?.observedText);
  const valid = snapshotProvided && digestMatches && refPresent && observedTextPresent;

  let reason: string | undefined;
  if (!snapshotProvided) reason = `cited snapshot ${JSON.stringify(o?.snapshotId)} is not in this criterion's evidence window`;
  else if (!digestMatches) reason = `snapshot ${snap!.snapshotId} digest mismatch (stored blob does not recompute to its recorded digest)`;
  else if (!refPresent) reason = `ref ${JSON.stringify(o?.ref)} is not present in snapshot ${snap!.snapshotId}`;
  else if (!observedTextPresent) reason = `observedText ${JSON.stringify(o?.observedText)} is not attributable to ref ${o.ref} in snapshot ${snap!.snapshotId}`;

  return {
    snapshotProvided,
    digestMatches,
    refPresent,
    observedTextPresent,
    valid,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** The validity of one EVENT observation. Mirrors `CitationValidation` for the event surface
 *  (actuation evidence has no snapshot digest / ref); kept internal to the verdict logic,
 *  since the frozen v1.0 record summarizes events via `evidence.eventRefs`, not per-observation. */
export interface EventCitationValidation {
  /** The cited `eventSeq` was in this criterion's evidence window. */
  inWindow: boolean;
  /** The cited `eventType` matches that event's actual type. */
  typeMatches: boolean;
  /** `observedText` is contained in that event's stored detail. */
  observedTextPresent: boolean;
  valid: boolean;
  reason?: string;
}

/**
 * Validate one EVENT observation: the cited `eventSeq` must be in THIS criterion's window,
 * its `eventType` must match that event's type, and `observedText` must be contained in
 * that event's stored detail (`failureDetail` for an action, `detail` for an error).
 * Logic unchanged from the frozen contract; now returns the full breakdown + `reason`.
 */
export function validateEventObservation(o: any, window: EvidenceWindow): EventCitationValidation {
  const ev: any = window.events.find((e: any) => e.seq === o?.eventSeq);
  const inWindow = !!ev;
  const typeMatches = !!(ev && ev.type === o?.eventType);
  const detail: string = ev ? (ev.type === "action" ? ev.failureDetail ?? "" : ev.detail ?? "") : "";
  const observedTextPresent = !!(
    typeof o?.observedText === "string" &&
    o.observedText.length > 0 &&
    detail.includes(o.observedText)
  );
  const valid = inWindow && typeMatches && observedTextPresent;

  let reason: string | undefined;
  if (!inWindow) reason = `cited eventSeq ${JSON.stringify(o?.eventSeq)} is not in this criterion's evidence window`;
  else if (!typeMatches) reason = `event seq ${ev.seq} is a ${ev.type}, not the cited ${JSON.stringify(o?.eventType)}`;
  else if (!observedTextPresent) reason = `observedText ${JSON.stringify(o?.observedText)} is not contained in event seq ${ev.seq}'s detail`;

  return {
    inWindow,
    typeMatches,
    observedTextPresent,
    valid,
    ...(reason !== undefined ? { reason } : {}),
  };
}
