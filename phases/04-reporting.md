# Phase 4 — Reporting (presentation layer) 📊

> **Goal:** Turn a finished run plus one explicitly selected evaluation record into a
> self-contained, evidence-backed report — machine-readable (`report.json`) and
> human-readable (`report.html`) — and a four-state comparison page for the demo.
> This phase is read-only over the existing Phase 3 artifacts and is **bounded to
> approximately one working day** for the presentation deadline.
>
> **Exit criterion:** A versioned `report.json` and self-contained `report.html` for each
> of the four approved Phase 3 runs, an optional additive AI summary, and a four-state
> comparison page carrying a visible “Phase 3 regression demonstration” caveat — all
> generated from existing artifacts and reviewed at one human gate.

---

## How to use this file

1. Read `../CLAUDE.md` first.
2. This phase is **read-only** over existing run and evaluation artifacts:

   * no browser execution;
   * no verifier execution;
   * no new verdict or scoring logic;
   * no edits to frozen Phase 1–3 contracts.
3. Work through the tasks in order and tick each `[ ]`.
4. There is one `🚦 HUMAN GATE`: the rendered-output review before presentation artifacts
   are committed.
5. Read the **Out of scope** section before starting. It is a hard fence.
6. If the deadline becomes tight, Task 1 and Task 3 are mandatory. The live AI-summary
   generation in Task 2 is optional.

---

## Input artifacts

For one report, the generator receives both:

```text
runId
evaluationId
```

The evaluation must never be selected implicitly by “latest,” directory order, or timestamp.
Phase 3 deliberately supports multiple evaluations against one frozen execution.

Inputs per report:

```text
platform/runs/<runId>/run.json
platform/runs/<runId>/events.jsonl
platform/runs/<runId>/evaluations/<evaluationId>/evaluation.json
fixtures/flows/<flowId>.flow.md
```

Supported versions:

* `runLogSchemaVersion`: `"1.0"` or `"1.1"` through the existing supported-version check;
* `evaluationRecordSchemaVersion`: `"1.0"`;
* `FlowPlan.schemaVersion`: the currently supported Phase 1 version.

Confirmed artifact behavior:

* `run.json.totals` contains executor/decider metrics such as:

  * model;
  * cost;
  * latency;
  * action count;
  * error count;
  * retry count.
* `evaluation.json` contains:

  * `flowVerdict`;
  * verifier model and parameters;
  * verifier usage, cost, and latency;
  * one evaluation per criterion;
  * observations and their harness-computed citation validations.
* `executionStatus` is independent from `flowVerdict`.
  A buggy run may complete execution successfully and still receive `FAIL`.
* On BUG-002:

  * C1 passes;
  * C2 fails because Tax is `$0.00` instead of 10% of Subtotal;
  * C3 passes because the displayed Total still equals Subtotal plus the displayed zero Tax.

Every per-criterion verdict must be rendered. Showing only the overall verdict would hide the
most important evidence that ProofLoop judges criteria independently.

---

## Approved Phase 3 demonstration runs

Task 0 must confirm these exact run directories remain present and readable:

| Display state                | Run ID                                          | Expected verdict |
| ---------------------------- | ----------------------------------------------- | ---------------: |
| Clean                        | `add-to-cart-2026-06-18T21-34-32-463Z-d1908fac` |           `PASS` |
| Renamed control              | `add-to-cart-2026-06-19T11-17-07-018Z-51cd9564` |           `PASS` |
| Broken tax                   | `add-to-cart-2026-06-19T11-21-55-992Z-57f2c78f` |           `FAIL` |
| Renamed control + broken tax | `add-to-cart-2026-06-19T11-23-44-691Z-8686ccd2` |           `FAIL` |

The exact approved `evaluationId` for each run must be read from disk and entered explicitly
into the presentation manifest. Do not assume every run uses `eval-001`.

No state may be re-executed during Phase 4. Missing artifacts are a blocking input problem to
report to the human, not permission to restart Phase 3 automatically.

---

## Decisions locked for this phase

### D26 — The report is complete without AI prose

`report.json` is a stable, versioned machine-readable projection of the existing run,
FlowPlan, and selected evaluation record.

The AI summary is optional and additive:

