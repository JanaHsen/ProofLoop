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

// ── Additive SAME-REF surfaces (citation-surface correction) ─────────────────────────────────
//
// The base surface above (accessible name + the ref's own inline text) is correct but narrow:
// it rejected faithful-but-differently-shaped citations a model legitimately makes against the
// SAME ref ProofLoop showed it. The helpers below ADD acceptance for exactly those, each strictly
// bound to the cited ref: a canonical decorated line (Mode A); anonymous text inside an approved
// semantic container (Mode B); page title/URL on the page/root node (Mode C); and anonymous text
// that is a DIRECT child of the cited ref, for any role (Mode D). None performs a whole-snapshot,
// sibling, ancestor, fuzzy, semantic, case-insensitive, or token-based search; none hardcodes any
// application phrase. The invalid-citation guard is unchanged — these only widen what counts as
// attributable to the *named* ref.

/** Collapse runs of whitespace to single spaces and trim — the only normalization applied. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Leading-whitespace width of a YAML line (its tree depth key). */
function indentOf(line: string): number {
  return /^(\s*)/.exec(line)![1].length;
}

/**
 * Strict parse of ONE canonical snapshot node line — the grammar ProofLoop's own serializer
 * prints: `role "accessible name"? [bracket]* (: value)?`, anchored end to end. The whole string
 * must be exactly one node line; arbitrary prose that merely embeds a `[ref=…]` token does NOT
 * match. Decoration (the role word, quotes, brackets, the colon) is parsed structurally and is
 * never itself treated as visible evidence. Returns the parts, or null.
 */
const CANONICAL_LINE_RE =
  /^\s*([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)(?:\s*:\s*(.*?))?\s*$/;

export interface CanonicalLine {
  role: string;
  name?: string;
  ref?: string;
  value?: string;
}

export function parseCanonicalLine(text: string): CanonicalLine | null {
  if (typeof text !== "string") return null;
  const m = CANONICAL_LINE_RE.exec(text);
  if (!m) return null;
  const [, role, rawName, bracketRun, rawValue] = m;
  let ref: string | undefined;
  for (const b of bracketRun ? bracketRun.match(/\[[^\]]*\]/g) ?? [] : []) {
    const rm = /^\[ref=(e\d+)\]$/.exec(b);
    if (rm) ref = rm[1];
  }
  return {
    role,
    ...(rawName !== undefined ? { name: rawName.replace(/\\(["\\])/g, "$1") } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(rawValue !== undefined ? { value: rawValue.trim() } : {}),
  };
}

/**
 * Mode A — the model quoted the canonical decorated line ProofLoop showed it, for the SAME ref.
 * Valid only when: the line parses; it carries a ref equal to the cited `ref`; that ref exists;
 * the parsed accessible name EXACTLY equals the canonical name for that ref (both-absent ok); and
 * the parsed inline value EXACTLY equals that ref's canonical direct text (both-absent ok). A
 * different embedded ref, an altered name, an altered value, or decoration-only content all fail.
 */
export function matchesCanonicalLine(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: string,
): boolean {
  const parsed = parseCanonicalLine(observedText);
  if (!parsed || parsed.ref === undefined) return false; // must be a decorated line that names a ref
  if (parsed.ref !== ref) return false; // the embedded ref must be the cited ref
  const el = snap.elements.find((e) => e.ref === ref);
  if (!el) return false;
  if ((parsed.name ?? undefined) !== (el.name ?? undefined)) return false; // name must match canonical
  const canonicalValue = directTextAtRef(snap.yaml, ref);
  if ((parsed.value ?? undefined) !== (canonicalValue ?? undefined)) return false; // value must match canonical
  return true;
}

/**
 * The concatenation, in document order, of the ANONYMOUS (`- text:`) text nodes inside `ref`'s
 * OWN subtree — never its siblings, ancestors, or ref-bearing descendants (text owned by a child
 * that has its own ref must be cited to that child). Whitespace-normalized. `undefined` when the
 * subtree has no anonymous text. The subtree is bounded by indentation: lines strictly more
 * indented than `ref`'s line, up to the first line that is not.
 */
export function subtreeAnonymousText(yaml: string, ref: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`[ref=${ref}]`));
  if (start === -1) return undefined;
  const baseIndent = indentOf(lines[start]);
  const parts: string[] = [];
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === "") continue;
    if (indentOf(lines[j]) <= baseIndent) break; // left the cited ref's subtree
    const tm = /^\s*-\s+text:\s*(.*)$/.exec(lines[j]); // anonymous (ref-less) text node only
    if (tm) parts.push(tm[1]);
  }
  return parts.length > 0 ? normalizeWs(parts.join(" ")) : undefined;
}

/** Roles whose own visible message the accessibility tree splits across bare text nodes, and
 *  whose subtree is small and single-purpose enough to attribute anonymous text to. Deliberately
 *  excludes broad layout containers (generic, main, region, dialog) — searching their subtree
 *  would approach a page search. */
const APPROVED_TEXT_CONTAINER_ROLES = new Set(["paragraph", "status", "alert"]);

/** Mode B — anonymous text physically inside an APPROVED semantic container that is the cited ref. */
export function containerSubtreeTextPresent(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: string,
): boolean {
  const el = snap.elements.find((e) => e.ref === ref);
  if (!el || !APPROVED_TEXT_CONTAINER_ROLES.has(el.role)) return false;
  const surface = subtreeAnonymousText(snap.yaml, ref);
  return surface !== undefined && surface.includes(normalizeWs(observedText));
}

/** The page/root ref: the ref on the outermost (least-indented) node line of this snapshot. */
export function pageRootRef(yaml: string): string | undefined {
  let best: { indent: number; ref: string } | undefined;
  for (const line of yaml.split(/\r?\n/)) {
    const rm = /\[ref=(e\d+)\]/.exec(line);
    if (!rm) continue;
    const ind = indentOf(line);
    if (best === undefined || ind < best.indent) best = { indent: ind, ref: rm[1] };
  }
  return best?.ref;
}

/** Mode C — title/URL metadata explicitly stored on the page/root node, cited to that SAME ref. */
export function pageMetadataPresent(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: string,
): boolean {
  if (pageRootRef(snap.yaml) !== ref) return false; // only the page/root node owns title/URL
  return (
    (typeof snap.pageTitle === "string" && snap.pageTitle.length > 0 && snap.pageTitle.includes(observedText)) ||
    (typeof snap.pageUrl === "string" && snap.pageUrl.length > 0 && snap.pageUrl.includes(observedText))
  );
}

/**
 * The concatenation, in document order, of the anonymous (`- text:`) nodes that are DIRECT
 * children of `ref` — exactly one indentation level below `ref`'s own line, never deeper. Text
 * owned by a ref-bearing child, by a grandchild (depth ≥ 2), by a sibling, or by an ancestor is
 * excluded: the scan never descends past the direct-child indentation level, and never matches a
 * ref-bearing line. Whitespace-normalized; `undefined` when `ref` has no direct anonymous text
 * child. The subtree is bounded by indentation (lines strictly more indented than `ref`'s line,
 * up to the first line that is not); within it, only lines at the shallowest — i.e. direct-child —
 * indentation are considered.
 */
export function directChildAnonymousText(yaml: string, ref: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`[ref=${ref}]`));
  if (start === -1) return undefined;
  const baseIndent = indentOf(lines[start]);
  const subtree: string[] = [];
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === "") continue;
    if (indentOf(lines[j]) <= baseIndent) break; // left the cited ref's subtree
    subtree.push(lines[j]);
  }
  if (subtree.length === 0) return undefined;
  const childIndent = Math.min(...subtree.map(indentOf)); // the direct-child indentation level
  const parts: string[] = [];
  for (const line of subtree) {
    if (indentOf(line) !== childIndent) continue; // skip grandchildren / deeper descendants
    const tm = /^\s*-\s+text:\s*(.*)$/.exec(line); // anonymous (ref-less) text node only
    if (tm) parts.push(tm[1]);
  }
  return parts.length > 0 ? normalizeWs(parts.join(" ")) : undefined;
}

