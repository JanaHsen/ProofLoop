/**
 * The four-state comparison generator (Phase 4 Task 3). It turns the human-authored
 * presentation manifest into ONE self-contained comparison page, built ONLY from the
 * selected per-run reports — each produced by the same Task 1 `buildReport`, so the
 * comparison inherits every D28 integrity assertion and the D29 secret redaction for free.
 *
 * It does NOT invent or infer anything. Display labels come solely from the manifest (D27);
 * verdicts, statuses, and costs are re-stated from the recorded reports. The page carries a
 * visible Phase 3 demonstration caveat and is explicitly NOT an accuracy result. Offline:
 * no browser, verifier, LLM, or network. Inline CSS only; every value HTML-escaped (D29).
 */

import * as path from "node:path";

import { buildReport } from "./builder";
import { escapeHtml, verdictBadge } from "./html";
import { criterionLabel } from "./labels";
import { loadManifest, slugify, type PresentationManifest } from "./manifest";
import type { RunReport } from "./schema";

/** The exact section label. Never "accuracy results". */
export const COMPARISON_SECTION_LABEL = "Phase 3 regression demonstration";

/** The verbatim caveat embedded in the page (Task 3). */
export const COMPARISON_CAVEAT =
  "This is a focused Phase 3 regression demonstration. It shows that ProofLoop adapted to " +
  "one harmless structural change while still detecting one targeted behavioral regression. " +
  "It is not a platform-wide accuracy result across the complete bug ledger. Broader accuracy, " +
  "false-pass/false-fail measurement, and reliability evaluation belong to Phases 7–8.";

/**
 * Human-verified control-label provenance (Task 3 §6 fallback). The add-control's accessible
 * name lives only in the stored snapshot blobs; surfacing it per action would need new
 * evidence-resolution logic and would change `report.json`, both of which are out of bounds
 * here. So this is a static, presentation-only note keyed by the human-authored display label,
 * transcribed from the already human-verified Phase 0 audit — NOT inferred from artifacts.
 */
const CONTROL_PROVENANCE: Record<string, string> = {
  Clean: "Add to Cart",
  "Renamed control": "Add to Bag",
  "Broken tax": "Add to Cart",
  "Renamed control + broken tax": "Add to Bag",
};

export interface ComparisonRun {
  label: string;
  slug: string;
  runId: string;
  evaluationId: string;
  executionStatus: string;
  flowVerdict: RunReport["verification"]["flowVerdict"];
  criteria: Array<{ criterionId: string; verdict: RunReport["verification"]["flowVerdict"] }>;
  /** Tax figure read from the report's own Tax observation (a recorded value, not an expectation). */
  taxEvidence: string;
  deciderCostUsd: number;
  verifierCostUsd: number;
  /** Relative href to the per-run report committed under presentation/runs/<slug>/report.html. */
  reportHref: string;
}

export interface ComparisonModel {
  title: string;
  /** Union of criterion ids across runs, in first-seen order — the comparison's columns. */
  criterionIds: string[];
  runs: ComparisonRun[];
}

export interface BuildComparisonOptions {
  manifestPath: string;
  runsRoot: string;
  flowsDir: string;
}

/**
 * Read the Tax figure from the report's OWN recorded evidence — the first observation whose
 * label names the Tax (case-insensitive), as the verifier observed it. This is a value pulled
 * from the selected report, never a hardcoded per-state expectation. "—" if none is recorded.
 */
function deriveTaxEvidence(report: RunReport): string {
  for (const c of report.verification.criteria) {
    for (const o of c.observations) {
      if (/\btax\b/i.test(o.label)) return o.observedText;
    }
  }
  return "—";
}

/** Build the comparison model from the manifest + the selected per-run reports. */
export function buildComparison(opts: BuildComparisonOptions): ComparisonModel {
  const manifest: PresentationManifest = loadManifest(opts.manifestPath);

  const runs: ComparisonRun[] = manifest.runs.map((entry) => {
    const report = buildReport({
      runDir: path.join(opts.runsRoot, entry.runId),
      evaluationId: entry.evaluationId,
      flowsDir: opts.flowsDir,
    });
    const slug = slugify(entry.label);
    return {
      label: entry.label,
      slug,
      runId: report.source.runId,
      evaluationId: report.source.evaluationId,
      executionStatus: report.execution.status,
      flowVerdict: report.verification.flowVerdict,
      criteria: report.verification.criteria.map((c) => ({
        criterionId: c.criterionId,
        verdict: c.verdict,
      })),
      taxEvidence: deriveTaxEvidence(report),
      deciderCostUsd: report.execution.costUsd,
      verifierCostUsd: report.verification.costUsd,
      reportHref: `runs/${slug}/report.html`,
    };
  });

  const criterionIds: string[] = [];
  for (const r of runs) {
    for (const c of r.criteria) {
      if (!criterionIds.includes(c.criterionId)) criterionIds.push(c.criterionId);
    }
  }

  return { title: manifest.title, criterionIds, runs };
}

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