```ts
interface AiSummary {
  text: string;
  model: string;
  params: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd: number;
  latencyMs: number;
  generatedAt: string;
}
```

No verdict, comparison, Phase 7 score, or downstream parser may depend on the summary.

### D27 — The presentation manifest owns display labels

The comparison is built from a human-authored manifest under `presentation/`.

It maps display labels to:

```ts
{
  runId: string;
  evaluationId: string;
}
```

The platform must not infer bug or mutation state from run artifacts.

The manifest:

* is presentation metadata only;
* is never provided to the executor;
* is never provided to the verifier;
* is never used to create or modify verdicts;
* supplies only display labels, ordering, and explicit artifact selection.

### D28 — Artifact joins are explicit and fail loud

Before producing a report, assert all of the following:

* selected evaluation directory exists;
* `evaluation.runId === run.runId`;
* `evaluation.flowId === run.flowId`;
* `evaluation.planHash === run.planHash`;
* reparsing the current flow file produces the same `planHash`;
* every evaluation criterion ID exists exactly once in the FlowPlan;
* no FlowPlan criterion is silently omitted;
* each criterion’s `observations.length` equals its
  `citationValidations.length`;
* every cited snapshot ID belongs to that criterion’s recorded evidence set.

Any mismatch is a report-integrity error. Write neither `report.json` nor `report.html`.

Never silently choose another evaluation or zip arrays to the shorter length.

### D29 — All rendered artifact data is untrusted

Every artifact-derived string must be HTML-escaped, including:

* flow name and description;
* step and criterion text;
* verifier reasoning;
* observation labels and text;
* refs and snapshot IDs;
* page titles and URLs;
* event details;
* action values;
* failure details;
* model-generated summary text.

Reports read only already-scrubbed stored artifacts.

The renderer must not include:

* raw credentials;
* API keys;
* unsanitized failure details;
* external scripts;
* external stylesheets;
* external fonts;
* external fetches;
* executable inline JavaScript.

HTML uses inline CSS only.

### D30 — Evidence is citation-based

No screenshots, Playwright traces, or videos exist for these runs.

Evidence consists of the verifier’s recorded observations and harness-computed citation
validations:

* `observedText`;
* `ref`;
* `snapshotId`;
* `normalizedValue`, when present;
* `snapshotProvided`;
* `digestMatches`;
* `refPresent`;
* `observedTextPresent`;
* `valid`;
* validation reason, when present.

The report displays this evidence as recorded. It does not re-run the verifier or create a
new verdict.

### D31 — Execution and verification metrics stay separate

Display separate sections for:

**Executor / decider**

* execution status;
* decider model;
* action count;
* error count;
* retry count;
* token usage;
* cost;
* latency.

**Verifier**

* flow verdict;
* verifier model;
* evaluation ID;
* token usage;
* cost;
* latency.

Do not merge executor and verifier cost into a single unlabeled number.

---

## Report schema

Define a versioned report contract under `platform/src/`.

```ts
export const REPORT_SCHEMA_VERSION = "1.0";

export interface RunReport {
  reportSchemaVersion: "1.0";

  source: {
    runId: string;
    evaluationId: string;
    runLogSchemaVersion: string;
    evaluationRecordSchemaVersion: string;
    flowPlanSchemaVersion: string;
    planHash: string;
  };

  flow: {
    id: string;
    name: string;
    description?: string;
    entry: string;
    viewport: "desktop" | "mobile";
    steps: Array<{
      id: string;
      ordinal: number;
      text: string;
    }>;
    criteria: Array<{
      id: string;
      ordinal: number;
      text: string;
      after?: string;
    }>;
  };

  execution: {
    status: string;
    model?: string;
    actionCount: number;
    errorCount: number;
    retryCount: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd: number;
    latencyMs: number;
  };

  verification: {
    flowVerdict: "PASS" | "FAIL" | "INCONCLUSIVE";
    model: string;
    params: Record<string, unknown>;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    criteria: ReportCriterion[];
  };

  timeline: ReportTimelineEntry[];

  aiSummary?: AiSummary;
}
```

The exact final naming may follow existing platform conventions, but the semantic separation
above is mandatory.

The deterministic report without `aiSummary` must serialize with stable key ordering.

---

