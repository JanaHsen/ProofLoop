/**
 * Phase 5 Task 4 — the FROZEN snapshot-parity normalizer + comparator (D34/D37).
 *
 * This is the parity ORACLE: it decides whether two already-scrubbed canonical
 * accessibility snapshots are semantically equivalent across browser modes. Because an
 * over-permissive oracle manufactures false parity (the platform's own original failure
 * mode, relocated), it is constrained hard:
 *
 *   - CLOSED BY DEFAULT. Fields are dropped ONLY if their path is on the frozen
 *     `PARITY_DROPPED_FIELDS` allow-list. That list is EMPTY (Task 2 observed zero
 *     cross-mode deltas), so the ENTIRE comparison surface is currently significant —
 *     including refs, active, cursor, and any unknown field.
 *   - FIELD-AWARE, NOT STRING CLEANUP. The snapshot is parsed into a structured model;
 *     comparison is a generic deep structural diff over that model. There is NO regex
 *     scrubbing, NO whitespace collapsing, NO blank-line removal, NO reordering.
 *   - CANNOT SILENTLY DISCARD UNKNOWN FIELDS. Every `[bracket]` becomes a generic
 *     attribute key (known or not); any unrecognized head token is retained in `extra`;
 *     any non-list line becomes a `#raw` node. All of these are compared like everything
 *     else, so an unknown/new field surfaces as a difference instead of vanishing.
 *   - FIELD-AWARE SEMANTIC COMPARISON PLUS A CLOSED RAW-SOURCE FALLBACK. The parsed model
 *     is field-aware but is NOT a byte-lossless image of the YAML — it may normalize token
 *     spacing, blank lines, quoting/escaping, or duplicate bracket syntax. So
 *     `compareSnapshotYaml` adds a closed raw-source safeguard: if the models agree but the
 *     scrubbed source bytes differ, it appends a deterministic raw line diff. A
 *     parser-normalized source difference can therefore never disappear into an `equal`
 *     verdict while the allow-list is empty.
 *   - INDEPENDENT of the Phase 2 no-progress fingerprint. `normalizeForProgress`
 *     (engine/guards.ts) is neither imported nor reused: its job is the opposite (strip
 *     volatile fields to detect "did anything change"); parity must PRESERVE behavioral
 *     semantics and remove only explicitly approved mode-incidental volatility.
 *
 * Widening `PARITY_DROPPED_FIELDS` is a FROZEN-CONTRACT change: it requires editing the
 * constant here, updating the negative-guard tests, updating the Phase 5 documentation,
 * and passing a NEW human gate. The empty list is the committed Task 2 result.
 */

/**
 * The frozen dropped-field allow-list. EMPTY by construction, derived from the committed
 * Task 2 findings (`platform/test/investigation/FINDINGS.md`): zero observed cross-mode
 * deltas at `/login` and `/form`; `[ref]`, `[active]`, `[cursor]` present but invariant.
 *
 * Entries (when non-empty in a FUTURE, separately human-gated revision) are structural
 * paths with array indices normalized to `[]`, e.g. `children[].attributes.cursor`, so a
 * dropped field applies at every element position. A path NOT on this list is significant.
 */
export const PARITY_DROPPED_FIELDS: readonly string[] = Object.freeze([]);

/** A leaf scalar in the parsed model. */
export type ParityScalar = string | number | boolean;

/**
 * One node of the field-aware model parsed from the canonical snapshot YAML. Every
 * accessibility-bearing token is captured into a named, compared field; no accessibility
 * FIELD is dropped (exact source-byte fidelity — spacing, blank lines, quoting, duplicate
 * syntax — is guarded separately by `compareSnapshotYaml`'s raw-source fallback).
 * `attributes` holds every `[bracket]` verbatim by key (ref, active, cursor, level,
 * checked, disabled, selected, AND any unknown bracket), so unknown state is compared.
 */
export interface ParityNode {
  /** ARIA role / node kind as printed (e.g. "button", "textbox", "text", "/url", "#raw"). */
  role: string;
  /** Accessible name, verbatim, if the node carried a quoted one. */
  name?: string;
  /** Every `[bracket]`: `key=value` → string value; bare `[flag]` → boolean true. */
  attributes: Record<string, ParityScalar>;
  /** Inline value after `: ` (e.g. `text: Username`, `/url: /products`, `code: …`). */
  value?: string;
  /** Any head text not classified as role/name/bracket — retained so nothing is lost. */
  extra?: string;
  /** Child nodes, in document order (order is significant; never reordered). */
  children: ParityNode[];
}

/** The parsed model root — a synthetic document node wrapping the top-level forest. */
export type SnapshotModel = ParityNode;

