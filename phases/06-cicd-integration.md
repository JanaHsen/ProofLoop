# Phase 6 — DevOps-Ready CI/CD Integration 🔄

> **Goal:** The platform runs itself automatically when the application or tester
> changes, executes the five canonical flows against a freshly-booted clean SUT,
> aggregates the results deterministically, posts one sticky report on the pull
> request, and turns the check red when any flow is not `PASS` — with zero manual
> steps between trigger and report, and the merge decision left to a human.
>
> **Exit criterion:** A path-filtered `pull_request` (same-repository) **or** a
> `workflow_dispatch` run boots the SUT, runs → verifies → reports all five flows
> serially, produces a deterministic `summary.json` / `summary.md`, uploads every
> artifact that exists (even on a non-green verdict), upserts one marker-based PR
> comment, and exits non-zero unless every flow is `PASS`. The only repository
> secret is `ANTHROPIC_API_KEY`. The workflow is **not** registered as a
> branch-protection required check.

---

## How to use this file

1. Read `../CLAUDE.md` first. The cross-cutting rules there are in force here, in
   particular: **never guess a selector**, **black-box boundary = the URL**,
   **secrets by layer**, **execution mode is launch-seam only**, and
   **never auto-merge**.
2. This phase is **mostly additive plumbing**, not a rewrite. It edits the
   Phase 2/3 CLI *entry files* only at their **argument surface and process exit
   code** (Task 1). It must **not** touch the frozen run-log schema, the execution
   loop, the verifier logic, the parser, or any verdict/scoring/citation logic.
3. Work through the tasks in order and tick each `[ ]`.
4. There are **two** `🚦 HUMAN GATE`s:
   * **CLI process contract** — after Task 0, before Task 1: the human freezes the
     exit-code and `--id-file` contract before any older entry point is changed.
   * **Live-CI review** — after the workflow exists on `workflow_dispatch` only and
     before the `pull_request` trigger is wired on; *real, not retrospective*, the
     human approves the first real model spend in CI before it can fire on PRs.
5. Read the **Out of scope** section before starting. It is a hard fence.
6. Commit at every `✅ COMMIT` checkpoint with the suggested message.

---

## Context — what already exists (do not rebuild)

* **Three separate CLIs**, each requiring explicit selection (no "latest"):
  * `npm run run -- <flow>` → executes a flow, writes `platform/runs/<runId>/`,
    prints `runId=…` to stdout. **Headless by default** (Phase 5); `--headed` is the
    only mode override.
  * `npm run verify -- --run <runId>` → grades the completed run, writes
    `platform/runs/<runId>/evaluations/<evaluationId>/evaluation.json`, prints the
    `flowVerdict` and `<evaluationId>: <path>` to stdout.
  * `npm run report -- --run <runId> --evaluation <evaluationId>` → writes
    `platform/runs/<runId>/reports/<evaluationId>/report.{json,html}` (deterministic;
    `--summary` is opt-in and **stays off in CI**).
* `run` and `verify` load env via `--env-file-if-exists=../.env`, which is a clean
  no-op when no `.env` is present (CI injects env directly). `report` makes no LLM
  call by default.
* **The SUT (`app/`)** boots via `npm start` (ts-node). Config from env:
  `APP_PORT` (default 3000), `PROOFLOOP_BUGS` (comma-separated toggles; empty =
  clean), `PROOFLOOP_DEBUG_TOKEN` (gates `/debug/*`; empty ⇒ those routes 404; the
  engine never sends it), `SESSION_SECRET`. Health: `GET /health` → `{status:"ok"}`,
  pollable immediately.
* **The five canonical flows** are black-box and intent-first; none targets `/debug`.
  Under a clean SUT all five must `PASS`. Ground truth (`bug-ledger.yaml`,
  `flow-coverage.md`) is **never** handed to the tester.
* **No `.github/workflows/` content exists** — the directory is an empty Phase-0
  scaffold. This phase is greenfield CI.
* **No monorepo root** `package.json`. `app/` and `platform/` install independently.

---

## Decisions locked for this phase

### D38 — Recorded terminal states are data; only un-producible artifacts are failures
Process exit codes encode *whether the requested artifact was produced and can be
trusted*, never the favourability of the outcome.

* `run-cli` exits `0` when it creates and finalizes a trustworthy run artifact and
  writes the `runId` — **even when the recorded execution status is `blocked`,
  `guard_tripped`, `error`, or `cancelled`.**
* `verify-cli` exits `0` when it writes a trustworthy evaluation record —
  **regardless of `PASS`, `FAIL`, or `INCONCLUSIVE`.**
* `report-cli` exits `0` when it writes a valid deterministic report.
* **Non-zero** is reserved for: invalid arguments, missing/invalid configuration,
  missing or malformed input artifacts, plan-hash mismatch, unsupported schema
  version, write failure, or an uncaught crash.

Task 1 tests every branch above explicitly. This contract is the load-bearing
reason the CI loop can record a failing flow and **still run the remaining flows**.

### D39 — Machine-readable ID emission via `--id-file`
`run-cli` and `verify-cli` gain an optional `--id-file <path>` that writes **only**
the id (the `runId` / `evaluationId`, no decoration). CI threads ids through these
files rather than scraping human-facing stdout. Chosen over `--github-output` to stay
CI-provider-neutral. Stdout human lines are unchanged (back-compatible).

### D40 — Static CI flow manifest at `platform/config/ci-flows.json`
The set of flows CI runs lives in committed **platform execution config**, not in
`.github/`, so it can be validated and run locally. It contains a `schemaVersion` and
an **ordered list of flow paths only** — no expected verdicts, bug IDs, selectors,
labels, or ledger data (D12 stays intact).

### D41 — Env partitioning is the black-box boundary, enforced operationally
The tester process and the SUT process receive **disjoint** environment:

| Variable | SUT boot | Tester (run/verify/report) | Notes |
|---|:---:|:---:|---|
| `ANTHROPIC_API_KEY` | ❌ | ✅ | The only repository secret. |
| `BASE_URL` | ❌ | ✅ | The only thing the tester learns about the SUT. |
| `PROOFLOOP_VERIFIER_MODEL` | ❌ | ✅ | Config, not secret. |
| Executor model configuration | ❌ | ✅ *if runtime-configurable* | Use the exact production source identified in Task 0 (env var, default, or resolver). **Do not invent a duplicate CI-only variable.** |
| `PROOFLOOP_BUGS` | ✅ | ❌ | Empty for PR runs; optional for dispatch. SUT-only. |
| `SESSION_SECRET` | ✅ | ❌ | Generated ephemerally per CI run, not stored. |
| `PROOFLOOP_DEBUG_TOKEN` | ❌ | ❌ | Not needed; not a secret; never passed anywhere. |
| `APP_PORT` | ✅ | ➖ | SUT binds it; tester reaches it only via `BASE_URL`. |