## Timeline rules

Build the timeline from `events.jsonl`.

Include relevant events such as:

* `step_start`;
* `action`;
* `step_end`;
* `error`;
* terminal flow status.

Runtime events may contain only `stepId` or a step-text hash. Display human-readable step text
by joining `event.stepId` back to the parsed `FlowPlan`.

Do not treat an LLM rationale as the canonical step description.

For action events, render only available recorded fields such as:

* step ID;
* action;
* ref;
* status;
* page URL;
* sequence number;
* scrubbed failure detail, when applicable.

Do not invent missing action values.

---

## Task checklist

### Task 0 — Confirm and freeze presentation inputs

* [x] Confirm all four approved run directories remain on disk.
* [x] Confirm each contains:

  * `run.json`;
  * `events.jsonl`;
  * its selected `evaluation.json`;
  * all snapshot blobs referenced by the selected evaluation.
* [x] Record the explicit approved `evaluationId` for each run.
* [x] Confirm every selected evaluation’s `runId`, `flowId`, and `planHash` match its run.
* [x] Confirm the current `add-to-cart.flow.md` still hashes to the recorded `planHash`.
* [x] Report the final four `{label, runId, evaluationId}` entries before implementation.

No re-execution is allowed in this phase.

#### Task 0 — recorded findings (read-only provenance audit, human-approved 2026-06-19)

This audit was a documentation-only filesystem read. **No state was re-executed, no
verifier or LLM was called, and no bug-state inference was added to production code.**
Bug/mutation state is *recognised here for the record only*; the platform never infers it
(D27). All four runs share `flowId = add-to-cart` and
`planHash = sha256:ad29fd82a319402998f7c169321d47e49fcf84d188e0cdb74820d47e049f1352`.

**The four frozen `{label, runId, evaluationId}` selections:**

| Label                        | runId                                           | evaluationId |
| ---------------------------- | ----------------------------------------------- | ------------ |
| Clean                        | `add-to-cart-2026-06-18T21-34-32-463Z-d1908fac` | `eval-001`   |
| Renamed control              | `add-to-cart-2026-06-19T11-17-07-018Z-51cd9564` | `eval-001`   |
| Broken tax                   | `add-to-cart-2026-06-19T11-21-55-992Z-57f2c78f` | `eval-001`   |
| Renamed control + broken tax | `add-to-cart-2026-06-19T11-23-44-691Z-8686ccd2` | `eval-001`   |

Each run directory exists and is readable, and each contains `run.json`, `events.jsonl`,
the selected `evaluations/eval-001/evaluation.json`, and all snapshot blobs cited by that
evaluation. Each run holds exactly one evaluation (`eval-001`); the explicit id was read
from disk, **not** assumed.

**Integrity checks — all PASS for every run:**

* `evaluation.runId === run.runId`, `evaluation.flowId === run.flowId`,
  `evaluation.planHash === run.planHash` — match in all four.
* Re-parsing the current `fixtures/flows/add-to-cart.flow.md` and recomputing
  `computePlanHash` reproduces the recorded `planHash`
  (`sha256:ad29fd82…f1352`) for all four runs (D24/D28 would pass).

**Per-run observed evidence (add-control label, opposite-label absence, Tax, verdict):**

| Label | runId (short) | Add-control label | Opposite label | Clicked refs (Desk Lamp / Coffee Mug) | Tax (terminal cart) | flowVerdict |
| --- | --- | --- | --- | --- | --- | --- |
| Clean | `d1908fac` | `Add to Cart` | `Add to Bag` absent (0 snapshots) | `e35` (Qty `e34`←"2") / `e42` | `$5.90` | **PASS** |
| Renamed control | `51cd9564` | `Add to Bag` | `Add to Cart` absent (0 snapshots) | `e35` (Qty `e34`←"2") / `e42` | `$5.90` | **PASS** |
| Broken tax | `57f2c78f` | `Add to Cart` | `Add to Bag` absent (0 snapshots) | `e35` (Qty `e34`←"2") / `e42` | `$0.00` | **FAIL** |
| Renamed control + broken tax | `8686ccd2` | `Add to Bag` | `Add to Cart` absent (0 snapshots) | `e35` (Qty `e34`←"2") / `e42` | `$0.00` | **FAIL** |

