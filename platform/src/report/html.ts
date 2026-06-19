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
import { criterionLabel } from "./labels";
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

/** A coloured verdict pill. Relies on the `.verdict-*` CSS classes (present in both page styles). */
export function verdictBadge(verdict: string): string {
  const cls = VERDICT_CLASS[verdict] ?? "verdict-inconclusive";
  return `<span class="badge ${cls}">${escapeHtml(verdict)}</span>`;
}

/** Display formatting only — 4 decimals. `report.json` retains full-precision cost numbers. */
function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Human labels for the four citation checks — used to name a FAILED check explicitly. */
const CHECK_LABELS: Array<[keyof CitationValidation, string]> = [
  ["snapshotProvided", "snapshot provided"],
  ["digestMatches", "digest matches"],
  ["refPresent", "ref present"],
  ["observedTextPresent", "observed text present"],
];

/**
 * Render the citation status for one observation. A valid citation collapses to "✓ Validated";
 * an invalid one shows "✕ Invalid" and lists exactly which checks failed (plus any reason).
 * The full boolean structure stays in `report.json` — this is the HTML summary of it.
 */
function citationStatus(v: CitationValidation): string {
  if (v.valid) return `<span class="check-ok">✓ Validated</span>`;
  const failed = CHECK_LABELS.filter(([k]) => v[k] === false).map(([, label]) => label);
  if (v.reason !== undefined && v.reason !== "") failed.push(escapeHtml(v.reason));
  const list =
    failed.length > 0
      ? `<ul class="failed-checks">${failed.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
      : "";
  return `<span class="check-bad">✕ Invalid</span>${list}`;
}

function evidenceRows(
  observations: Observation[],
  validations: CitationValidation[],
): string {
  // observations.length === validations.length is asserted at build time (D28).
  if (observations.length === 0) {
    return `<tr><td colspan="4" class="muted">No observations recorded for this criterion.</td></tr>`;
  }
  return observations
    .map((o, i) => {
      const v = validations[i];
      const rowClass = v.valid ? "" : ' class="citation-invalid"';
      const normalized =
        o.normalizedValue !== undefined
          ? `<div class="normalized">normalized: ${escapeHtml(o.normalizedValue)}</div>`
          : "";
      return `<tr${rowClass}>
  <td>${escapeHtml(o.label)}</td>
  <td><code>${escapeHtml(o.observedText)}</code>${normalized}</td>
  <td><code>${escapeHtml(o.snapshotId)}</code> · <code>${escapeHtml(o.ref)}</code></td>
  <td>${citationStatus(v)}</td>
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
  // The failed criterion is accented (left burgundy bar + tint) so it stands out, while the
  // passing criteria stay fully visible alongside it.
  const sectionClass = c.verdict === "FAIL" ? "criterion criterion-fail" : "criterion";
  return `<section class="${sectionClass}">
  <h3><span class="criterion-title">${escapeHtml(criterionLabel(c.criterionId))}</span>
    <code class="cid">${escapeHtml(c.criterionId)}</code> ${verdictBadge(c.verdict)}</h3>
  <p class="criterion-text">${escapeHtml(c.text)}</p>
  ${inconclusive}
  <p class="reasoning"><strong>Verifier reasoning:</strong> ${escapeHtml(c.reasoning) || '<span class="muted">(none recorded)</span>'}</p>
  <div class="table-wrap">
  <table class="evidence">
    <thead>
      <tr><th>Evidence label</th><th>Observed value / text</th><th>Snapshot · ref</th><th>Citation status</th></tr>
    </thead>
    <tbody>
${evidenceRows(c.observations, c.citationValidations)}
    </tbody>
  </table>
  </div>
</section>`;
}

/**
 * Compact step-level timeline derived (render-time only) from the full event timeline: one row
 * per flow step, summarising the actions performed and whether the step completed. The full
 * event-level trail remains available verbatim in the "Full execution audit trail" details.
 */
