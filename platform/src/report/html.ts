/**
 * Self-contained HTML renderer for a `RunReport` (Phase 4 Task 1, D29). The output is a
 * single file with INLINE CSS only — no external scripts, stylesheets, fonts, or fetches,
 * and no executable inline JavaScript. It opens correctly with the network disabled.
 *
 * EVERY artifact-derived string is HTML-escaped (D29): the report reads already-scrubbed
 * stored artifacts, but their text (flow prose, criterion text, verifier reasoning,
 * observations, refs, page URLs, failure details, and any future summary text) is still
 * untrusted and may contain markup or instruction-like content. Invalid citation checks are
 * rendered VISIBLY rather than hidden (D28/D30), and `normalizedValue` is shown only when
 * present. Execution status and flow verdict are presented as visibly distinct concepts, and
 * executor metrics are kept in a separate section from verifier metrics (D31).
 */

import type {
  CitationValidation,
  Observation,
} from "../verify/evaluation";
import type {
  ReportCriterion,
  ReportTimelineEntry,
  RunReport,
} from "./schema";

/** Escape the five HTML-significant characters. Applied to EVERY artifact-derived value. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VERDICT_CLASS: Record<string, string> = {
  PASS: "verdict-pass",
  FAIL: "verdict-fail",
  INCONCLUSIVE: "verdict-inconclusive",
};

function verdictBadge(verdict: string): string {
  const cls = VERDICT_CLASS[verdict] ?? "verdict-inconclusive";
  return `<span class="badge ${cls}">${escapeHtml(verdict)}</span>`;
}

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

/** A boolean citation check, coloured by pass/fail so a failed check is impossible to miss. */
function checkCell(ok: boolean): string {
  return ok
    ? `<td class="check-ok">true</td>`
    : `<td class="check-bad">false</td>`;
}

function observationRows(
  observations: Observation[],
  validations: CitationValidation[],
): string {
  // observations.length === validations.length is asserted at build time (D28).
  if (observations.length === 0) {
    return `<tr><td colspan="11" class="muted">No observations recorded for this criterion.</td></tr>`;
  }
  return observations
    .map((o, i) => {
      const v = validations[i];
      const rowClass = v.valid ? "" : ' class="citation-invalid"';
      const normalized =
        o.normalizedValue !== undefined
          ? `<div class="normalized">normalized: ${escapeHtml(o.normalizedValue)}</div>`
          : "";
      const reason =
        v.reason !== undefined && v.reason !== ""
          ? `<div class="reason">${escapeHtml(v.reason)}</div>`
          : "";
      return `<tr${rowClass}>
  <td>${escapeHtml(o.label)}</td>
  <td><code>${escapeHtml(o.observedText)}</code>${normalized}</td>
  <td><code>${escapeHtml(o.snapshotId)}</code></td>
  <td><code>${escapeHtml(o.ref)}</code></td>
  ${checkCell(v.snapshotProvided)}
  ${checkCell(v.digestMatches)}
  ${checkCell(v.refPresent)}
  ${checkCell(v.observedTextPresent)}
  ${checkCell(v.valid)}
  <td>${reason || '<span class="muted">—</span>'}</td>
</tr>`;
    })
    .join("\n");
}

function criterionSection(c: ReportCriterion): string {
  const inconclusive =
    c.inconclusiveDetail !== undefined
      ? `<p class="inconclusive-detail"><strong>Inconclusive:</strong> ${escapeHtml(
          c.inconclusiveDetail.kind,
        )}${
          "code" in c.inconclusiveDetail
            ? ` / ${escapeHtml(c.inconclusiveDetail.code)} (${escapeHtml(
                c.inconclusiveDetail.origin,
              )})`
            : ""
        } — ${escapeHtml(c.inconclusiveDetail.explanation)}</p>`
      : "";
  return `<section class="criterion">
  <h3>${escapeHtml(c.criterionId)} ${verdictBadge(c.verdict)}</h3>
  <p class="criterion-text">${escapeHtml(c.text)}</p>
  ${inconclusive}
  <p class="reasoning"><strong>Verifier reasoning:</strong> ${escapeHtml(c.reasoning) || '<span class="muted">(none recorded)</span>'}</p>
  <table class="evidence">
    <thead>
      <tr>
        <th>Label</th><th>Observed text</th><th>Snapshot</th><th>Ref</th>
        <th>snapshot<br>Provided</th><th>digest<br>Matches</th><th>ref<br>Present</th>
        <th>observedText<br>Present</th><th>valid</th><th>reason</th>
      </tr>
    </thead>
    <tbody>
${observationRows(c.observations, c.citationValidations)}
    </tbody>
  </table>
</section>`;
}