Per-criterion shape confirmed in every run: C1 PASS, C3 PASS, and C2 is the FAIL driver
under the broken-tax states (Tax `$0.00 ≠ $5.90`) — the proportional rule is the catcher,
not the `Subtotal + Tax == Total` reconcile invariant. "Desk Lamp ×2" was achieved as
Qty `e34`←"2" plus one click on add-control `e35` (not two clicks); Coffee Mug was a
single click on add-control `e42`.

**This mapping was verified manually from the stored snapshots and action events.** It is
documentation only; nothing here introduces automatic bug-state inference into the
execution, verification, or reporting pipelines. It matches both the human-approved Phase 3
matrix and the matrix recorded in `phases/03-outcome-verification.md` with no discrepancy.

---

### Task 1 — Deterministic report generator

*This is the must-have deliverable. If time runs out, ship this and the comparison without
live AI summaries.*

* [ ] Implement a report CLI requiring explicit artifact selection:

```bash
npm run report -- --run <runId> --evaluation <evaluationId>
```

* [ ] Do not default to the newest or highest evaluation.
* [ ] Read:

  * `run.json`;
  * `events.jsonl`;
  * the explicitly selected `evaluation.json`;
  * the parsed FlowPlan.
* [ ] Perform every D28 integrity assertion before writing output.
* [ ] Emit:

```text
platform/runs/<runId>/reports/<evaluationId>/report.json
platform/runs/<runId>/reports/<evaluationId>/report.html
```

These generated run-local reports remain gitignored.

* [ ] `report.json` must:

  * use `REPORT_SCHEMA_VERSION = "1.0"`;
  * be complete without an AI summary;
  * preserve all per-criterion verdicts and evidence;
  * use stable key ordering;
  * contain no newly invented verdicts.
* [ ] `report.html` must display:

  * flow name and metadata;
  * the natural-language flow steps (verbatim except for deterministic secret redaction);
  * the original natural-language criteria (verbatim except for deterministic secret redaction);
  * execution status and flow verdict as visibly distinct concepts;
  * every criterion verdict;
  * verifier reasoning;
  * every observation paired with its matching citation validation;
  * decider and verifier metrics separately;
  * the action timeline.
* [ ] Render `normalizedValue` only when present.
* [ ] Render invalid citation checks visibly rather than hiding them.
* [ ] HTML-escape every artifact-derived value.
* [ ] Use inline CSS only and no scripts or external resources.
* [ ] Accept both run-log versions `"1.0"` and `"1.1"` through the existing supported-version
  mechanism.
* [ ] Tests:

  * valid PASS report;
  * valid FAIL report;
  * execution completed with flow verdict FAIL;
  * explicit evaluation selection;
  * multiple evaluations without explicit selection are never silently resolved;
  * run/evaluation ID mismatch fails;
  * flow ID mismatch fails;
  * plan-hash mismatch fails;
  * missing criterion fails;
  * duplicate criterion fails;
  * observation/citation length mismatch fails;
  * HTML escaping covers flow text, evidence, reasoning, event details, and summary text;
  * deterministic report JSON is byte-identical across two runs;
  * no live LLM calls.

✅ **COMMIT:** `feat(platform): deterministic run report generator (json + html)`

---

### Task 2 — Optional grounded AI summary

*Additive and droppable under the deadline.*

* [ ] Summary generation is opt-in only:

```bash
npm run report -- --run <runId> --evaluation <evaluationId> --summary
```

Ordinary report generation must make no LLM call.

* [ ] Require an explicitly configured summary model, for example:

```text
PROOFLOOP_SUMMARY_MODEL
```

Do not silently default to an expensive model.

* [ ] Make one bounded call per selected report, with no automatic retries.
* [ ] Ground the summary only in the already-built structured report projection:

  * flow name;
  * execution status;
  * recorded overall verdict;
  * recorded criterion verdicts;
  * recorded reasoning;
  * recorded validated observations.
* [ ] Do not provide raw snapshots, decider rationales, bug-state labels, expected verdicts,
  or the bug ledger.
* [ ] Instruct the model to:

  * report the existing verdicts;
  * not re-evaluate;
  * not change or infer a verdict;
  * explain failed or inconclusive criteria in plain language;
  * avoid claims about platform-wide accuracy.