export type ParityDiffKind = "added" | "removed" | "changed" | "type_changed";

/** One structural difference. `left`/`right` are generic; the caller may label them. */
export interface ParityDifference {
  /** Structural path, e.g. `children[0].attributes.cursor`. Stable + deterministic. */
  path: string;
  left: unknown;
  right: unknown;
  kind: ParityDiffKind;
}

export interface SnapshotParityResult {
  equal: boolean;
  /** Empty iff `equal`. Deterministic order (see compareSnapshotParity). Never a bare bool. */
  differences: ParityDifference[];
  /** Optional caller-supplied labels (e.g. {left:"headed", right:"headless"}). */
  labels?: { left: string; right: string };
}

// --- the field-aware parser (the "normalizer": builds the closed, lossless model) ------

const BRACKET_RE = /\[([^\]]*)\]/g;
const NAME_RE = /"((?:[^"\\]|\\.)*)"/;

function unescapeName(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Index of the first top-level `: ` separator (not inside quotes or brackets), else -1. */
function inlineValueSep(s: string): number {
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === "[") depth++;
    else if (!inQuote && c === "]") depth--;
    else if (!inQuote && depth === 0 && c === ":" && s[i + 1] === " ") return i;
  }
  return -1;
}

/** Parse one list item's content (everything after `- `) into a node (children added later). */
function parseItem(content: string): ParityNode {
  let head = content;
  let value: string | undefined;
  if (head.endsWith(":")) {
    head = head.slice(0, -1); // parent line; children follow, no inline value
  } else {
    const sep = inlineValueSep(head);
    if (sep >= 0) {
      value = head.slice(sep + 2);
      head = head.slice(0, sep);
    }
  }
  const node = parseHead(head.trim());
  if (value !== undefined) node.value = value;
  return node;
}

function parseHead(head: string): ParityNode {
  const attributes: Record<string, ParityScalar> = {};
  // pull every [bracket] out generically (unknown brackets included), leaving a space
  let rest = head.replace(BRACKET_RE, (_m, inner: string) => {
    const eq = inner.indexOf("=");
    if (eq >= 0) attributes[inner.slice(0, eq)] = inner.slice(eq + 1);
    else if (inner.length > 0) attributes[inner] = true;
    return " ";
  });
  let name: string | undefined;
  const nameM = NAME_RE.exec(rest);
  if (nameM) {
    name = unescapeName(nameM[1]);
    rest = rest.slice(0, nameM.index) + " " + rest.slice(nameM.index + nameM[0].length);
  }
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const role = tokens.shift() ?? "";
  const extra = tokens.join(" ").trim();
  const node: ParityNode = { role, attributes, children: [] };
  if (name !== undefined) node.name = name;
  if (extra.length > 0) node.extra = extra;
  return node;
}

const ITEM_RE = /^(\s*)-\s+(.*)$/;

/**
 * Parse already-scrubbed canonical snapshot YAML into the FIELD-AWARE model. This is NOT a
 * byte-lossless image of the source: token spacing, blank lines, quoting/escaping, and
 * duplicate bracket keys may be normalized — `compareSnapshotYaml`'s raw-source fallback is
 * what keeps those distinctions significant. Indentation encodes hierarchy (2 spaces per
 * level in practice; indent-width agnostic). Names, values, and roles are preserved
 * verbatim, unknown `[brackets]` are kept by key, and a non-list line is retained as a
 * `#raw` node rather than dropped.
 */