Passing `PROOFLOOP_BUGS` or `PROOFLOOP_DEBUG_TOKEN` into any tester step is a
black-box violation and a gate-blocking defect.

### D42 — Verdict → check status (`allPass` is the only gate input)
Green **iff every selected flow produced a `PASS` verdict**. `FAIL`, `INCONCLUSIVE`,
and pipeline `ERROR` (no verdict produced) are all non-green. The final enforcement
step reads **only** `summary.json.allPass`; it never parses Markdown and never
re-derives a verdict. The comment/summary must visibly distinguish a **detected
behavioral regression (`FAIL`)** from **"the platform could not clear this change"
(`INCONCLUSIVE` / pipeline `ERROR`)**.

> Note on terminology (consistency with D11): a *flow verdict* is one of
> `PASS`/`FAIL`/`INCONCLUSIVE`, where a verifier `ERROR` is a reason **under**
> `INCONCLUSIVE`. The CI aggregate's `counts.error` is a **different** thing — it
> counts flows where the pipeline produced **no verdict at all** (app not ready,
> run/verify/report exited non-zero). A flow that produced an `INCONCLUSIVE` verdict
> counts under `inconclusive`, never under `error`.

### D43 — Runtime `ci-results.json` ledger + deterministic `report:ci`
The workflow maintains a runtime ledger with **one entry per configured flow**,
updated as each flow advances. `report:ci` consumes that ledger: where a report
exists it reads the authoritative `report.json`; where the pipeline stopped earlier it
records an `ERROR` entry **without inventing a flow verdict**. `report:ci` emits a
machine-readable `summary.json` and a human `summary.md`. It **does not manufacture a
new cross-flow verdict** — it surfaces `allPass` + counts + per-flow rows.

### D44 — One workflow, two triggers, activated in two stages around the gate
A single workflow file. Task 4 ships it with `workflow_dispatch` **only**. After the
human gate, Task 5 adds the path-filtered `pull_request` trigger. PR-event-only steps
(fork guard, sticky comment) are present from Task 4 but **guarded** by
`github.event_name == 'pull_request'`, so they are inert under dispatch. Permissions
are minimal (`contents: read`, `pull-requests: write`); **`pull_request_target` is
forbidden**. Concurrency groups by PR/ref with `cancel-in-progress: true`
(cancellation of a stale commit is **not** a test retry).

### D45 — Fork PRs get a safe, comment-less path
On `pull_request` from a fork, secrets are withheld and the token is read-only;
declaring `pull-requests: write` does **not** restore comment-write. Therefore, when
the head repository differs from the base repository: detect it, **skip** install and
all model-spending steps, write a clear notice to `$GITHUB_STEP_SUMMARY`, **do not**
attempt the sticky-comment step, **do not** introduce `pull_request_target`, and
document that a maintainer must bring the change onto a trusted branch and run
`workflow_dispatch`.

### D46 — Spend is bounded by existing guards; no new budget mechanism; no retries
Phase 6 adds **no retries** — one execution and one evaluation per flow.

> Executor spending is bounded by the existing per-flow execution guard. Verifier
> work is bounded by one call per criterion and the verifier's configured request
> limits. Phase 6 introduces no retries and reports both costs separately.

A unified workflow-level dollar ceiling would be a new budget mechanism and is **out
of scope**. The exact `DEFAULT_GUARDS` values (including the documented **$5/flow**
executor ceiling) are copied from source in Task 0, not repeated from memory.

### D47 — Not a branch-protection required check
The ProofLoop workflow is **kept out of branch protection's hard required-check
list**. A workflow skipped by path filtering can leave an associated required check
pending indefinitely; combined with path filters that would deadlock docs-only PRs.
Enforcement is the visible red/green check plus the sticky comment plus the human
merge gate. No skip-shim job is introduced.

---

## CI data contracts

### `platform/config/ci-flows.json` (tracked, Task 2)
```json
{
  "schemaVersion": "1.0",
  "flows": [
    "fixtures/flows/login.flow.md",
    "fixtures/flows/add-to-cart.flow.md",
    "fixtures/flows/checkout.flow.md",
    "fixtures/flows/checkout-mobile.flow.md",
    "fixtures/flows/form.flow.md"
  ]
}
```
Paths are **repo-root-relative**. The loader resolves them to absolute paths before
handing them to the platform CLIs. Ordered; no duplicates; each must exist and parse
to a `FlowPlan`. No verdicts, bug IDs, selectors, labels, or ledger data.

### `ci-results.json` (runtime, written by the workflow, consumed by `report:ci`)
One entry per configured flow:
```ts
interface CiFlowResult {
  flowPath: string;                 // repo-root-relative, from ci-flows.json
  stage: "run" | "verify" | "report" | "complete";
  runId?: string;                   // present once run succeeds
  evaluationId?: string;            // present once verify succeeds
  reportPath?: string;              // present once report succeeds (report.json path)
  errorClass?: string;              // e.g. "APP_NOT_READY" | "RUN_FAILED" | "VERIFY_FAILED" | "REPORT_FAILED"
  errorMessage?: string;            // scrubbed; never contains secrets
}
```
`stage` records how far the flow got. `errorClass`/`errorMessage` are set only when a
stage failed to produce a trustworthy artifact (a non-zero CLI exit per D38, or the
SUT never became ready). A `FAIL`/`INCONCLUSIVE` verdict is **not** an error — it
reaches `stage: "complete"` with a `reportPath`.

> **`errorMessage` must be bounded and deterministically scrubbed before storage.**
> Prefer a known harness-authored message per `errorClass` (e.g. `RUN_FAILED` →
> `"run-cli exited non-zero; see uploaded SUT/run logs"`). Raw process stderr may
> remain only in the separately uploaded log files, and only after the existing secret
> masking/redaction protections — it must **never** be copied directly into
> `ci-results.json`, `summary.json`, or the PR comment. Escaping protects Markdown/HTML
> structure; it does not remove secrets.

### `summary.json` (deterministic, emitted by `report:ci`)
```ts
interface CiSummary {
  schemaVersion: "1.0";
  allPass: boolean;                 // true iff every flow verdict is PASS
  counts: { pass: number; fail: number; inconclusive: number; error: number };
  flows: Array<{
    flowPath: string;
    outcome: "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";   // ERROR = no verdict produced
    runId?: string;
    evaluationId?: string;
    nonPassCriteria?: Array<{                                // for FAIL / INCONCLUSIVE
      id: string;
      text: string;
      outcome: "FAIL" | "INCONCLUSIVE";                      // never conflate the two
      reason: string;
    }>;
    errorClass?: string;            // for ERROR
    decider?: { costUsd: number; latencyMs: number };      // kept separate (D31)
    verifier?: { costUsd: number; latencyMs: number };     // kept separate (D31)
  }>;
}
```
`allPass = counts.fail === 0 && counts.inconclusive === 0 && counts.error === 0 &&
counts.pass === flows.length`. Stable key ordering; **byte-identical across two runs
on identical inputs**; no timestamps. The final enforcement step reads only `allPass`.