function stepSummaryRows(timeline: ReportTimelineEntry[]): string {
  interface StepRow {
    ordinal?: number;
    stepId: string;
    stepText?: string;
    actions: string[];
    completed: boolean;
  }
  const byStep = new Map<string, StepRow>();
  const order: string[] = [];
  const ensure = (stepId: string, stepText?: string, ordinal?: number): StepRow => {
    let row = byStep.get(stepId);
    if (!row) {
      row = { ordinal, stepId, stepText, actions: [], completed: false };
      byStep.set(stepId, row);
      order.push(stepId);
    }
    if (ordinal !== undefined) row.ordinal = ordinal;
    if (stepText !== undefined) row.stepText = stepText;
    return row;
  };
  for (const e of timeline) {
    if (e.stepId === undefined) continue;
    const row = ensure(e.stepId, e.stepText, e.ordinal);
    if (e.type === "action") {
      row.actions.push(`${e.action ?? "action"} ${e.ref ?? ""} (${e.status ?? "?"})`.trim());
    } else if (e.type === "step_end") {
      row.completed = true;
    }
  }
  if (order.length === 0) {
    return `<tr><td colspan="3" class="muted">No step events recorded.</td></tr>`;
  }
  return order
    .map((id) => {
      const r = byStep.get(id)!;
      const label =
        (r.ordinal !== undefined ? `${escapeHtml(r.ordinal)}. ` : "") +
        (r.stepText !== undefined ? escapeHtml(r.stepText) : `<code>${escapeHtml(r.stepId)}</code>`);
      const actions =
        r.actions.length > 0
          ? r.actions.map((a) => `<code>${escapeHtml(a)}</code>`).join("<br>")
          : '<span class="muted">— (navigation / no element action)</span>';
      const status = r.completed
        ? `<span class="badge badge-neutral">completed</span>`
        : `<span class="muted">—</span>`;
      return `<tr><td>${label}</td><td>${actions}</td><td>${status}</td></tr>`;
    })
    .join("\n");
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
  html, body { max-width: 100%; overflow-x: hidden; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 2rem; color: #2b2226; background: #f7efe3; line-height: 1.5; }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; color: #6e1f2a; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; border-bottom: 2px solid #e2cdbf; padding-bottom: .3rem; color: #6e1f2a; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .4rem; color: #6e1f2a; }
  code { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: .85em;
    background: #f1e4d6; padding: .05rem .3rem; border-radius: 3px; }
  .card { background: #fffdf8; border: 1px solid #e2cdbf; border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
  .kv dt { color: #6b5a52; }
  .kv dd { margin: 0; font-weight: 600; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem;
    font-weight: 700; letter-spacing: .03em; vertical-align: middle; }
  .verdict-pass { background: #e6f4ea; color: #1a7f37; border: 1px solid #acd8b8; }
  .verdict-fail { background: #fce8e6; color: #cf222e; border: 1px solid #f1b0aa; }
  .verdict-inconclusive { background: #fff4e5; color: #9a6700; border: 1px solid #f0cd8a; }
  .badge-neutral { background: #efe1d0; color: #5b4636; border: 1px solid #d8c0a6; }
  .hero { border-left: 5px solid #6e1f2a; }
  .hero-items { display: flex; gap: 2rem; flex-wrap: wrap; }
  .hero-item .label { font-size: .8rem; color: #6b5a52; text-transform: uppercase; letter-spacing: .04em; }
  .hero-item .value { font-size: 1.25rem; font-weight: 700; margin-top: .2rem; }
  .hero-note { margin: .75rem 0 0; }
  details.tech { background: #fffdf8; border: 1px solid #e2cdbf; border-radius: 8px; padding: .5rem 1rem; margin: 0 0 1rem; }
  details.tech summary { cursor: pointer; color: #6e1f2a; font-weight: 600; }
  details.tech[open] summary { margin-bottom: .5rem; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { border: 1px solid #e2cdbf; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f3e7d9; font-weight: 600; color: #6e1f2a; }
  .check-ok { color: #1a7f37; font-weight: 700; }
  .check-bad { color: #cf222e; font-weight: 700; }
  .failed-checks { margin: .25rem 0 0; padding-left: 1.1rem; font-size: .78rem; color: #cf222e; }
  tr.citation-invalid { background: #fbeef0; }
  .muted { color: #6b5a52; }
  .normalized, .reason, .detail { font-size: .78rem; color: #6b5a52; margin-top: .2rem; }
  .detail.failure { color: #cf222e; }
  .reasoning, .criterion-text { margin: .3rem 0; }
  .criterion { padding: .25rem 0; }
  .criterion + .criterion { border-top: 1px solid #eaddcc; margin-top: .5rem; padding-top: .75rem; }
  .criterion-fail { border-left: 4px solid #cf222e; background: #fdf3f3; border-radius: 6px;
    padding: .25rem .75rem .5rem; margin-top: .75rem; }
  .criterion-title { font-size: 1.05rem; }
  code.cid { font-size: .72rem; color: #6b5a52; background: transparent; }
  .inconclusive-detail { background: #fbeede; border: 1px solid #dcae8f; padding: .4rem .6rem; border-radius: 6px; }
  .aisummary { border-left: 5px solid #6e1f2a; }
  .ai-banner { background: #fbeede; border: 1px solid #dcae8f; border-radius: 6px;
    padding: .5rem .75rem; margin: 0 0 .6rem; font-size: .85rem; color: #5b3a2a; }
  .ai-text { white-space: pre-wrap; margin: 0 0 .6rem; }
  ol.steps li, ul.criteria li { margin: .25rem 0; }
  code.break { overflow-wrap: anywhere; word-break: break-all; }
  footer { color: #6b5a52; font-size: .8rem; margin-top: 2rem; }
  @media (max-width: 700px) {
    body { padding: 1rem; }
    .grid { grid-template-columns: 1fr; }
    .hero-items { gap: 1rem; }
  }
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

  // The banner is a HARDCODED template literal (no interpolated artifact data, D29). Only the
  // summary body and metadata are interpolated, and they are escaped. Absent when no aiSummary.
  const aiSummary =
    report.aiSummary !== undefined
      ? `<h2>AI summary</h2>
  <section class="card aisummary">
    <p class="ai-banner"><strong>AI-generated narrative.</strong> The recorded verdicts and evidence in this report are authoritative. This summary describes them and does not determine them.</p>
    <p class="ai-text">${escapeHtml(report.aiSummary.text)}</p>
    <dl class="kv">
      <dt>Model</dt><dd><code>${escapeHtml(report.aiSummary.model)}</code></dd>
      <dt>Prompt version</dt><dd>${escapeHtml(String(report.aiSummary.params.promptVersion ?? "—"))}</dd>
      <dt>Tokens</dt><dd>${escapeHtml(report.aiSummary.usage.inputTokens)} in / ${escapeHtml(report.aiSummary.usage.outputTokens)} out</dd>
      <dt>Cost</dt><dd>${escapeHtml(money(report.aiSummary.costUsd))}</dd>
      <dt>Latency</dt><dd>${escapeHtml(report.aiSummary.latencyMs)} ms</dd>
      <dt>Generated</dt><dd>${escapeHtml(report.aiSummary.generatedAt)}</dd>
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

  <div class="card hero">
    <div class="hero-items">
      <div class="hero-item">
        <div class="label">Execution status</div>
        <div class="value"><span class="badge badge-neutral">${escapeHtml(ex.status)}</span></div>
      </div>
      <div class="hero-item">
        <div class="label">Flow verdict</div>
        <div class="value">${verdictBadge(ve.flowVerdict)}</div>
      </div>
    </div>
    <p class="muted hero-note">Execution completion and verification correctness are independent:
    a run can finish successfully and still fail verification.</p>
  </div>

  <details class="tech">
    <summary>Technical run details</summary>
    <dl class="kv">
      <dt>Run id</dt><dd><code class="break">${escapeHtml(report.source.runId)}</code></dd>
      <dt>Evaluation id</dt><dd><code>${escapeHtml(report.source.evaluationId)}</code></dd>
      <dt>Plan hash</dt><dd><code class="break">${escapeHtml(report.source.planHash)}</code></dd>
      <dt>Schema versions</dt><dd>report ${escapeHtml(report.reportSchemaVersion)} ·
        run ${escapeHtml(report.source.runLogSchemaVersion)} ·
        evaluation ${escapeHtml(report.source.evaluationRecordSchemaVersion)} ·
        flow ${escapeHtml(report.source.flowPlanSchemaVersion)}</dd>
      <dt>Entry</dt><dd><code>${escapeHtml(f.entry)}</code></dd>
      <dt>Viewport</dt><dd>${escapeHtml(f.viewport)}</dd>
      <dt>Flow id</dt><dd><code>${escapeHtml(f.id)}</code></dd>
    </dl>
  </details>

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

  <h2>Timeline</h2>
  <div class="card">
    <div class="table-wrap">
    <table>
      <thead><tr><th>Step</th><th>Actions performed</th><th>Status</th></tr></thead>
      <tbody>
${stepSummaryRows(report.timeline)}
      </tbody>
    </table>
    </div>
    <details class="tech">
      <summary>Full execution audit trail</summary>
      <div class="table-wrap">
      <table>
        <thead><tr><th>Seq</th><th>Type</th><th>Step</th><th>Step text</th><th>Detail</th></tr></thead>
        <tbody>
${timelineRows(report.timeline)}
        </tbody>
      </table>
      </div>
    </details>
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