export function parseCanonicalSnapshot(yaml: string): SnapshotModel {
  const root: ParityNode = { role: "#document", attributes: {}, children: [] };
  const stack: { indent: number; node: ParityNode }[] = [{ indent: -1, node: root }];
  for (const raw of yaml.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const m = ITEM_RE.exec(raw);
    if (!m) {
      // Not a "- " item: retain it verbatim as an anomaly node so nothing is silently lost.
      stack[stack.length - 1].node.children.push({
        role: "#raw",
        attributes: {},
        extra: raw.trim(),
        children: [],
      });
      continue;
    }
    const indent = m[1].length;
    const node = parseItem(m[2]);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

// --- the comparator (generic deep structural diff over the model) ----------------------

function allowListPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** Closed allow-list gate. Empty list ⇒ always false ⇒ every path is significant. */
function isDroppedPath(path: string): boolean {
  if (PARITY_DROPPED_FIELDS.length === 0) return false;
  return PARITY_DROPPED_FIELDS.includes(allowListPath(path));
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function definedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

function diffValue(
  left: unknown,
  right: unknown,
  path: string,
  out: ParityDifference[],
): void {
  if (isDroppedPath(path)) return; // closed allow-list (currently never fires)
  const lk = kindOf(left);
  const rk = kindOf(right);
  if (lk !== rk) {
    out.push({ path, left, right, kind: "type_changed" });
    return;
  }
  if (lk === "array") {
    const l = left as unknown[];
    const r = right as unknown[];
    const max = Math.max(l.length, r.length);
    for (let i = 0; i < max; i++) {
      const p = `${path}[${i}]`;
      if (isDroppedPath(p)) continue;
      if (i >= l.length) out.push({ path: p, left: undefined, right: r[i], kind: "added" });
      else if (i >= r.length) out.push({ path: p, left: l[i], right: undefined, kind: "removed" });
      else diffValue(l[i], r[i], p, out);
    }
    return;
  }
  if (lk === "object") {
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const keys = [...new Set([...definedKeys(l), ...definedKeys(r)])].sort();
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (isDroppedPath(p)) continue;
      const lhas = l[k] !== undefined;
      const rhas = r[k] !== undefined;
      if (!lhas) out.push({ path: p, left: undefined, right: r[k], kind: "added" });
      else if (!rhas) out.push({ path: p, left: l[k], right: undefined, kind: "removed" });
      else diffValue(l[k], r[k], p, out);
    }
    return;
  }
  if (left !== right) out.push({ path, left, right, kind: "changed" });
}

/**
 * Compare two already-scrubbed snapshot models (or any generic left/right values) and
 * return a structured parity result. Inputs are treated as peers — neither is authoritative
 * by ordering; the optional `labels` only annotate presentation. Differences are emitted in
 * a deterministic order: depth-first, object keys ascending, array indices ascending — so
 * `JSON.stringify(result)` is byte-identical across repeated invocations.
 */
export function compareSnapshotParity(
  left: unknown,
  right: unknown,
  labels?: { left: string; right: string },
): SnapshotParityResult {
  const differences: ParityDifference[] = [];
  diffValue(left, right, "", differences);
  return {
    equal: differences.length === 0,
    differences,
    ...(labels ? { labels } : {}),
  };
}

/**
 * Deterministic raw-source line differences between two ALREADY-SCRUBBED YAML strings.
 * Positional line alignment (no LCS): exact line values are preserved (no trimming, no
 * whitespace collapsing, no blank-line removal, no quote normalization), and added/removed/
 * changed lines are distinguished. If the strings differ only in ways line-splitting
 * normalizes (e.g. CRLF vs LF), a single whole-source `$raw` difference is emitted so a byte
 * difference can never yield an empty diff. Inputs are scrubbed, so values carry no secrets
 * or machine paths.
 */
function rawSourceDifferences(left: string, right: string): ParityDifference[] {
  const L = left.split(/\r?\n/);
  const R = right.split(/\r?\n/);
  const out: ParityDifference[] = [];
  const max = Math.max(L.length, R.length);
  for (let i = 0; i < max; i++) {
    const l = L[i];
    const r = R[i];
    if (l === r) continue;
    if (l === undefined) out.push({ path: `$raw.lines[${i}]`, left: undefined, right: r, kind: "added" });
    else if (r === undefined) out.push({ path: `$raw.lines[${i}]`, left: l, right: undefined, kind: "removed" });
    else out.push({ path: `$raw.lines[${i}]`, left: l, right: r, kind: "changed" });
  }
  if (out.length === 0) out.push({ path: "$raw", left, right, kind: "changed" });
  return out;
}

/**
 * Compare two already-scrubbed canonical snapshot YAMLs: a FIELD-AWARE semantic comparison
 * of the parsed models PLUS a closed raw-source fallback. If the models agree but the source
 * bytes differ — a distinction the parser normalized (spacing, blank lines, quoting/escaping,
 * duplicate bracket syntax, line endings) — a deterministic raw line diff is appended so
 * `equal` becomes false. When the models already differ, their structured diffs explain the
 * change and no raw noise is added. The essential invariant: with `PARITY_DROPPED_FIELDS`
 * empty, ANY byte difference in the scrubbed source yields `equal: false`.
 */
export function compareSnapshotYaml(
  leftYaml: string,
  rightYaml: string,
  labels?: { left: string; right: string },
): SnapshotParityResult {
  const semantic = compareSnapshotParity(
    parseCanonicalSnapshot(leftYaml),
    parseCanonicalSnapshot(rightYaml),
    labels,
  );
  if (semantic.equal && leftYaml !== rightYaml) {
    return {
      equal: false,
      differences: rawSourceDifferences(leftYaml, rightYaml),
      ...(labels ? { labels } : {}),
    };
  }
  return semantic;
}