### `summary.md` (sticky-comment body, emitted by `report:ci`)
Begins with a hidden marker `<!-- proofloop-ci -->` for upsert. Contains: an overall
status line; a per-flow table (flow, outcome, decider cost, verifier cost); for each
non-`PASS` flow the **reason class** and its non-pass criteria — a `FAIL` criterion
described as a **detected behavioral regression** and an `INCONCLUSIVE` criterion as
**not cleared**, never mislabelled as the other;
decider/verifier cost rolled up **separately**; links to the uploaded artifacts; and
the single-run caveat below. Every artifact-derived string is HTML/Markdown-escaped
(D29 discipline carries over).

> **Caveat (always present):** This is a single CI execution of each flow against a
> clean app. A green result is not a reliability claim and a red result is one run,
> not a measured failure rate. Repeated-run reliability and verdict variance are
> Phase 8. Bug-ledger accuracy is Phase 7.

---

## Task checklist

### Task 0 — Read-only implementation audit (no code)
Inspect the repository and **record findings in this file** (a dated block like
Phase 4's Task-0 findings). Re-execute nothing; call no LLM.

* [x] Confirm `.github/workflows/` is empty.
* [x] Record the current **process exit codes** of `run-cli`, `verify-cli`,
  `report-cli` across: success; recorded execution status `blocked` /
  `guard_tripped` / `error` / `cancelled`; verdict `PASS` / `FAIL` / `INCONCLUSIVE`;
  invalid args; missing model/config; malformed input; plan-hash mismatch;
  unsupported schema; write failure. **State explicitly where current behavior
  diverges from D38** — that delta is Task 1's work.
* [x] Record exact stdout id-emission format for `run-cli` and `verify-cli`, and
  where each id is generated/written.
* [x] Copy the exact `DEFAULT_GUARDS` values verbatim (actions/step, actions/flow,
  LLM calls/step+flow, prompt+completion token caps, wall-clock timeout,
  repeated-action / no-progress, the **$5/flow** cost ceiling).
* [x] Record the pricing **loader/resolver** entry point and confirm
  `platform/config/pricing.anthropic-2026-06.json` prices **both** configured model
  IDs: the executor/decider model ID (record where it is configured — env or default)
  and `PROOFLOOP_VERIFIER_MODEL` (`claude-opus-4-8`). Validate by **actual model ID**,
  never by display name.
* [x] Confirm `app` boots with `npm start`, binds `APP_PORT`, serves `GET /health`
  immediately, parses `PROOFLOOP_BUGS` at startup, and **boots fine with
  `PROOFLOOP_DEBUG_TOKEN` unset** (debug routes 404, no crash).
* [x] Confirm `--env-file-if-exists=../.env` is a clean no-op when `.env` is absent.
* [x] Grep the tester source to confirm the executor/verifier never read
  `PROOFLOOP_BUGS` or `PROOFLOOP_DEBUG_TOKEN`.
* [x] Record how `run-cli` resolves a flow-file path (cwd-relative vs absolute) so
  the manifest loader passes the right thing.
* [x] Record the Node version the repo targets (`.nvmrc` / `engines`) and where
  Playwright/Chromium is installed (which package owns the browser the MCP launches).

**Done when:** the findings block answers the exit-code question with a clear
yes/no delta against D38, and pins the guard values, pricing resolver, model IDs, and
SUT boot behavior CI will depend on. No code changed.

#### Task 0 — recorded findings (read-only implementation audit, 2026-06-20)

This audit was a static, read-only inspection of the repository. **No ProofLoop flow
was executed, no Anthropic/LLM call was made, no verification or report ran, no
workflow file was created, and no production code, test, schema, CLI behavior, or
configuration was changed.** Line references are to the source as read on 2026-06-20.

##### A. `.github/workflows/` is empty (greenfield CI)
`.github/workflows/` contains only `.gitkeep` — no workflow YAML exists. Confirmed
greenfield, exactly as the Context section states.

##### B. Current process exit codes vs D38

**`run-cli`** ([run-cli.ts](../platform/src/run-cli.ts)):

| Condition | Current exit | Where | D38 wants | Delta |
|---|:---:|---|:---:|---|
| Run finalized, `executionStatus = completed` | `0` | [L149](../platform/src/run-cli.ts#L149) | `0` | ✅ ok |
| Run finalized, status `blocked` / `guard_tripped` / `error` / `cancelled` | **`1`** | [L149](../platform/src/run-cli.ts#L149) | **`0`** | ❌ **DIVERGES** |
| Invalid args (bad/extra flag, ≠1 positional) | `2` | [L68](../platform/src/run-cli.ts#L68) | non-zero | ✅ ok |
| Missing `ANTHROPIC_API_KEY` | `2` | [L88](../platform/src/run-cli.ts#L88) | non-zero | ✅ ok |
| Malformed flow (`FlowParseError`) | `1` | [L79](../platform/src/run-cli.ts#L79) | non-zero | ✅ ok |
| Headed requested without a display (D36) | `2` | [L97](../platform/src/run-cli.ts#L97) | non-zero | ✅ ok |
| Write failure / uncaught crash | `1` | [L160–163](../platform/src/run-cli.ts#L160) | non-zero | ✅ ok |

`run-cli` returns `manifest.executionStatus === "completed" ? 0 : 1`. The terminal
`ExecutionStatus` vocabulary is `running | completed | blocked | guard_tripped | error
| cancelled | crashed` ([run/schema.ts L80–87](../platform/src/run/schema.ts#L80)); a
live run self-writes one of `completed | blocked | guard_tripped | error | cancelled`
(`crashed` is never self-written — it is inferred by a recovery reader when a process
died with status still `running`). So today every finalized-but-not-`completed` run
exits `1` even though a trustworthy `run.json` + `runId` were produced. **This is the
single `run-cli` divergence from D38.**

**`verify-cli`** ([verify-cli.ts](../platform/src/verify-cli.ts)):

| Condition | Current exit | Where | D38 wants | Delta |
|---|:---:|---|:---:|---|
| Evaluation written, `flowVerdict = PASS` | `0` | [L78](../platform/src/verify-cli.ts#L78) | `0` | ✅ ok |
| Evaluation written, `flowVerdict = FAIL` or `INCONCLUSIVE` | **`1`** | [L78](../platform/src/verify-cli.ts#L78) | **`0`** | ❌ **DIVERGES** |
| Invalid args | `2` | [L31](../platform/src/verify-cli.ts#L31) | non-zero | ✅ ok |
| Missing `ANTHROPIC_API_KEY` | `2` | [L39](../platform/src/verify-cli.ts#L39) | non-zero | ✅ ok |
| Missing `PROOFLOOP_VERIFIER_MODEL` | `2` | [L48](../platform/src/verify-cli.ts#L48) | non-zero | ✅ ok |
| `PlanHashMismatchError` | `1` | [L80–83](../platform/src/verify-cli.ts#L80) | non-zero | ✅ ok |
| `EvidenceIntegrityError`, unsupported eval schema, missing run, write failure | `1` (bubbles to top-level catch) | [L88–93](../platform/src/verify-cli.ts#L88) | non-zero | ✅ ok |

`verify-cli` returns `record.flowVerdict === "PASS" ? 0 : 1`. A trustworthy evaluation
record with verdict `FAIL`/`INCONCLUSIVE` therefore exits `1` today. Integrity errors
are real: `EvidenceIntegrityError` ([verify/resolver.ts L69](../platform/src/verify/resolver.ts#L69))
and `PlanHashMismatchError` ([verify/writer.ts L56](../platform/src/verify/writer.ts#L56))
both bubble to non-zero correctly. **This is the single `verify-cli` divergence from D38.**

**`report-cli`** ([report-cli.ts](../platform/src/report-cli.ts)) — **already satisfies D38, no behavior change:**

| Condition | Current exit | Where |
|---|:---:|---|
| Valid deterministic report (any verdict — report is verdict-agnostic) | `0` | [L88](../platform/src/report-cli.ts#L88) |
| `--summary` path (fail-open: deterministic report still written) | `0` | [L116](../platform/src/report-cli.ts#L116) |
| Invalid args | `2` | [L77](../platform/src/report-cli.ts#L77) |
| `ReportIntegrityError` / `ReportArtifactNotFoundError` / `UnsupportedEvaluationSchemaError` | `1` | [L117–127](../platform/src/report-cli.ts#L117) |
| Plan-hash mismatch (surfaced as `ReportIntegrityError`) | `1` | [builder.ts L151–154](../platform/src/report/builder.ts#L151) |
| Uncaught crash | `1` | [L154–157](../platform/src/report-cli.ts#L154) |

`report-cli` already exits `0` on a valid report and non-zero only on
integrity/missing-artifact/unsupported-schema/plan-hash-mismatch/bad-args/crash.
Task 1's only `report-cli` work is **confirming tests**, no code change.

##### C. stdout id-emission + where each id is generated
* **`runId`** is generated in `run-cli` at [L105](../platform/src/run-cli.ts#L105):
  `` `${plan.id}-${stamp}-${randomUUID().slice(0,8)}` `` (stamp = ISO time with `:`/`.`
  → `-`), e.g. `add-to-cart-2026-06-20T12-00-00-000Z-d1908fac`. It is printed only as a
  decorated, two-line human block — `  runId=<id>` on the second line
  ([L126–128](../platform/src/run-cli.ts#L126)).
* **`evaluationId`** is generated by `nextEvaluationId` ([verify/writer.ts L101–110](../platform/src/verify/writer.ts#L101)):
  a deterministic ordered counter `eval-001`, `eval-002`, … (no randomness, no
  timestamp), returned from `writeEvaluation`. `verify-cli` prints it decorated as
  `  <evaluationId>: <evaluationPath>` ([L72–77](../platform/src/verify-cli.ts#L72)).
* Neither CLI has a `--id-file` flag yet. Both ids are emitted **only** inside
  human-facing lines today, which is exactly why D39's `--id-file` is needed — CI must
  not scrape decorated stdout.

##### D. `DEFAULT_GUARDS` (verbatim, [engine/guards.ts L37–48](../platform/src/engine/guards.ts#L37))
```ts
maxActionsPerStep: 8,
maxActionsPerFlow: 40,
maxLlmCallsPerStep: 12,
maxLlmCallsPerFlow: 60,
wallClockMsPerFlow: 300_000,          // 5 minutes
maxNoProgressActions: 3,              // consecutive no-progress actions
promptTokenCeilingPerFlow: 400_000,   // PROVISIONAL
completionTokenCeilingPerFlow: 40_000,// PROVISIONAL
costCeilingUsdPerFlow: 5.0,           // the documented $5/flow executor ceiling
ceilingsProvisional: true,
```
The `$5/flow` executor cost ceiling D46 references is `costCeilingUsdPerFlow: 5.0`.
Token/cost ceilings are still flagged `ceilingsProvisional: true`.

##### E. Pricing loader/resolver + both production model IDs are priceable
* **Loader:** `loadPricing(pricingConfigId)` ([run/pricing.ts L52](../platform/src/run/pricing.ts#L52))
  reads `platform/config/pricing.<id>.json`; the id defaults to `anthropic-2026-06`
  from `PROOFLOOP_PRICING_CONFIG` ([config.ts L45](../platform/src/config.ts#L45)).
* **Resolver:** `ratesFor(cfg, model)` ([run/pricing.ts L86–94](../platform/src/run/pricing.ts#L86))
  looks up by **exact model-ID key** and throws (listing known ids) when absent —
  validates by actual model ID, never display name.
* `pricing.anthropic-2026-06.json` prices exactly: **`claude-opus-4-8`**,
  **`claude-sonnet-4-6`**, `claude-haiku-4-5`.
* **Executor/decider model = `claude-sonnet-4-6`** (the default; see F) → **priced ✅**
* **Verifier model = `claude-opus-4-8`** (`PROOFLOOP_VERIFIER_MODEL`) → **priced ✅**
* **Both production model IDs are priceable through the existing resolver.** The Task 4
  preflight must resolve them through `readEngineConfig()` + `ratesFor`, not by parsing
  the pricing file independently or keeping a second model list (D41/Risk 7).

##### F. Executor model is **environment-configured with a default** (not hardcoded)
`readEngineConfig()` sets `model: env.PROOFLOOP_MODEL ?? "claude-sonnet-4-6"`
([config.ts L39](../platform/src/config.ts#L39)). So `PROOFLOOP_MODEL` overrides it and,
absent, it defaults to `claude-sonnet-4-6`. This is the **single production source** CI
must reuse for the executor model — D41 forbids inventing a duplicate CI-only variable.
(The verifier model has **no** default and fails loud via `requireVerifierModel`
([config.ts L55–64](../platform/src/config.ts#L55)) if `PROOFLOOP_VERIFIER_MODEL` is unset.)

##### G. SUT boot behavior
* Boots via `npm start` → `ts-node --transpile-only src/server.ts`
  ([app/package.json L8](../app/package.json#L8)).
* Binds `config.port` = `APP_PORT` (default `3000`, validated 1–65535)
  ([app/src/config.ts L6–13](../app/src/config.ts#L6)); `app.listen(config.port, …)`
  ([app/src/server.ts L62](../app/src/server.ts#L62)).
* `GET /health` → `res.json({ status: "ok" })`, registered **before** the routers
  ([app/src/server.ts L48–50](../app/src/server.ts#L48)) — pollable as soon as the
  listener is up.
* `PROOFLOOP_BUGS` parsed at startup (`readBugFlags`: comma-split, trimmed, empty =
  clean) ([app/src/config.ts L23–30](../app/src/config.ts#L23)).
* `PROOFLOOP_DEBUG_TOKEN` unset/empty ⇒ `readDebugToken()` returns `""`
  ([app/src/config.ts L35–37](../app/src/config.ts#L35)) ⇒ the `/debug` gate 404s every
  debug route ([app/src/routes/debug.ts L37–47](../app/src/routes/debug.ts#L37)). **The
  app boots fine with the debug token unset — no crash.** ✅
* **Boot precondition / gotcha:** `SESSION_SECRET` is **mandatory** —
  `readSessionSecret()` **throws** if it is unset/empty
  ([app/src/config.ts L15–21](../app/src/config.ts#L15)). The SUT will **not** boot
  without it, so Task 4's "generate an ephemeral `SESSION_SECRET`" (D41) is **required**,
  not optional; omitting it would crash the SUT at boot → every flow `ERROR(APP_NOT_READY)`.
* `app/src/config.ts` also runs `dotenv.config({ path: ../../.env })`
  ([app/src/config.ts L4](../app/src/config.ts#L4)); with no `.env` in CI this is a
  no-op and env arrives from the process — consistent with D41.

##### H. `--env-file-if-exists=../.env` is a clean no-op when `.env` is absent
The `run` and `verify` scripts launch with `node --env-file-if-exists=../.env …`
([platform/package.json L10–11](../platform/package.json#L10)); `--env-file-if-exists`
(unlike `--env-file`) silently does nothing when the file is missing. `report` carries
no env-file flag ([platform/package.json L12](../platform/package.json#L12)) — it makes
no LLM call by default. In CI (no `.env`) env is injected directly and the flag is inert. ✅

##### I. Tester isolation from `PROOFLOOP_BUGS` / `PROOFLOOP_DEBUG_TOKEN`
* A `platform/src` grep finds these names **only in comments asserting they are not
  read** — [config.ts L5](../platform/src/config.ts#L5),
  [verify-cli.ts L10](../platform/src/verify-cli.ts#L10),
  [engine/decider.ts L6](../platform/src/engine/decider.ts#L6),
  [verify/writer.ts L27](../platform/src/verify/writer.ts#L27). No `env.PROOFLOOP_BUGS`
  / `env.PROOFLOOP_DEBUG_TOKEN` read exists. `readEngineConfig` reads only `BASE_URL`,
  `PROOFLOOP_MODEL`, `PROOFLOOP_VERIFIER_MODEL`, `PROOFLOOP_SUMMARY_MODEL`,
  `ANTHROPIC_API_KEY`, `PROOFLOOP_PRICING_CONFIG`.
* **Defense in depth:** the MCP browser subprocess inherits
  `stripSensitiveEnv(getDefaultEnvironment())`, which deletes every `PROOFLOOP_*` and
  `ANTHROPIC_*` var ([mcp/client.ts L223–232](../platform/src/mcp/client.ts#L223),
  applied at [L316](../platform/src/mcp/client.ts#L316)). Even the browser can't see
  bug/debug/secret vars. The black-box boundary holds at code level (D41 still enforces
  it operationally in CI). ✅

##### J. Flow-path resolution
`parseFlowFile(filePath)` reads `fs.readFileSync(filePath, "utf8")`
([parser.ts L54–57](../platform/src/parser.ts#L54)) — the path is used **verbatim**:
absolute paths work; relative paths resolve against `process.cwd()`. The flow id is the
basename minus `.flow.md` ([parser.ts L45–51](../platform/src/parser.ts#L45)). CI runs
the CLIs from `platform/` (`cd platform && npm run run …`), so a repo-root-relative
`fixtures/flows/login.flow.md` would **not** resolve. ⇒ **The Task 2 manifest loader
must hand the CLI an ABSOLUTE path** (D40 already says so; Task 4 step 8 already passes
`<abs flow path>`). `run-cli` does no repo-root re-rooting of its own.

##### K. Node version + browser-install owner
* **No Node version is pinned anywhere:** no root `.nvmrc` / `.node-version`, no
  `engines` field in `app/package.json` or `platform/package.json`, and (by design)
  no root `package.json`. Both packages use `@types/node: ^20.12.7`, and the `run` /
  `verify` scripts depend on `node --env-file-if-exists`, which requires **Node ≥ 20.6**;
  `node --test` + `ts-node/register` are stable on Node 20. ⇒ **Task 4 must pin a Node
  version in the workflow itself (recommend Node 20.x, ≥ 20.6).** There is no existing
  pin to copy — this is a Task 4 decision, not a repo fact.
* **The platform package owns the browser:** `@playwright/mcp@0.0.76` is a `platform/`
  dependency ([platform/package.json L18](../platform/package.json#L18)); the MCP CLI is
  resolved from `@playwright/mcp/package.json` and launched with `--browser chromium`
  ([mcp/client.ts L62–66](../platform/src/mcp/client.ts#L62),
  [L156–171](../platform/src/mcp/client.ts#L156)). `app/` has no Playwright dependency.
  ⇒ **`npx playwright install --with-deps chromium` must run in `platform/`** (Task 4 step 3).

##### L. Direct answers to the six required questions
1. **Behaviors already satisfying D38:** `report-cli` in full (0 on a valid report,
   non-zero on integrity/missing-artifact/unsupported-schema/plan-hash-mismatch/bad-args/
   crash); and every non-zero branch of `run-cli` and `verify-cli` (invalid args, missing
   config/model, malformed/missing input, plan-hash mismatch, evidence-integrity error,
   write failure, uncaught crash) is already correctly non-zero.
2. **Divergences from D38 (exactly two):** (a) `run-cli` exits `1` for a finalized run
   whose status is `blocked`/`guard_tripped`/`error`/`cancelled`; (b) `verify-cli` exits
   `1` for a trustworthy evaluation with verdict `FAIL`/`INCONCLUSIVE`.
3. **Exact Task 1 change per divergence:**
   * `run-cli` [L149](../platform/src/run-cli.ts#L149): return `0` whenever `runFlow`
     returns a finalized manifest (any of `completed|blocked|guard_tripped|error|
     cancelled`) with the `runId` written; keep the existing pre-finalize branches
     (args `2`, missing key `2`, parse `1`, headed-no-display `2`) and uncaught crash
     (`1`) non-zero.
   * `verify-cli` [L78](../platform/src/verify-cli.ts#L78): return `0` whenever a
     trustworthy evaluation record was written (any `flowVerdict`); keep
     `PlanHashMismatchError`, `EvidenceIntegrityError`, unsupported schema, missing run,
     and write failure non-zero.
   * `report-cli`: **no code change** — add confirming tests only.
   * Both `run-cli` and `verify-cli` additionally gain `--id-file <path>` (D39) writing
     **only** the already-generated id; stdout human lines stay unchanged.
4. **Executor model is environment-configured with a default:** `PROOFLOOP_MODEL ??
   "claude-sonnet-4-6"` ([config.ts L39](../platform/src/config.ts#L39)). Not hardcoded,
   not default-less.
5. **Both production model IDs are priceable through the existing resolver:** yes —
   `claude-sonnet-4-6` (executor) and `claude-opus-4-8` (verifier) are both keys in
   `pricing.anthropic-2026-06.json` and resolve via `ratesFor` by exact id.
6. **Task 1 can proceed without touching the run-log schema, evaluation schema,
   execution loop, verifier logic, or parser:** yes. The work is confined to the three
   CLI entry files' argument parsing and the integer `main()` returns. The `runId` is
   already generated in `run-cli`, the `evaluationId` is already generated by the writer
   and returned; `--id-file` merely writes an already-existing value to a path. No schema
   field, loop step, verifier call, or parser rule is altered.

##### Net delta carried into Task 1 (pending the gate)
Two one-line exit-code corrections (`run-cli` L149, `verify-cli` L78) + an additive
`--id-file` on `run-cli`/`verify-cli`; `report-cli` already conforms and needs tests
only. No schema, loop, verifier, or parser change. **Awaiting human approval of D38/D39
at the gate before any code is touched.**

---

### 🚦 HUMAN GATE — CLI process contract
The human reviews the Task-0 findings and **freezes the D38/D39 contract before
implementation**: which finalized run states exit zero, which evaluation verdicts exit
zero, which conditions remain process failures, and the exact `--id-file` behavior.
This gate does **not** reopen the run-log or evaluation-record schemas; it approves an
**additive** change to the previously established CLI surfaces. It exists because the
exit-code behavior is one of Phase 6's most load-bearing assumptions — without it, the
five-flow loop can silently stop after the first non-`PASS` result.

Do not begin Task 1 before approval.

---

### Task 1 — Additive `--id-file` + the D38 exit-code contract
*Edits the Phase 2/3 CLI entry files at their argument surface and exit code only.
Does **not** touch the run-log schema, execution loop, verifier logic, or parser.*

* [x] Add `--id-file <path>` to `run-cli`: write **only** the `runId` to the file.
* [x] Add `--id-file <path>` to `verify-cli`: write **only** the `evaluationId`.
* [x] Leave existing stdout human lines unchanged (back-compatible).
* [x] Implement / confirm the **D38 exit-code contract** in all three CLIs.
* [x] Tests — `run-cli`:
  * exits `0` on success and the `--id-file` content equals the printed `runId`;
  * exits `0` when execution status is `blocked` / `guard_tripped` / `error` /
    `cancelled` but a trustworthy run artifact is finalized;
  * exits non-zero on invalid args, missing model/config, malformed flow, and
    simulated write failure.
* [x] Tests — `verify-cli`:
  * exits `0` writing an evaluation for `PASS`, `FAIL`, and `INCONCLUSIVE`, with the
    `--id-file` content equal to the written `evaluationId`;
  * exits non-zero on integrity error (e.g. digest mismatch / `EvidenceIntegrityError`),
    unsupported schema, missing run, and write failure.
* [x] Tests — `report-cli`:
  * exits `0` on a valid report;
  * exits non-zero on D28 join/integrity failures, plan-hash mismatch, missing
    artifacts.
* [x] `--id-file` content is exactly the id (no extra whitespace beyond a single
  optional trailing newline; assert in a test).

#### Task 1 — implementation notes (2026-06-20)

Done within the gate-frozen D38/D39 contract; tests + `npm run typecheck` green
(`npm test`: 318 pass, 3 pre-existing `-live` skips, 0 fail).

* **Exit-code delta (the two divergences from the Task-0 audit):**
  * `run-cli` — was `executionStatus === "completed" ? 0 : 1`; now returns `0` for any
    **finalized** manifest (`completed | blocked | guard_tripped | error | cancelled`).
  * `verify-cli` — was `flowVerdict === "PASS" ? 0 : 1`; now returns `0` for any
    **trustworthy** evaluation record (`PASS | FAIL | INCONCLUSIVE`).
  * `report-cli` — **unchanged** (already D38-conformant); covered by confirming tests only.
  * Non-zero conditions are preserved everywhere (invalid args, missing config/model,
    malformed/missing input, plan-hash mismatch, evidence-integrity, unsupported schema,
    write failure, uncaught crash).
* **`--id-file` (D39):** new shared `platform/src/cli-idfile.ts` writes **only** the id
  plus a single trailing newline; `run-cli`/`verify-cli` emit it **after** the artifact is
  finalized. An id-file write failure exits non-zero (never a false success). Human stdout
  lines are byte-identical (same template strings, now via an injectable stream).
* **Testability:** `run-cli`/`verify-cli` `main` bodies became injectable cores
  (`runCli`/`verifyCli(argv, deps?)`) defaulting to the production implementations, so every
  exit-code branch is tested in-process with a mock executor / mock verifier (no live LLM or
  browser). `report-cli` was **not** modified; its real process exit codes are asserted via
  subprocess.
* **Scope held:** no change to the run-log schema, evaluation-record schema, execution loop,
  verifier logic, or parser.

✅ **COMMIT:** `feat(platform): --id-file emission and D38 process exit-code contract`

---

### Task 2 — Static CI flow manifest + loader
* [ ] Add tracked `platform/config/ci-flows.json` (shape per the data contract;
  the five canonical flows in order).
* [ ] Add a loader/validator (`platform/src/…`) that: parses the manifest; rejects an
  unsupported `schemaVersion`; resolves each path repo-root-relative to absolute;
  asserts each file exists, parses to a `FlowPlan`, and appears once; rejects
  duplicates and out-of-tree paths.
* [ ] Tests: valid manifest loads to five resolved flows; missing file fails;
  unknown `schemaVersion` fails; nonexistent flow path fails; duplicate fails;
  path outside `fixtures/flows/` fails.

✅ **COMMIT:** `feat(platform): tracked CI flow manifest and loader`

---

### Task 3 — Deterministic `report:ci` aggregator
* [ ] Add `platform/src/report-ci-cli.ts` and a `report:ci` script, mirroring
  `report-compare-cli.ts` conventions. CLI:
  ```bash
  npm run report:ci -- --results <ci-results.json> --out-dir <dir>
  ```
* [ ] Read `ci-results.json`. For each entry:
  * `stage: "complete"` → read the authoritative `report.json` at `reportPath`;
    take the flow verdict, per-criterion verdicts, and decider/verifier cost+latency
    from it (kept **separate**, D31). Populate `nonPassCriteria` for `FAIL` /
    `INCONCLUSIVE`, tagging each with its own `outcome` so a `FAIL` is never
    presented as merely inconclusive nor an `INCONCLUSIVE` as a failure.
  * otherwise → emit an `ERROR` row carrying `errorClass`; **invent no verdict**.
* [ ] Emit `summary.json` (deterministic, stable key order, no timestamps,
  byte-identical across two identical runs) and `summary.md` (escaped; hidden
  `<!-- proofloop-ci -->` marker; regression-vs-could-not-clear distinction; separate
  decider/verifier cost rollup; artifact links; the mandatory single-run caveat).
* [ ] `allPass` computed per the data contract; **never** derived from Markdown.
* [ ] Make **no** LLM call. (CI AI summary is off — D-note in Out of scope.)
* [ ] Tests with fixtures: all-`PASS`; one `FAIL` (non-pass criteria surfaced,
  tagged `outcome: "FAIL"`); one `INCONCLUSIVE` (tagged `outcome: "INCONCLUSIVE"`,
  not mislabelled as failed); one pipeline `ERROR` (no `report.json`); a mixed set;
  escaping of flow/criterion/error strings; `summary.json` byte-identical across two
  runs; `allPass` independent of `summary.md`.

✅ **COMMIT:** `feat(platform): deterministic report:ci aggregation (summary.json + summary.md)`

---

### Task 4 — GitHub Actions workflow (`workflow_dispatch` only)
* [ ] Add `.github/workflows/proofloop.yml`.
* [ ] Triggers: **`workflow_dispatch` only** for now, with an optional `bugs` input
  (string; default empty) routed to the **SUT boot only**.
* [ ] `permissions: { contents: read, pull-requests: write }`. **No
  `pull_request_target`.**
* [ ] `concurrency: { group: proofloop-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
* [ ] PR-event-only steps present but guarded by
  `if: github.event_name == 'pull_request'` (fork guard, sticky comment) — inert
  under dispatch.
* [ ] Fork guard (D45): for `pull_request` where
  `github.event.pull_request.head.repo.full_name != github.repository`, skip install
  and all spending steps, write a notice to `$GITHUB_STEP_SUMMARY`, and do not attempt
  the comment. (Recommended structure: an `authorize` job exposing an `authorized`
  output, with the main job `needs: [authorize]` and `if: needs.authorize.outputs.authorized == 'true'`,
  plus a small notice job for the unauthorized case.)
* [ ] Pipeline (single job, serial flows):
  1. Checkout. Setup Node (pinned version from Task 0).
  2. `npm ci` in `app/` and `npm ci` in `platform/` (cache per lockfile).
  3. `npx playwright install --with-deps chromium` (in the package that owns the
     browser, per Task 0).
  4. **Preflight (fail fast, before any spend):** validate `ci-flows.json` parses;
     resolve the executor and verifier model IDs through the **same production
     configuration paths the CLIs use**, then confirm both exact IDs are priceable
     through the existing pricing resolver — **do not** independently parse the
     pricing file or maintain a second list of model IDs in the workflow; assert
     `ANTHROPIC_API_KEY` is present.
  5. **Boot SUT (clean):** `PROOFLOOP_BUGS="${{ inputs.bugs }}"` (empty on PR runs)
     `SESSION_SECRET=$(generate ephemeral)` `APP_PORT=3000` `npm start &` in `app/`,
     logging to a file, capturing the PID. **Do not** export `PROOFLOOP_BUGS` /
     `SESSION_SECRET` / `PROOFLOOP_DEBUG_TOKEN` to the job-wide env (D41).
  6. Poll `GET http://localhost:3000/health` until ok or a bounded timeout; on
     timeout, mark every flow `ERROR(APP_NOT_READY)` in `ci-results.json` and skip to
     aggregation (still upload SUT logs).
  7. Initialize `ci-results.json` from `ci-flows.json` (one `stage:"run"` entry each).
  8. **For each flow, serially** — the loop must **not** abort on a flow's non-zero
     exit; capture and continue (D38 guarantees non-zero means a real infra/integrity
     failure, recorded as `ERROR`, while `FAIL`/`INCONCLUSIVE` verdicts exit `0`):
     * `run`: `cd platform && npm run run -- <abs flow path> --id-file run-id.txt`
       with **tester env only** (`ANTHROPIC_API_KEY`, `BASE_URL`,
       `PROOFLOOP_VERIFIER_MODEL`). Non-zero → record `ERROR(RUN_FAILED)`, next flow.
       Else read `runId`.
     * `verify`: `npm run verify -- --run <runId> --id-file eval-id.txt`. Non-zero →
       `ERROR(VERIFY_FAILED)`, next flow. Else read `evaluationId`.
     * `report`: `npm run report -- --run <runId> --evaluation <evaluationId>`.
       Non-zero → `ERROR(REPORT_FAILED)`. Else set `reportPath`, `stage:"complete"`.
     * Update `ci-results.json` after each stage.
  9. `cd platform && npm run report:ci -- --results <ci-results.json> --out-dir <ci-out>`.
* [ ] Upload artifacts (`if: always()`): per-run `report.html` / `report.json`,
  `run.json`, `events.jsonl`, the selected `evaluation.json`, `ci-results.json`,
  `summary.json`, `summary.md`, and the SUT log.
* [ ] Append `summary.md` to `$GITHUB_STEP_SUMMARY` (`if: always()`).
* [ ] Sticky comment step (`if: always() && github.event_name == 'pull_request'`):
  `actions/github-script` finds a comment containing `<!-- proofloop-ci -->` and
  updates it, else creates one. (Inert under dispatch.)
* [ ] Teardown: kill the SUT PID (`if: always()`).
* [ ] **Final enforcement (last step, `if: always()`):** read `allPass` from
  `summary.json`; `exit 1` unless `true`. Evidence is already uploaded and (on PRs)
  commented before this runs.

**Done when:** a clean `workflow_dispatch` run boots the clean SUT, runs all five
flows, all `PASS`, summary green, artifacts uploaded, job green; a `workflow_dispatch`
run with `bugs: BUG-002` shows `add-to-cart` `FAIL` (criterion C2, Tax `$0.00`),
`summary.md` names it as a behavioral regression, all artifacts present, job red.

✅ **COMMIT:** `feat(ci): proofloop workflow (workflow_dispatch) — run→verify→report→aggregate`

---

### 🚦 HUMAN GATE — first live CI review
The human reviews **two real dispatch runs** before the `pull_request` trigger is
added:

* a clean run → green, correct summary, full artifacts;
* a `bugs: BUG-002` run → red, regression distinguished from "could not clear".

The human confirms:
* **env partitioning held** — grep the uploaded tester-side artifacts and logs:
  no `PROOFLOOP_BUGS`, no `PROOFLOOP_DEBUG_TOKEN`, no `ANTHROPIC_API_KEY`, no bug
  label leaked into any tester artifact;
* no secret residue anywhere in artifacts or logs;
* `summary.json` drives the red/green correctly; `summary.md` reads honestly with the
  single-run caveat;
* the merge is still a human action (nothing auto-merges).

Do not self-certify. Do not wire `pull_request` before approval.

---

### Task 5 — Activate `pull_request` + documentation + live PR validation
* [ ] Add the `pull_request` trigger with path filters. `platform/**` already
  covers `platform/config/**` and `platform/package-lock.json`, and `app/**` already
  covers `app/package-lock.json`, so the filter is just:
  ```yaml
  paths:
    - "app/**"
    - "platform/**"
    - "fixtures/flows/**"
    - ".github/workflows/proofloop.yml"
  ```
* [ ] Confirm the fork guard and sticky-comment steps now activate for PR events.
* [ ] README: how CI triggers (path-filtered same-repo PRs + manual dispatch);
  that `ANTHROPIC_API_KEY` is the only repository secret and `SESSION_SECRET` is
  ephemeral; how to run the seeded-bug demo via dispatch; the **D47** guidance
  (do **not** add this as a branch-protection required check); and limitations
  (same-repository PRs only; single-run ≠ reliability → Phase 8; clean-SUT gate, not
  accuracy → Phase 7; trace/video → Phase 9).
* [ ] **Live same-repository PR validation:** open a PR touching a filtered path →
  the workflow runs, upserts one sticky comment, and is green on a clean change; a PR
  introducing a real behavioral regression → red with the regression named; a
  docs-only PR → does **not** trigger.

✅ **COMMIT:** `feat(ci): enable path-filtered pull_request trigger`
✅ **COMMIT:** `docs: CI usage, secrets, and branch-protection guidance for ProofLoop`

---

## Out of scope (hard fence)

* ❌ Playwright **trace / video** capture — deferred to **Phase 9**; Phase 6 uploads
  only the artifacts that already exist.
* ❌ **Parallel** flow execution — Phase 10 (serial avoids shared-SUT/session races).
* ❌ Changed-file → flow inference (run all five from the manifest).
* ❌ Fork-PR secret execution and `pull_request_target`.
* ❌ Eval-harness accuracy / bug-ledger scoring — **Phase 7**.
* ❌ Repeated-run reliability / verdict variance / retries — **Phase 8**.
* ❌ AI summary in CI (the deterministic report + `summary.json`/`summary.md` are
  authoritative; no extra LLM cost or narrative variance).
* ❌ Any unified workflow-level **dollar budget** mechanism.
* ❌ Registering the workflow as a branch-protection **required check**.
* ❌ Dashboards, trend visualization, run-history UI, databases, auth.
* ❌ Any new verdict, scoring, or citation-validation logic.
* ❌ Edits to frozen Phase 1–3 contracts beyond the additive `--id-file` flag and the
  D38 exit-code contract on the CLI surface (the run-log schema, execution loop,
  verifier logic, and parser are untouched).
* ❌ Auto-merge — always a human decision.

---

## Exit checklist

* [x] Task-0 findings recorded, including the explicit D38 exit-code delta, the
  verbatim guard values, the pricing resolver + both model IDs, and SUT boot behavior.
* [x] `--id-file` works on `run-cli` and `verify-cli`; content is exactly the id.
* [x] D38 exit-code contract implemented and tested across all three CLIs.
* [ ] `platform/config/ci-flows.json` tracked, loads to the five flows, contains no
  ground truth.
* [ ] `report:ci` emits deterministic `summary.json` (byte-identical across two runs)
  and escaped `summary.md`; `allPass` never derived from Markdown; no LLM call.
* [ ] Pipeline `ERROR` flows are represented without inventing a verdict; `FAIL` /
  `INCONCLUSIVE` carry their criteria; decider/verifier costs separate.
* [ ] Workflow runs on `workflow_dispatch`; serial flows; loop continues past a
  failing flow; preflight fails fast; `/health` polled; SUT torn down.
* [ ] Env partitioning enforced (tester env and SUT env disjoint per D41).
* [ ] Artifacts uploaded on non-green; `$GITHUB_STEP_SUMMARY` populated; final
  enforcement reads only `allPass`.
* [ ] Fork-PR path: no spend, no comment, `$GITHUB_STEP_SUMMARY` notice, no
  `pull_request_target`.
* [x] 🚦 CLI-contract gate passed (Task-0 findings reviewed; D38/D39 contract frozen
  before Task 1).
* [ ] 🚦 Live-CI gate passed on a clean dispatch and a seeded-bug dispatch.
* [ ] `pull_request` trigger added with path filters; sticky comment upserts (one
  comment, updated in place); docs-only PR does not trigger.
* [ ] README documents triggers, the single secret, the demo, branch-protection
  guidance (D47), and limitations.
* [ ] Not registered as a branch-protection required check.
* [ ] `npm test` and `npm run typecheck` pass in `platform/`.

---

## Risks

1. **Exit-code change breaks an existing caller.** Pin the D38 contract with tests;
   note any local scripts that relied on old codes.
2. **The flow loop aborts on the first failing flow.** The loop must capture and
   continue; never `set -e` over it. D38 guarantees non-zero = real infra/integrity
   failure (→ `ERROR`), while verdicts exit `0`.
3. **Fork PR looks broken.** Without the D45 guard, a fork PR dies at the API call.
   Detect, skip, notice — no comment attempt.
4. **Required-check deadlock on docs PRs.** Mitigated by D47 — not a required check.
5. **Black-box leakage.** `PROOFLOOP_BUGS` / debug token reaching the tester is a
   gate-blocking defect; the gate greps artifacts to confirm.
6. **Non-determinism read as regression.** No retries; `summary.md` carries the
   single-run caveat; reliability is Phase 8.
7. **Pricing gap → mid-run failure.** Preflight validates both model IDs before any
   spend.
8. **SUT not ready → false `ERROR`.** `/health` poll with a bounded timeout; on
   timeout, record `APP_NOT_READY` and still upload SUT logs.
9. **Secret in logs/artifacts.** `ANTHROPIC_API_KEY` is an Actions secret (auto-masked);
   the gate review confirms no residue.
10. **Concurrency cancellation leaves partial artifacts.** Acceptable — runs are
    gitignored and superseded; cancellation is not a retry.