function timelineRows(entries: ReportTimelineEntry[]): string {
  if (entries.length === 0) {
    return `<tr><td colspan="5" class="muted">No timeline events.</td></tr>`;
  }
  return entries
    .map((e) => {
      const detailParts: string[] = [];
      if (e.action !== undefined) detailParts.push(`action=${escapeHtml(e.action)}`);
      if (e.ref !== undefined) detailParts.push(`ref=${escapeHtml(e.ref)}`);
      if (e.status !== undefined) detailParts.push(`status=${escapeHtml(e.status)}`);
      if (e.ordinal !== undefined) detailParts.push(`ordinal=${escapeHtml(e.ordinal)}`);
      if (e.pageUrl !== undefined) detailParts.push(`url=${escapeHtml(e.pageUrl)}`);
      if (e.code !== undefined) detailParts.push(`code=${escapeHtml(e.code)}`);
      if (e.executionStatus !== undefined) {
        detailParts.push(`executionStatus=${escapeHtml(e.executionStatus)}`);
      }
      const detailText =
        e.detail !== undefined && e.detail !== ""
          ? `<div class="detail">${escapeHtml(e.detail)}</div>`
          : "";
      const failure =
        e.failureDetail !== undefined && e.failureDetail !== ""
          ? `<div class="detail failure">failure: ${escapeHtml(e.failureDetail)}${
              e.failureDetailTruncated ? " (truncated)" : ""
            }</div>`
          : "";
      return `<tr>
  <td>${escapeHtml(e.seq)}</td>
  <td><code>${escapeHtml(e.type)}</code></td>
  <td>${e.stepId !== undefined ? `<code>${escapeHtml(e.stepId)}</code>` : '<span class="muted">—</span>'}</td>
  <td>${e.stepText !== undefined ? escapeHtml(e.stepText) : '<span class="muted">—</span>'}</td>
  <td>${detailParts.map((p) => `<code>${p}</code>`).join(" ")}${detailText}${failure}</td>
</tr>`;
    })
    .join("\n");
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 2rem; color: #1a1a1a; background: #f6f7f9; line-height: 1.5; }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; border-bottom: 2px solid #e1e4e8; padding-bottom: .3rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .4rem; }
  code { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: .85em;
    background: #eef0f2; padding: .05rem .3rem; border-radius: 3px; }
  .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
  .kv dt { color: #586069; }
  .kv dd { margin: 0; font-weight: 600; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem;
    font-weight: 700; letter-spacing: .03em; vertical-align: middle; }
  .verdict-pass { background: #e6f4ea; color: #1a7f37; border: 1px solid #acd8b8; }
  .verdict-fail { background: #fce8e6; color: #cf222e; border: 1px solid #f1b0aa; }
  .verdict-inconclusive { background: #fff4e5; color: #9a6700; border: 1px solid #f0cd8a; }
  .distinct { display: flex; gap: 1rem; flex-wrap: wrap; }
  .distinct .card { flex: 1 1 280px; margin: 0; }
  .distinct .label { font-size: .8rem; color: #586069; text-transform: uppercase; letter-spacing: .04em; }
  .distinct .value { font-size: 1.25rem; font-weight: 700; margin-top: .15rem; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { border: 1px solid #e1e4e8; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f1f3f5; font-weight: 600; }
  .check-ok { color: #1a7f37; font-weight: 600; }
  .check-bad { color: #cf222e; font-weight: 700; background: #fce8e6; }
  tr.citation-invalid { background: #fff6f6; }
  .muted { color: #8a8f96; }
  .normalized, .reason, .detail { font-size: .78rem; color: #586069; margin-top: .2rem; }
  .detail.failure { color: #cf222e; }
  .reasoning, .criterion-text { margin: .3rem 0; }
  .inconclusive-detail { background: #fff4e5; border: 1px solid #f0cd8a; padding: .4rem .6rem; border-radius: 6px; }
  ol.steps li, ul.criteria li { margin: .25rem 0; }
  footer { color: #8a8f96; font-size: .8rem; margin-top: 2rem; }
`;

/** Render a complete, self-contained HTML document for one report. */
export function renderReportHtml(report: RunReport): string {
  const f = report.flow;
  const ex = report.execution;
  const ve = report.verification;

  const description =
    f.description !== undefined
      ? `<p class="muted">${escapeHtml(f.description)}</p>`
      : "";

  const steps = f.steps
    .map((s) => `<li><code>${escapeHtml(s.id)}</code> ${escapeHtml(s.text)}</li>`)
    .join("\n");

  const criteriaList = f.criteria
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.id)}</code> ${escapeHtml(c.text)}${
          c.after !== undefined ? ` <span class="muted">(after ${escapeHtml(c.after)})</span>` : ""
        }</li>`,
    )
    .join("\n");

  const aiSummary =
    report.aiSummary !== undefined
      ? `<section class="card">
  <h2>AI summary <span class="muted">(additive — not a verdict)</span></h2>
  <p>${escapeHtml(report.aiSummary.text)}</p>
  <dl class="kv">
    <dt>Model</dt><dd>${escapeHtml(report.aiSummary.model)}</dd>
    <dt>Generated</dt><dd>${escapeHtml(report.aiSummary.generatedAt)}</dd>
    <dt>Cost</dt><dd>${escapeHtml(money(report.aiSummary.costUsd))}</dd>
  </dl>
</section>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ProofLoop report — ${escapeHtml(f.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(f.name)}</h1>
  ${description}
  <div class="card">
    <dl class="kv">
      <dt>Flow id</dt><dd><code>${escapeHtml(f.id)}</code></dd>
      <dt>Entry</dt><dd><code>${escapeHtml(f.entry)}</code></dd>
      <dt>Viewport</dt><dd>${escapeHtml(f.viewport)}</dd>
      <dt>Run id</dt><dd><code>${escapeHtml(report.source.runId)}</code></dd>
      <dt>Evaluation id</dt><dd><code>${escapeHtml(report.source.evaluationId)}</code></dd>
      <dt>Plan hash</dt><dd><code>${escapeHtml(report.source.planHash)}</code></dd>
      <dt>Schema versions</dt><dd>report ${escapeHtml(report.reportSchemaVersion)} ·
        run ${escapeHtml(report.source.runLogSchemaVersion)} ·
        evaluation ${escapeHtml(report.source.evaluationRecordSchemaVersion)} ·
        flow ${escapeHtml(report.source.flowPlanSchemaVersion)}</dd>
    </dl>
  </div>

  <h2>Outcome</h2>
  <div class="distinct">
    <div class="card">
      <div class="label">Execution status</div>
      <div class="value">${escapeHtml(ex.status)}</div>
      <p class="muted">Whether the run finished — independent of correctness.</p>
    </div>
    <div class="card">
      <div class="label">Flow verdict</div>
      <div class="value">${verdictBadge(ve.flowVerdict)}</div>
      <p class="muted">Whether the user-facing intent was achieved — judged by the verifier.</p>
    </div>
  </div>

  <h2>Flow steps</h2>
  <div class="card"><ol class="steps">
${steps}
  </ol></div>

  <h2>Acceptance criteria</h2>
  <div class="card"><ul class="criteria">
${criteriaList}
  </ul></div>

  <h2>Verification — per criterion</h2>
  <div class="card">
${ve.criteria.map(criterionSection).join("\n")}
  </div>

  <h2>Metrics</h2>
  <div class="grid">
    <div class="card">
      <h3>Executor / decider</h3>
      <dl class="kv">
        <dt>Execution status</dt><dd>${escapeHtml(ex.status)}</dd>
        <dt>Decider model</dt><dd><code>${ex.model !== undefined ? escapeHtml(ex.model) : "—"}</code></dd>
        <dt>Actions</dt><dd>${escapeHtml(ex.actionCount)}</dd>
        <dt>Errors</dt><dd>${escapeHtml(ex.errorCount)}</dd>
        <dt>Retries</dt><dd>${escapeHtml(ex.retryCount)}</dd>
        <dt>Input tokens</dt><dd>${ex.inputTokens !== undefined ? escapeHtml(ex.inputTokens) : "—"}</dd>
        <dt>Output tokens</dt><dd>${ex.outputTokens !== undefined ? escapeHtml(ex.outputTokens) : "—"}</dd>
        <dt>Cost</dt><dd>${escapeHtml(money(ex.costUsd))}</dd>
        <dt>Latency</dt><dd>${escapeHtml(ex.latencyMs)} ms</dd>
      </dl>
    </div>
    <div class="card">
      <h3>Verifier</h3>
      <dl class="kv">
        <dt>Flow verdict</dt><dd>${verdictBadge(ve.flowVerdict)}</dd>
        <dt>Verifier model</dt><dd><code>${escapeHtml(ve.model)}</code></dd>
        <dt>Evaluation id</dt><dd><code>${escapeHtml(report.source.evaluationId)}</code></dd>
        <dt>Input tokens</dt><dd>${escapeHtml(ve.inputTokens)}</dd>
        <dt>Output tokens</dt><dd>${escapeHtml(ve.outputTokens)}</dd>
        <dt>Cost</dt><dd>${escapeHtml(money(ve.costUsd))}</dd>
        <dt>Latency</dt><dd>${escapeHtml(ve.latencyMs)} ms</dd>
      </dl>
    </div>
  </div>

  <h2>Action timeline</h2>
  <div class="card">
    <table>
      <thead><tr><th>Seq</th><th>Type</th><th>Step</th><th>Step text</th><th>Detail</th></tr></thead>
      <tbody>
${timelineRows(report.timeline)}
      </tbody>
    </table>
  </div>

  ${aiSummary}

  <footer>Generated by ProofLoop from frozen run + evaluation artifacts. Evidence is citation-based;
  no screenshots, traces, or videos exist for these runs. This report re-states recorded verdicts and
  does not re-run the verifier.</footer>
</main>
</body>
</html>
`;
}