* [ ] Store the result only in the optional `aiSummary` section, including:

  * exact model;
  * parameters;
  * token usage;
  * cost;
  * latency;
  * timestamp.
* [ ] If the call fails:

  * preserve the complete deterministic report;
  * record or report the summary-generation failure separately;
  * do not convert the run to `INCONCLUSIVE`;
  * do not block HTML generation.
* [ ] Tests use mocked summary responses only.
* [ ] At most one live summary call per approved demo run.
* [ ] No automatic retries.

✅ **COMMIT:** `feat(platform): optional grounded AI summary section`

---

### Task 3 — Four-state comparison page

* [x] Add a tracked presentation manifest, for example:

```text
presentation/phase3-demo-manifest.json
```

with its own small version field:

```json
{
  "schemaVersion": "1.0",
  "title": "Phase 3 regression demonstration",
  "runs": [
    {
      "label": "Clean",
      "runId": "...",
      "evaluationId": "..."
    },
    {
      "label": "Renamed control",
      "runId": "...",
      "evaluationId": "..."
    },
    {
      "label": "Broken tax",
      "runId": "...",
      "evaluationId": "..."
    },
    {
      "label": "Renamed control + broken tax",
      "runId": "...",
      "evaluationId": "..."
    }
  ]
}
```

* [x] The manifest must not contain:

  * expected verdicts;
  * bug-ledger data;
  * verifier instructions;
  * anything consumed by the execution or evaluation pipeline.
* [x] Build the comparison only from the four selected generated reports.
* [x] Add a comparison CLI such as:

```bash
npm run report:compare -- --manifest ../presentation/phase3-demo-manifest.json
```

* [x] Generate one self-contained comparison page showing:

  * display label;
  * run ID and evaluation ID;
  * execution status;
  * flow verdict;
  * per-criterion verdicts;
  * decider cost;
  * verifier cost;
  * links or relative references to the committed per-run HTML reports.
* [x] Emphasize that all four executions completed while only the behaviorally buggy states
  failed verification.
* [x] Include the catcher-criterion contrast when time permits:

  * correct Tax evidence → PASS;
  * `$0.00` Tax evidence → FAIL.
* [x] Embed this visible caveat inside the page:

> This is a focused Phase 3 regression demonstration. It shows that ProofLoop adapted to
> one harmless structural change while still detecting one targeted behavioral regression.
> It is not a platform-wide accuracy result across the complete bug ledger. Broader accuracy,
> false-pass/false-fail measurement, and reliability evaluation belong to Phases 7–8.

* [x] Label the section exactly:

```text
Phase 3 regression demonstration
```

Never label it “accuracy results.”

* [x] Escape every manifest-derived and report-derived string.
* [x] Use inline CSS only; no scripts or external resources.

> **Generator committed; presentation artifacts deferred.** The comparison generator
> (manifest schema/loader, builder, renderer, CLI, tests + test fixture) is committed as the
> platform source below. The *tracked* presentation manifest, `comparison.html`, and the
> copied per-run reports under `presentation/runs/` are produced for the Task 4 rendered-output
> human gate and are NOT committed before that review.

✅ **COMMIT:** `feat(platform): four-state Phase 3 regression comparison page`

---

### Task 4 — Rendered-output review and presentation artifacts

* [ ] Generate the four selected reports locally from the gitignored run artifacts.
* [ ] Copy only the approved presentation projections into the tracked presentation tree:

```text
presentation/
├── phase3-demo-manifest.json
├── comparison.html
└── runs/
    ├── clean/
    │   ├── report.json
    │   └── report.html
    ├── renamed-control/
    │   ├── report.json
    │   └── report.html
    ├── broken-tax/
    │   ├── report.json
    │   └── report.html
    └── renamed-control-broken-tax/
        ├── report.json
        └── report.html
```

* [ ] Confirm copied artifacts contain no raw secrets or unsanitized failure details.
* [ ] Confirm HTML opens locally with the network disabled.
* [ ] Confirm relative links remain valid.
* [ ] Confirm reports remain understandable without the AI summary.
* [ ] If summaries were generated, review every sentence for:

  * verdict drift;
  * unsupported accuracy claims;
  * invented evidence;
  * language implying the summary made the verdict.