/**
 * Mode D — anonymous ref-less text that is a DIRECT (depth-1) child of the cited ref, attributed
 * to that ref regardless of the ref's role. Unlike Mode B — which searches an approved semantic
 * container's WHOLE subtree — this descends exactly one level, so it cannot approach a page search:
 * a plain `generic` wrapper qualifies, but only for text it directly owns. The page/root node is
 * excluded: its title/URL are Mode C's surface, and a direct-child scan of the root would span the
 * page's top-level text. Whitespace normalization only — no fuzzy/semantic/case/token matching.
 */
export function directChildAnonymousTextPresent(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: string,
): boolean {
  if (pageRootRef(snap.yaml) === ref) return false; // page/root excluded from this surface
  const surface = directChildAnonymousText(snap.yaml, ref);
  return surface !== undefined && surface.includes(normalizeWs(observedText));
}

/**
 * True iff `observedText` is non-empty and is attributable to THIS ref, by any of the five
 * deterministic same-ref surfaces (checked in order; first hit wins):
 *   1. the base surface — accessible name and/or the ref's own inline text (containment);
 *   2. a strictly-parsed canonical decorated line for the SAME ref (name+value match canonical);
 *   3. anonymous descendant text inside an approved semantic container that is the cited ref;
 *   4. anonymous text that is a DIRECT child of the cited ref (any role; page/root excluded);
 *   5. page title / URL metadata, only when the cited ref is the page/root node.
 * Every surface is bound to the named ref — never a whole-snapshot, sibling, ancestor, fuzzy, or
 * semantic search. Containment (not equality) on the base surface lets "$64.87" ⊆ "Total $64.87".
 */
export function observedTextPresentAtRef(
  snap: ProvidedSnapshot,
  ref: string,
  observedText: unknown,
): boolean {
  if (typeof observedText !== "string" || observedText.length === 0) return false;
  if (citationTextSurface(snap, ref).some((s) => s.includes(observedText))) return true;
  if (matchesCanonicalLine(snap, ref, observedText)) return true;
  if (containerSubtreeTextPresent(snap, ref, observedText)) return true;
  if (directChildAnonymousTextPresent(snap, ref, observedText)) return true;
  if (pageMetadataPresent(snap, ref, observedText)) return true;
  return false;
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
