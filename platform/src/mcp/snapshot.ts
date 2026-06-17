/**
 * Parsing of @playwright/mcp accessibility-snapshot results into the structure the
 * harness reasons about: the set of element refs, their roles/accessible names, and
 * a content digest. Pure — no filesystem, no clock, no randomness — so the
 * snapshot→ref→action audit chain (Task 4) is independently re-verifiable and
 * deterministically testable.
 *
 * Empirical shape of a `browser_snapshot` result (0.0.76), text content:
 *
 *   ### Page
 *   - Page URL: https://…
 *   - Page Title: …
 *   ### Snapshot
 *   ```yaml
 *   - generic [active] [ref=e1]:
 *     - heading "Sign in" [level=1] [ref=e2]
 *     - textbox "Username" [ref=e5]
 *     - button "Sign in" [ref=e8]
 *     - link "Go to products" [ref=e9] [cursor=pointer]:
 *       - /url: https://example.com/next
 *   ```
 *
 * Refs are `[ref=eN]`. Not every node has a ref (e.g. `- text: Username`). The
 * action tools accept that ref in their `target` param — and `target` also accepts
 * raw selectors, which is why ref membership in THIS snapshot must be validated
 * before any action is dispatched (D14).
 */

import { createHash } from "node:crypto";

export interface SnapshotElement {
  /** The snapshot ref token, e.g. "e5". The only legal value for an action target. */
  ref: string;
  /** ARIA role as printed by the snapshot, e.g. "textbox", "button", "link". */
  role: string;
  /** Accessible name if the node carried one (quoted in the snapshot). */
  name?: string;
  /** The raw snapshot line, retained for audit/debugging. */
  line: string;
}

export interface ParsedSnapshot {
  /** The exact YAML snapshot text the digest is computed over. */
  yaml: string;
  /** Content digest, `sha256:<hex>` of `yaml`. The audit-chain anchor. */
  digest: string;
  /** Every element that carries a ref, in document order. */
  elements: SnapshotElement[];
  /** The set of legal action targets in this snapshot. */
  refs: Set<string>;
  pageUrl?: string;
  pageTitle?: string;
}

const REF_RE = /\[ref=(e\d+)\]/;
const NODE_RE = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/;
const REF_TOKEN_RE = /^e\d+$/;

/** True iff `s` is shaped like a snapshot ref token ("e" followed by digits). */
export function isRefToken(s: string): boolean {
  return REF_TOKEN_RE.test(s);
}

/** Extract the content of the first ```yaml fenced block, or null if none. */
export function extractYamlBlock(resultText: string): string | null {
  const m = /```yaml\r?\n([\s\S]*?)\r?\n```/.exec(resultText);
  return m ? m[1] : null;
}

/**
 * Extract a `- [Snapshot](relative/path.yml)` file link, if the result delivered the
 * snapshot as a file reference instead of inline (the navigate tool does this). The
 * client resolves + reads it against the server output dir.
 */
export function extractSnapshotFileLink(resultText: string): string | null {
  const m = /\[Snapshot\]\(([^)]+)\)/.exec(resultText);
  return m ? m[1] : null;
}

export function extractPageInfo(resultText: string): {
  pageUrl?: string;
  pageTitle?: string;
} {
  const url = /^- Page URL:\s*(.+?)\s*$/m.exec(resultText);
  const title = /^- Page Title:\s*(.+?)\s*$/m.exec(resultText);
  return {
    ...(url ? { pageUrl: url[1] } : {}),
    ...(title ? { pageTitle: title[1] } : {}),
  };
}

function unescapeName(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Parse the ref-bearing element nodes out of a snapshot YAML body. */
export function parseSnapshotElements(yaml: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const refM = REF_RE.exec(line);
    if (!refM) continue;
    const nodeM = NODE_RE.exec(line);
    if (!nodeM) continue;
    out.push({
      ref: refM[1],
      role: nodeM[1],
      ...(nodeM[2] !== undefined ? { name: unescapeName(nodeM[2]) } : {}),
      line: line.trim(),
    });
  }
  return out;
}

/** `sha256:<hex>` digest of the snapshot YAML — the audit-chain anchor. */
export function digestSnapshot(yaml: string): string {
  return "sha256:" + createHash("sha256").update(yaml, "utf8").digest("hex");
}

/** Parse a snapshot from its YAML body plus the surrounding result text (for page info). */
export function parseSnapshot(yaml: string, resultText = ""): ParsedSnapshot {
  const elements = parseSnapshotElements(yaml);
  return {
    yaml,
    digest: digestSnapshot(yaml),
    elements,
    refs: new Set(elements.map((e) => e.ref)),
    ...extractPageInfo(resultText),
  };
}