🚦 **HUMAN GATE:** The human reviews:

* all four rendered per-run reports;
* the comparison page;
* the visible caveat;
* summary wording, when present;
* presentation styling;
* secret/redaction checks.

Do not self-certify or commit presentation artifacts before approval.

✅ **COMMIT:** `docs(presentation): commit Phase 3 demo reports + comparison`

---

## Out of scope

* ❌ Phase 5 headed/headless parity.
* ❌ Phase 6 CI, PR comments, trace, or video.
* ❌ Full Phase 7 scoring or bug-ledger accuracy results.
* ❌ Phase 8 repeated-run reliability analysis.
* ❌ BUG-007 live demonstration.
* ❌ Any new browser execution or verifier execution.
* ❌ Any new verdict, scoring, or citation-validation logic.
* ❌ Edits to frozen Phase 1–3 contracts.
* ❌ Screenshots, traces, or video.
* ❌ React or another standalone frontend.
* ❌ Dashboard, server, database, routing, authentication, accounts, run history, real-time
  views, WebSockets, flow editor, or collaboration.
* ❌ External scripts, stylesheets, fonts, or fetches.
* ❌ Live LLM calls in tests.
* ❌ Inferring bug state from run artifacts.
* ❌ Automatically selecting the latest evaluation.
* ❌ Re-executing a state because a presentation artifact is missing.

---

## Exit checklist

* [ ] Four explicit `{runId, evaluationId}` pairs confirmed and integrity-checked.
* [ ] Versioned, deterministic `report.json` generated for all four runs.
* [ ] Self-contained `report.html` generated for all four runs.
* [ ] Reports remain complete without AI summaries.
* [ ] AI summaries, when present, are optional, grounded, one-call-only, and metadata-complete.
* [ ] Run/evaluation/flow/plan joins validated; mismatches fail loud.
* [ ] Every criterion is present exactly once.
* [ ] Every observation is paired 1:1 with its citation validation.
* [ ] Every artifact-derived string is HTML-escaped.
* [ ] No external resources or executable scripts.
* [ ] No raw credentials, API keys, or unsanitized failure details.
* [ ] Execution status and flow verdict are visually distinct.
* [ ] Decider and verifier cost/latency are displayed separately.
* [ ] Timeline step text is joined from the FlowPlan by `stepId`.
* [ ] Comparison page uses only the human-authored presentation manifest and selected reports.
* [ ] Visible Phase 3 demonstration caveat is present.
* [ ] Comparison is not labelled as platform accuracy.
* [ ] Tests use mocked summaries and pass.
* [ ] `npm test` passes.
* [ ] `npm run typecheck` passes.
* [ ] Presentation artifacts reviewed by the human and committed to the agreed path.

---

## Risks

1. **Selecting the wrong evaluation.**
   One run may contain multiple evaluation records. Require an explicit `evaluationId`; never
   guess “latest.”

2. **Mismatched artifacts.**
   A report joining an evaluation to the wrong run or FlowPlan can look convincing while being
   false. Assert `runId`, `flowId`, criterion IDs, and `planHash`.

3. **Observation/citation misalignment.**
   Parallel arrays must be the same length. Never silently truncate with `zip`-style behavior.

4. **Unescaped untrusted strings.**
   Page content, event details, verifier reasoning, and summary text may contain HTML or
   instruction-like content. Escape everything.

5. **The summary re-judging instead of reporting.**
   The summary is prose over recorded results, never a second verifier.

6. **Conflating execution completion with correctness.**
   All four demo executions completed. Two still failed verification. Preserve that distinction.

7. **Black-box leakage through presentation metadata.**
   State labels belong only to the tracked presentation manifest and never enter the execution
   or verification pipeline.

8. **Over-polishing under the deadline.**
   Deterministic reports and the comparison page are mandatory. Live AI summaries and
   catcher-value styling are optional.

9. **Accidental live spend.**
   Report generation must be offline by default. Summary generation requires an explicit flag
   and explicitly configured model.

10. **Turning the demonstration into an accuracy claim.**
    The four-state page proves one focused regression trap, not platform-wide bug-detection
    accuracy.
