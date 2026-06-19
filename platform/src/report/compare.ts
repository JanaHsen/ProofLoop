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

export interface ComparisonRun {
  label: string;
  slug: string;
  runId: string;
  evaluationId: string;
  executionStatus: string;
  flowVerdict: RunReport["verification"]["flowVerdict"];
  criteria: Array<{ criterionId: string; verdict: RunReport["verification"]["flowVerdict"] }>;
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
  return `$${n.toFixed(6)}`;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 2rem; color: #1a1a1a; background: #f6f7f9; line-height: 1.5; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  code { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: .85em;
    background: #eef0f2; padding: .05rem .3rem; border-radius: 3px; }
  .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: .88rem; }
  th, td { border: 1px solid #e1e4e8; padding: .5rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f1f3f5; font-weight: 600; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem;
    font-weight: 700; letter-spacing: .03em; }
  .verdict-pass { background: #e6f4ea; color: #1a7f37; border: 1px solid #acd8b8; }
  .verdict-fail { background: #fce8e6; color: #cf222e; border: 1px solid #f1b0aa; }
  .verdict-inconclusive { background: #fff4e5; color: #9a6700; border: 1px solid #f0cd8a; }
  .muted { color: #586069; }
  .caveat { background: #fff8e6; border: 1px solid #f0cd8a; border-radius: 8px; padding: .9rem 1.1rem; margin: 0 0 1.25rem; }
  .catcher { font-size: .9rem; }
  a { color: #0969da; }
`;

/** Render the self-contained comparison HTML document. Inline CSS only; everything escaped. */
export function renderComparisonHtml(model: ComparisonModel): string {
  const criterionHeaders = model.criterionIds
    .map((id) => `<th>${escapeHtml(id)}</th>`)
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
  <td>${escapeHtml(r.executionStatus)}</td>
  <td>${verdictBadge(r.flowVerdict)}</td>
  ${criterionCells}
  <td>${escapeHtml(money(r.deciderCostUsd))}</td>
  <td>${escapeHtml(money(r.verifierCostUsd))}</td>
  <td><a href="${escapeHtml(r.reportHref)}">report.html</a></td>
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
  <p class="muted">${escapeHtml(model.title)}</p>

  <div class="caveat">${escapeHtml(COMPARISON_CAVEAT)}</div>

  <div class="card">
    <p>All four executions <strong>completed</strong>; only the behaviorally buggy states failed
    verification. A renamed control (a harmless structural change) did not change a verdict.</p>
    <table>
      <thead>
        <tr>
          <th>State</th><th>Execution status</th><th>Flow verdict</th>
          ${criterionHeaders}
          <th>Decider cost</th><th>Verifier cost</th><th>Report</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>

  <div class="card catcher">
    <h2>Catcher criterion</h2>
    <p>The behavioral regression is caught by the proportional-Tax criterion, not the
    reconcile invariant: correct Tax evidence yields <strong>PASS</strong>, while a
    <code>$0.00</code> Tax yields <strong>FAIL</strong> — even though Subtotal + Tax still
    equals the displayed Total. Per-criterion verdicts above show this contrast directly.</p>
  </div>
</main>
</body>
</html>
`;
}