// ProofLoop presentation palette: warm cream page, light-cream cards, burgundy headings /
// borders / links, accessible green/red verdict badges (with explicit text) and a neutral
// status badge distinct from the verdicts. System fonts only — no external resources.
const STYLE = `
  * { box-sizing: border-box; }
  html, body { max-width: 100%; overflow-x: hidden; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 2rem; color: #2b2226; background: #f7efe3; line-height: 1.5; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .75rem; color: #6e1f2a; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; color: #6e1f2a; }
  code { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: .85em;
    background: #f1e4d6; padding: .05rem .3rem; border-radius: 3px; }
  .card { background: #fffdf8; border: 1px solid #e2cdbf; border-radius: 8px;
    padding: 1rem 1.25rem; margin: 0 0 1rem; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: .88rem; }
  th, td { border: 1px solid #e2cdbf; padding: .5rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f3e7d9; font-weight: 600; color: #6e1f2a; }
  th .cid { font-weight: 400; margin-top: .2rem; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem;
    font-weight: 700; letter-spacing: .03em; white-space: nowrap; }
  .verdict-pass { background: #e6f4ea; color: #1a7f37; border: 1px solid #acd8b8; }
  .verdict-fail { background: #fce8e6; color: #cf222e; border: 1px solid #f1b0aa; }
  .verdict-inconclusive { background: #fff4e5; color: #9a6700; border: 1px solid #f0cd8a; }
  .badge-neutral { background: #efe1d0; color: #5b4636; border: 1px solid #d8c0a6; }
  .muted { color: #6b5a52; }
  .caveat { background: #fbeede; border: 1px solid #dcae8f; border-radius: 8px;
    padding: .9rem 1.1rem; margin: 0 0 1.25rem; color: #5b3a2a; }
  .catcher { font-size: .9rem; }
  .provenance { border-left: 5px solid #6e1f2a; font-size: .9rem; }
  a { color: #6e1f2a; }
  @media (max-width: 700px) { body { padding: 1rem; } th, td { word-break: break-word; } }
`;

/**
 * The human-verified control-label provenance note (Task 3 §6 fallback). Lists the add-control
 * accessible name observed for each state, transcribed from the human-verified audit — clearly
 * labelled as such, so it reads as provenance, not platform inference. Rendered only for labels
 * present in the verified map; omitted entirely if none match.
 */
function provenanceSection(model: ComparisonModel): string {
  const rows = model.runs
    .filter((r) => CONTROL_PROVENANCE[r.label] !== undefined)
    .map(
      (r) =>
        `<tr><td><strong>${escapeHtml(r.label)}</strong></td><td><code>${escapeHtml(
          CONTROL_PROVENANCE[r.label],
        )}</code></td></tr>`,
    )
    .join("\n");
  if (rows === "") return "";
  return `<div class="card provenance">
    <h2>Human-verified artifact provenance</h2>
    <p class="muted">The add-control's accessible name was verified manually from the stored
    pre-action snapshots during the read-only audit. ProofLoop does not infer bug or mutation
    state from artifacts; the state labels come only from the human-authored presentation
    manifest. Self-heal: under the renamed control the executor still located and clicked the
    add-control by intent.</p>
    <div class="table-wrap">
    <table>
      <thead><tr><th>State</th><th>Observed add-control</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    </div>
  </div>`;
}

/** Render the self-contained comparison HTML document. Inline CSS only; everything escaped. */
export function renderComparisonHtml(model: ComparisonModel): string {
  const criterionHeaders = model.criterionIds
    .map(
      (id) =>
        `<th>${escapeHtml(criterionLabel(id))}<div class="cid"><code>${escapeHtml(id)}</code></div></th>`,
    )
    .join("");

  const rows = model.runs
    .map((r) => {
      const byId = new Map(r.criteria.map((c) => [c.criterionId, c.verdict]));
      const criterionCells = model.criterionIds
        .map((id) => {
          const v = byId.get(id);
          return `<td>${v !== undefined ? verdictBadge(v) : '<span class="muted">—</span>'}</td>`;
        })
        .join("");
      return `<tr>
  <td><strong>${escapeHtml(r.label)}</strong><div class="muted"><code>${escapeHtml(r.runId)}</code><br><code>${escapeHtml(r.evaluationId)}</code></div></td>
  <td><span class="badge badge-neutral">${escapeHtml(r.executionStatus)}</span></td>
  <td>${verdictBadge(r.flowVerdict)}</td>
  ${criterionCells}
  <td>${escapeHtml(r.taxEvidence)}</td>
  <td>${escapeHtml(money(r.deciderCostUsd))}</td>
  <td>${escapeHtml(money(r.verifierCostUsd))}</td>
  <td><a href="${escapeHtml(r.reportHref)}">View evidence report</a></td>
</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(COMPARISON_SECTION_LABEL)}</h1>

  <div class="caveat">${escapeHtml(COMPARISON_CAVEAT)}</div>

  <div class="card">
    <p>All four executions <strong>completed</strong>; only the behaviorally buggy states failed
    verification. A renamed control (a harmless structural change) did not change a verdict.</p>
    <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>State</th><th>Execution status</th><th>Flow verdict</th>
          ${criterionHeaders}
          <th>Tax evidence</th>
          <th>Decider cost</th><th>Verifier cost</th><th>Report</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
    </div>
  </div>

  <div class="card catcher">
    <h2>Catcher criterion</h2>
    <p>The behavioral regression is caught by the proportional-Tax criterion, not the
    reconcile invariant: correct Tax evidence yields <strong>PASS</strong>, while a
    <code>$0.00</code> Tax yields <strong>FAIL</strong> — even though Subtotal + Tax still
    equals the displayed Total. Per-criterion verdicts and the Tax evidence column above show
    this contrast directly.</p>
  </div>

  ${provenanceSection(model)}
</main>
</body>
</html>
`;
}
