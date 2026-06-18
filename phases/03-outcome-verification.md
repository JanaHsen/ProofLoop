# Phase 3 — Outcome Verification & the Regression Guard 🌸

> **Goal:** Turn one executed `FlowPlan` run into per-criterion verdicts by reading the
> run's stored evidence — adapting to UI *structure* changes while staying strict on
> *behaviour*. Self-heal on a renamed/moved control is a feature; healing *past* a
> broken outcome is the failure this phase exists to prevent.
> **Exit criterion:** The platform PASSES the `add-to-cart` flow whose button was renamed
> (MUT-001), FAILS the flow whose total was broken (BUG-002), and still FAILS the flow
> with the broken total *under* the renamed button (BUG-002 + MUT-001) — and you can show
> all four runs (incl. the clean PASS). Verdicts match `fixtures/bug-ledger.yaml`.

---

## How to use this file (Claude Code)

1. Read `../CLAUDE.md` first (auto-loaded) — it pins the canonical paths and the
   cross-cutting rules. Do not deviate from those paths.
2. Work the **Task checklist** top to bottom. Tick each `[ ]` as you finish it.
3. **Stop at every `🚦 HUMAN GATE`** and wait for the human. Do not proceed past it.
4. **Commit at every `✅ COMMIT`** checkpoint using the suggested message. Small,
   reviewable commits.
5. You are NOT done with Phase 3 until the **Exit Checklist** at the bottom is fully
   checked. Do not start Phase 4 before then.
6. Read the **Out of scope** section before you start. It is a hard fence.
7. Phase 2's Exit Checklist must be fully true before you begin (it is). This phase
   builds the verifier, the deterministic evidence resolver, and the evaluation record
   inside `platform/`, and applies one narrow additive patch to the Phase 2 run-log.

---

## Why this phase matters (don't skip the reasoning)

This is the phase that turns "an action happened" into "the outcome was correct." Phase 2
deliberately stopped at `step_complete` = *an action was performed and a response was
observed* — it produces **no** verdict. Phase 3 is where verdicts are born, and the whole
credibility argument (Phases 7–8) grades exactly the verdicts produced here.

Four things shape every decision below:

- **The regression trap is the heart of this phase.** Self-healing on *structure* — a
  renamed "Add to Cart" → "Add to Bag", a moved button — must not change a verdict. But
  self-healing *past broken behaviour* — a dropped tax line, a silently-lost order — is the
  failure the platform exists to prevent. A renamed button PASSES; a wrong total FAILS,
  **even if the agent navigated the new UI flawlessly.**

- **Self-heal is already built — this phase *demonstrates* it, it does not *build* it.**
  Phase 2's snapshot-then-act loop relocates every element from a fresh live snapshot, and
  Phase 1's criteria assert outcomes, never labels (D10). Those two together *are* the
  self-healing mechanism. There is no healing engine to write here. The MUT-001 PASS in the
  exit matrix is a *test* of an emergent property, not a new component.

- **Verification is post-hoc replay against frozen artifacts (D20).** The verifier reads
  the stored snapshots and event records of a finished run — it does not drive the browser
  and does not re-execute. This is what lets Phase 8 hold the evidence constant and run the
  verifier N times to measure *verifier* non-determinism in isolation from *executor*
  non-determinism. It also makes every verdict re-runnable and auditable.

- **This phase adds the system's second non-deterministic component.** Phase 2 added one:
  the decider reading a live page. Phase 3 adds the verifier reading evidence and applying
  a rule. Everything around it — the evidence resolver, citation validation, aggregation,
  the record writer — stays deterministic, so Phase 8 measures the reliability of the one
  reasoning step rather than drowning in incidental flakiness. Rule-based criteria ("Tax
  equals 10% of the Subtotal") push arithmetic into the verifier on purpose; that is a
  Phase 8 finding to **measure**, never a thing to hide behind a memorised constant.

`INCONCLUSIVE` is a first-class, honest outcome — not a softened FAIL and not a near-PASS.
It reports that the platform **could not justify either PASS or FAIL** from the evidence.
An unreliable platform and an indecisive one are different failure modes, and Phase 7/8
must be able to tell them apart.

---

## Decisions already locked (do NOT relitigate)

Inherited and still binding (Phases 0–2): **D8** parser is deterministic/structural-only;
**D9** action ≠ outcome (a non-favourable response is a *completed* action, not a failed
step); **D10** criteria assert outcomes, never labels/selectors/HTTP codes/DOM; **D11**
three-outcome verdict space; **D12** black-box authoring + the coverage map lives outside
`fixtures/flows/`; **D14** the harness validates references and *never trusts the model's
claim*; **D19** the run-log is an execution artifact with its own `runLogSchemaVersion`,
distinct from this phase's evaluation record. The standing rules apply: **never guess a
selector**, **assert intent not elements**, **black-box boundary = the URL**, **secrets by
layer / nothing hardcoded**, **never auto-merge**.

New for Phase 3:

### D20 — Post-hoc verification against frozen artifacts
Verification reads a finished run's stored artifacts (`run.json`, `events.jsonl`,
`snapshots/<id>.json`); it never drives the browser, re-executes, or probes the live page.
This isolates verifier non-determinism for Phase 8 and makes verdicts re-runnable and
auditable. The verifier connects to no MCP server and does not import the executor loop.

### D21 — Deterministic, structural evidence resolver
The criterion→evidence mapping is a pure function of the run's snapshot/event stream and
the criterion's *position* (its `after` step id, or terminal), with **no interpretation of
criterion meaning**. The resolver hands the verifier a bounded evidence window; the verifier
decides what within that window it needs. The resolver never reads criterion text to choose
snapshots — that would re-import non-determinism into the deterministic layer, exactly the
mistake D8 forbids one phase upstream. Resolution rules:

- **Pinned criterion** (`after = <stepId>`): the `step_boundary` snapshot whose `stepId`
  equals `<stepId>`, plus every earlier `step_boundary` snapshot (the **≤-checkpoint
  window** — backward references like "the same Total as when it was placed" are allowed;
  *future* snapshots relative to the checkpoint are never provided).
- **Terminal criterion** (no `after`): the single `terminal` snapshot, plus all
  `step_boundary` snapshots (bounded; Phase 8 may trim).
- **Non-completing step** (the pinned step ran but never reached `step_complete`, so it has
  no `step_boundary`): the `terminal` snapshot (captured best-effort at termination) **plus**
  the failed `action` event(s) and `error` event(s) for that step, including `failureDetail`
  (see D25). This is the evidence the verifier disambiguates FAIL vs INCONCLUSIVE from.
- **Never-reached step** (the flow terminated before the pinned step): no evidence; the
  harness short-circuits to `INCONCLUSIVE / ERROR / origin:"EXECUTION" / code:"COULD_NOT_EXECUTE"`
  with no verifier call.
- **Completed step but boundary snapshot missing** (best-effort capture threw): short-circuit
  to `INCONCLUSIVE / ERROR / origin:"EXECUTION" / code:"MISSING_BOUNDARY_SNAPSHOT"`.

### D22 — The verifier
One schema-constrained LLM call **per criterion**. It receives: the criterion text
(verbatim from the `FlowPlan`) and the resolved evidence window. It receives **none of**:
execution status, "all steps completed", the decider's rationales, step text, the bug
toggles, the debug token, or `fixtures/bug-ledger.yaml`. Withholding execution-success
signals is the regression-guard discipline — there must be no signal the verifier could use
to excuse a broken outcome. It emits structured **observations** (each carrying a *verbatim*
`observedText` plus the `snapshotId` and `ref` it was read from), a `verdict`, an optional
`inconclusiveDetail`, and plain-language `reasoning`. The harness then **hard-validates every
citation** (see "Citation validation" below) — mirroring D14: the harness checks what the
verifier claims to have read; it never trusts the claim. The verifier model is **separately
configurable** from the decider (`PROOFLOOP_VERIFIER_MODEL`), its exact id and parameters are
recorded per evaluation, and it runs in the lowest-variance configuration the API supports.
**No model-tier assumption is locked** — "a stronger model is more accurate" is an unproven
claim; the provisional model is chosen at the verifier-contract gate using a small replay set,
and reliability is measured in Phase 8. The architecture must not depend on a specific tier.

### D23 — The verdict model
Each criterion resolves to `PASS | FAIL | INCONCLUSIVE`. `INCONCLUSIVE` is not a pass; it
reports that the platform could not justify either PASS or FAIL from the evidence. Its detail
is one frozen union:

```ts
type InconclusiveDetail =
  | { kind: "AMBIGUOUS_EVIDENCE"; explanation: string }
  | { kind: "ERROR"; origin: "EXECUTION" | "VERIFICATION"; code: string; explanation: string };
```

Codes are enumerated in the schema, each bound to an origin — e.g. `COULD_NOT_EXECUTE`,
`MISSING_BOUNDARY_SNAPSHOT`, `MCP_TRANSPORT_ERROR` (origin `EXECUTION`); `VERIFIER_SCHEMA_ERROR`,
`INVALID_CITATION` (origin `VERIFICATION`).

**Non-completing-step rule.** Return `FAIL` only when *all* hold: (i) the criterion asserts
the action was supposed to be possible; (ii) the factual actuation evidence shows an
*application-level* actionability failure (the control is present in the snapshot **and** the
`failureDetail` describes an interception/actionability failure); (iii) no concurrent
infra/transport error is present in the window. When the evidence cannot reliably distinguish
application behaviour from infrastructure failure, return `INCONCLUSIVE`.

**Aggregation.** Flow verdict = all criteria `PASS` ⇒ `PASS`; any `FAIL` ⇒ `FAIL`; otherwise
`INCONCLUSIVE`.

### D24 — The evaluation record (a separate, versioned artifact)
Written to `platform/runs/<runId>/evaluations/<evaluationId>/evaluation.json` with its own
`evaluationRecordSchemaVersion` (independent of `FlowPlan.schemaVersion` and
`runLogSchemaVersion`). `evaluationId` is a **harness-assigned ordered pass index** (`eval-001`,
`eval-002`, …), never a UUID/timestamp — this reserves, without building, Phase 8's ability to
replay one frozen execution N times and store N records side by side. The record asserts its
`planHash` equals the run's `manifest.planHash` before evaluating (so the criteria graded are
exactly the ones executed). It joins evidence and reasoning to criteria **by criterion id**.

### D25 — Run-log 1.1: capture failed-action evidence (the only Phase 2 edit)
`ActionEvent` gains two optional fields:

```ts
failureDetail?: string;           // from ToolResult.text when isError === true
failureDetailTruncated?: boolean; // true if the (already-scrubbed) detail was clipped to the bound
```

The detail is **scrubbed first, then truncated** (order is load-bearing: truncating first can
sever a secret across the cut and leave a fragment the literal-based redaction won't match).
It is populated only when `isError === true`, absent on successful actions, and truncated from
the **end** so the leading Playwright diagnostic (the actionability reason) is preserved.
`runLogSchemaVersion` bumps to `"1.1"`; readers must still parse `"1.0"` records. **No verdict
logic enters Phase 2.** The resolver's non-completing-step path and this field are *core*
(a resolver that cannot handle a step ending without `step_complete` is simply wrong); only
the BUG-007 *demonstration* (Task 7) is removable.

---

## The evaluation record (the contract this phase freezes)

Illustrative TypeScript; Claude Code finalises naming/placement under `platform/src/`.

```ts
export const EVALUATION_RECORD_SCHEMA_VERSION = "1.0";

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type InconclusiveDetail =
  | { kind: "AMBIGUOUS_EVIDENCE"; explanation: string }
  | { kind: "ERROR"; origin: "EXECUTION" | "VERIFICATION"; code: string; explanation: string };

/** One thing the verifier claims to have read from the evidence. */
export interface Observation {
  label: string;            // the verifier's own name for it, e.g. "Tax" — free text
  observedText: string;     // VERBATIM text read from the cited snapshot at the cited ref
  snapshotId: string;       // which provided snapshot it was read from
  ref: string;              // element ref within that snapshot
  normalizedValue?: string; // OPTIONAL interpreted value (e.g. "0.00") — recorded, NOT validated
}

/** Harness-computed; never accepted from the model (mirrors D14). One per observation. */
export interface CitationValidation {
  snapshotProvided: boolean;    // the snapshot was in the evidence set handed to the verifier
  digestMatches: boolean;       // recomputed blob digest === the snapshot event's snapshotDigest
  refPresent: boolean;          // ref exists in that snapshot's refs[]
  observedTextPresent: boolean; // observedText is contained in the accessible name at that ref
  valid: boolean;               // conjunction of the above
  reason?: string;
}

export interface CriterionEvaluation {
  criterionId: string;          // join key into FlowPlan.criteria
  verdict: Verdict;
  inconclusiveDetail?: InconclusiveDetail; // present iff verdict === "INCONCLUSIVE"
  observations: Observation[];
  citationValidations: CitationValidation[]; // 1:1 with observations, harness-computed
  reasoning: string;            // verifier's justification (scrubbed)
  evidence: {                   // exactly what the resolver provided (self-contained / auditable)
    snapshotIds: string[];
    eventRefs?: { seq: number; type: string }[];
  };
}

export interface EvaluationRecord {
  evaluationRecordSchemaVersion: string;
  evaluationId: string;         // harness-assigned ordered index, e.g. "eval-001"
  runId: string;
  flowId: string;
  planHash: string;             // asserted === manifest.planHash before evaluating
  verifierModel: string;        // exact model id
  verifierParams: Record<string, unknown>; // temperature etc. — recorded for Phase 8
  pricingConfigId: string;      // reuse the Phase 2 versioned pricing so cost recomputes
  startedAt: string;
  finishedAt: string;
  flowVerdict: Verdict;
  criteria: CriterionEvaluation[];
  totals: { promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number };
}
```

**Citation validation (the confabulation guard).** For every observation the harness computes
`CitationValidation` from the stored artifacts: the cited snapshot was in the set provided for
that criterion; its blob digest recomputes to the event's `snapshotDigest`; the `ref` is in the
snapshot's `refs[]`; and the verbatim `observedText` is contained in the accessible `name` of
that `ref` in the snapshot's `elements[]`. A verdict that rests on any **invalid** citation is
downgraded by the harness to `INCONCLUSIVE / ERROR / origin:"VERIFICATION" / code:"INVALID_CITATION"`
— the verifier claimed to read something the evidence does not contain, so its verdict cannot be
trusted. The verifier is instructed to cite the **most specific** ref and the **verbatim** text,
which is what makes the containment check pass cleanly. The `normalizedValue` is the verifier's
*interpretation* and is recorded but **not** structurally validated (the harness adjudicating it
would be meaning-work, which D21 forbids). The exact downgrade policy is a verifier-contract-gate
review item.

---

## Task checklist

### Task 1 — Freeze the evaluation-record schema + verdict model
*Serves:* the contract every later task and Phases 4/7/8 build on. Getting it wrong is
expensive to retrofit — hence the gate.
*Next depends on it:* the resolver, verifier, and writer all target this shape.

- [x] Implement `EvaluationRecord` / `CriterionEvaluation` / `Observation` /
  `CitationValidation` / `InconclusiveDetail` / `Verdict` under `platform/src/` with
  `EVALUATION_RECORD_SCHEMA_VERSION = "1.0"`. Independent of `FlowPlan` and the run-log types.
- [x] Freeze the `InconclusiveDetail` union exactly as in D23 and enumerate the codes, each
  annotated with its origin (`EXECUTION` vs `VERIFICATION`).
- [x] Define the aggregation function (all PASS ⇒ PASS; any FAIL ⇒ FAIL; else INCONCLUSIVE)
  with unit tests over every combination incl. INCONCLUSIVE-without-FAIL.
- [x] Add `PROOFLOOP_VERIFIER_MODEL` to `../.env.example` (documentation only; the real value
  is the human's to set). Confirm the committed pricing config can price the verifier model, or
  note that its rates must be added before Task 4 runs live.
- [x] Update `../CLAUDE.md`'s canonical tree to show `platform/runs/<runId>/evaluations/` as the
  evaluation-record location (one line; generated contents gitignored alongside the rest of
  `runs/`).

🚦 **HUMAN GATE:** the human reviews and freezes the evaluation-record schema, the
`InconclusiveDetail` union + code/origin table, the aggregation rule, and approves the
`CLAUDE.md` edit (the constitution is not edited silently).

✅ **COMMIT:** `feat(platform): freeze evaluation-record schema + verdict model`

### Task 2 — Run-log 1.1: capture failed-action evidence (D25)
*Serves:* the factual evidence that lets Phase 3 tell an application-caused inability from an
infrastructure failure. Without it, BUG-007 collapses to a silent INCONCLUSIVE.
*Next depends on it:* the resolver's non-completing-step path reads `failureDetail`.

- [x] Add `failureDetail?: string` and `failureDetailTruncated?: boolean` to `ActionEvent` in
  the run-log schema. Bump `runLogSchemaVersion` to `"1.1"`.
- [x] In `engine/loop.ts`, when an executed element action returns `isError: true`, populate
  `failureDetail` from `ToolResult.text`: **scrub first** (existing run-scoped redaction), **then
  truncate** to a bounded length from the end (preserve the leading diagnostic), setting
  `failureDetailTruncated` when clipped. Leave it absent on successful actions. Do **not** change
  control flow, termination, or guards — this is evidence capture only, no verdict logic.
- [x] Confirm readers still parse `"1.0"` records (the new fields are optional; `readEvents`,
  `verifyAuditChain`, and any 1.1-aware reader must tolerate their absence).
- [x] Tests (these close the agent-reported Phase 2 coverage gap):
  - [x] actuator **throws** ⇒ `ACTION_FAILED` error event, no executed `action` event (unchanged).
  - [x] actuator returns `isError: true` ⇒ `action` event `status:"failed"`, `failureDetail`
    populated, loop continues (unchanged termination behaviour).
  - [x] `failureDetail` is scrubbed (a seeded secret literal never appears) and truncated
    (with `failureDetailTruncated:true`) on an over-long detail.
  - [x] `blocked`, `guard_tripped`, and in-loop `error` terminations each still produce exactly
    one `terminal` snapshot (assert against the real artifacts, not just status).
  - [x] a stored `"1.0"` events.jsonl still reads cleanly under the 1.1 reader.

🚦 **HUMAN GATE:** the human reviews and freezes the 1.1 schema bump (the Phase 2 log schema was
frozen at a gate; this additive change is re-frozen here).

✅ **COMMIT:** `feat(platform): run-log 1.1 — capture failed-action evidence (failureDetail)`

### Task 3 — Deterministic criterion→evidence resolver
*Serves:* the structural layer that hands the verifier the right evidence and nothing else.
*Next depends on it:* the verifier consumes its output; the writer records it.

- [ ] Implement the resolver under `platform/src/`: given a `FlowPlan` and a run directory,
  return, per criterion, the evidence window per D21 (pinned ⇒ boundary-by-stepId + earlier
  boundaries; terminal ⇒ terminal + boundaries; non-completing ⇒ terminal + failed-action/error
  events; never-reached / missing-boundary ⇒ the short-circuit `InconclusiveDetail`). It reads
  snapshot/event records and re-verifies each provided snapshot's digest (reuse the
  `verifyAuditChain` idiom). It performs **no** interpretation of criterion meaning.
- [ ] Resolve the `after`→`step_boundary` join by `{ kind:"step_boundary", stepId }`, and the
  terminal snapshot by `{ kind:"terminal" }`. (Confirmed present and explicit in 1.x artifacts.)
- [ ] Tests run against a **committed frozen fixture** under
  `platform/test/fixtures/runs/add-to-cart-frozen/` — a sanitized slice of the approved Task 7
  run, clearly marked as frozen evidence. Trim by dropping whole unreferenced events/blobs only;
  **never edit a retained blob's `yaml`** (the digest is computed over that text). Preserve event
  structure, snapshot ids, digests, boundary `stepId`s, and the accessible cart totals; keep
  referential integrity for everything the tests walk.
  - [ ] terminal criterion ⇒ resolves to the `terminal` snapshot.
  - [ ] a (synthetic) criterion pinned `(after step 5)` ⇒ resolves to the `S5` `step_boundary`
    snapshot, and never to a later snapshot.
  - [ ] a (synthetic, committed) `blocked`/`error` run where a pinned step never completed ⇒
    resolves to terminal + the failed-action/error evidence for that step.
  - [ ] a run that terminated before the pinned step ⇒ short-circuits to
    `COULD_NOT_EXECUTE`; a completed step with a missing boundary ⇒ `MISSING_BOUNDARY_SNAPSHOT`.
  - [ ] digest mismatch on a provided snapshot is surfaced, not silently used.

✅ **COMMIT:** `feat(platform): deterministic criterion→evidence resolver`

### Task 4 — The per-criterion verifier + citation validation
*Serves:* the reasoning step — the new, measured non-deterministic component.
*Next depends on it:* the writer records its output; the matrix exercises it.

- [ ] Implement a verifier that, per criterion, sends the verifier model (from
  `PROOFLOOP_VERIFIER_MODEL`, key from env, model + params logged) a schema-constrained request
  containing **only** the criterion text and the resolved evidence window, and returns
  `{ verdict, inconclusiveDetail?, observations[], reasoning }`. The prompt frames the task as
  judging whether the stated outcome was achieved from the evidence, states that successful
  navigation is irrelevant, and requires each observation to cite the **verbatim** text and the
  **most specific** `snapshotId`/`ref` it was read from. The verifier receives no execution
  status, no step text, no decider rationale, no ledger, no bug state.
- [ ] After each call, the **harness** computes `CitationValidation` for every observation from
  the stored artifacts (provided / digest / ref-present / observedText-contained-in-accessible-name).
  A verdict resting on any invalid citation is downgraded to
  `INCONCLUSIVE / ERROR / VERIFICATION / INVALID_CITATION`. The validation is harness-computed and
  never read from the model.
- [ ] Apply the D23 non-completing-step rule when the resolver returned failed-action evidence
  rather than a clean boundary snapshot.
- [ ] Run the verifier at the lowest-variance configuration the API supports; record exact model
  and params. Treat low variance as configuration, not a determinism guarantee.
- [ ] Tests with a **mocked verifier model** (no live spend): a PASS path with valid citations; a
  FAIL path; an invalid-citation input ⇒ downgrade to `INVALID_CITATION`; a malformed model
  response ⇒ `VERIFIER_SCHEMA_ERROR`; a hygiene test asserting the assembled prompt for a *buggy*
  state contains **no** execution-status / success field.

🚦 **HUMAN GATE:** the human reviews the verifier prompt and output contract (especially the
no-success-signal hygiene and the citation-downgrade policy) **before** the live model is wired,
and selects the **provisional** verifier model by running a small replay set across candidate
models against the frozen fixture. ✅ record the chosen model + params and the rationale.

✅ **COMMIT:** `feat(platform): per-criterion outcome verifier + citation validation`

### Task 5 — Verdict aggregation + evaluation-record writer
*Serves:* the Phase 3 deliverable — a finished run becomes a verdict artifact.
*Next depends on it:* Tasks 6–7 read these records; Phases 4/7/8 parse them.

- [ ] Implement the writer: load the run manifest, re-parse `fixtures/flows/<flowId>.flow.md`
  deterministically, recompute `planHash`, and **assert it equals** `manifest.planHash` (fail
  loud if not — the criteria must match the executed plan). Resolve evidence, run the verifier
  per criterion, aggregate (D23), and write
  `platform/runs/<runId>/evaluations/<evaluationId>/evaluation.json` with an ordered
  `evaluationId` (a single-writer counter, no randomness). Record verifier model/params, totals,
  and the per-criterion evidence set actually provided.
- [ ] CLI: `npm run verify -- --run <runId>` (flow derived from `manifest.flowId`; never reads
  `app/` source, never the ledger, never `PROOFLOOP_BUGS`/`PROOFLOOP_DEBUG_TOKEN`).
- [ ] Tests: end-to-end over the frozen fixture producing a complete, schema-valid record with a
  correct `flowVerdict`; a planHash mismatch ⇒ fail loud; `evaluationId` increments across two
  passes without overwriting.

✅ **COMMIT:** `feat(platform): verdict aggregation + evaluation record writer`

### Task 6 — The four-state add-to-cart matrix (this IS the exit criterion)
*Serves:* proves heal-structure-PASS, catch-behaviour-FAIL, and the regression trap on one flow.
*Next depends on it:* you do not advance to Phase 4 without this.

The **outer human/harness** sets bug state; the platform runs blind (it sees only `BASE_URL` and
the flow). For each state, the human boots the SUT with the given `PROOFLOOP_BUGS`, runs the
Phase 2 executor on `add-to-cart.flow.md` to produce a run, runs `npm run verify` to produce an
evaluation record, and compares `flowVerdict` to `fixtures/bug-ledger.yaml`:

| State | `PROOFLOOP_BUGS` | Expected `flowVerdict` | Proves |
|---|---|---|---|
| CLEAN | *(empty)* | `PASS` | no false-fail on the happy path |
| MUTATED | `MUT-001` | `PASS` | self-heal across a renamed control |
| BUGGY | `BUG-002` | `FAIL` | a broken total is caught |
| BUGGY+MUTATED | `BUG-002,MUT-001` | `FAIL` | the regression trap — healed button, still-broken total |

- [ ] Produce all four runs + evaluation records; keep them for review.
- [ ] Confirm the **catcher is the proportional rule, not the reconcile invariant.** Under BUG-002
  the cart shows `Tax $0.00` and `Total == Subtotal`, so `Subtotal + Tax == Total` still holds —
  that criterion PASSES the buggy cart. The FAIL comes from "Tax equals 10% of the Subtotal"
  ($0.00 ≠ $5.90). Do not let the verifier or any reading talk itself out of that.
- [ ] Confirm the BUGGY+MUTATED run shows the executor navigating the renamed control (heal) while
  the verifier still returns FAIL on the tax criterion (no healing past behaviour).

🚦 **HUMAN GATE:** the human reviews all four evaluation records, confirms each `flowVerdict`
matches the ledger's `expected_verdict`, and signs off Phase 3 complete. Do not self-certify.

✅ **COMMIT:** `test(platform): four-state add-to-cart verification matrix`

### Task 7 — BUG-007: FAIL, not INCONCLUSIVE (secondary, removable)
*Serves:* the only Phase-3 exercise of the application-caused-inability ⇒ FAIL disambiguation.
*Removable:* if pulled, delete only this task; Task 2 and the resolver's failure path stay.

- [ ] The human boots the SUT with `PROOFLOOP_BUGS=BUG-007`, runs the Phase 2 executor on
  `checkout-mobile.flow.md` (viewport `mobile`, ≤480px), and runs `npm run verify`.
- [ ] Confirm the evidence is present: the place-order action recorded `status:"failed"` with a
  `failureDetail` describing an interception/actionability failure, the control is present in the
  terminal snapshot, and no concurrent infra/transport error sits in the window.
- [ ] Confirm the criterion verdict is **FAIL** (`expected_verdict: FAIL` in the ledger), **not**
  `INCONCLUSIVE`. If the verifier returns INCONCLUSIVE, do not paper over it — inspect whether the
  `failureDetail` is recognisable as an app-level actionability failure and whether the D23 rule is
  correctly applied; report the finding at the gate.

🚦 **HUMAN GATE:** the human confirms BUG-007 ⇒ FAIL (not INCONCLUSIVE) against the ledger.

✅ **COMMIT:** `test(platform): BUG-007 mobile FAIL-not-INCONCLUSIVE case`

---

## Out of scope for Phase 3 (HARD FENCE — do not build)

- ❌ No LLM-written Markdown report / executive summary / screenshots-as-narrative. The
  evaluation record is a machine artifact; the human-readable report is **Phase 4**.
- ❌ No headless execution or headed/headless parity (Phase 5).
- ❌ No CI workflow, PR comments, or trace/video capture (Phases 4/6).
- ❌ No scoring harness, false-pass/false-fail rates, verdict-accuracy tables, or
  cost-vs-script comparison (Phase 7). Phase 3 runs a handful of representative states by hand.
- ❌ No multi-run variance measurement and no replay driver (Phase 8). Reserve the
  `evaluations/<evaluationId>/` layout; do not build the N-pass loop.
- ❌ No new flows; no edits to `fixtures/flows/*.flow.md` or `fixtures/bug-ledger.yaml`.
- ❌ No bug/mutation logic inside the platform; the executor and verifier never see
  `PROOFLOOP_BUGS`, the ledger, the debug token, or `app/` source.
- ❌ No vision/coordinate reasoning and no screenshots as the verification substrate — the
  verifier reads the accessibility-snapshot `yaml`. Screenshots remain debug artifacts.
- ❌ No second self-healing mechanism. Self-heal is demonstrated via MUT-001, not rebuilt.
- ❌ No changes to the Phase 2 execution loop beyond the additive `failureDetail` capture (D25).

---

## Exit Checklist (the gate to Phase 4)

- [ ] Evaluation-record schema, `InconclusiveDetail` union + code/origin table, and aggregation
  rule implemented and human-gated; `EVALUATION_RECORD_SCHEMA_VERSION` set; `CLAUDE.md` tree
  updated (human-approved).
- [ ] Run-log `"1.1"` adds `failureDetail`/`failureDetailTruncated`, scrubbed-then-truncated,
  absent on success; `"1.0"` records still readable; the five failed-action/terminal tests pass;
  human-gated bump.
- [ ] Deterministic resolver: stepId join, ≤-checkpoint window (no future snapshots),
  non-completing fallback, never-reached / missing-boundary short-circuits; tests pass against the
  committed frozen fixture; no criterion-meaning interpretation.
- [ ] Per-criterion verifier emits verbatim-cited observations; the harness hard-validates every
  citation and downgrades on `INVALID_CITATION`; the prompt carries no execution-success signal
  (asserted by test); verifier model + params recorded; provisional model chosen at the gate.
- [ ] Aggregation + writer produce a schema-valid `evaluation.json`; `planHash` asserted equal to
  the run's; `evaluationId` ordered and non-overwriting.
- [ ] The four-state add-to-cart matrix returns ledger-matching verdicts under the human gate
  (CLEAN ⇒ PASS, MUT-001 ⇒ PASS, BUG-002 ⇒ FAIL, BUG-002+MUT-001 ⇒ FAIL); both the heal and the
  still-FAIL are visible in the BUGGY+MUTATED run.
- [ ] (If the BUG-007 track is kept) BUG-007 ⇒ FAIL, not INCONCLUSIVE, confirmed against the
  ledger.
- [ ] The verifier never read `app/` source, the ledger, the debug token, or `PROOFLOOP_BUGS`.
- [ ] `npm test` and `npm run typecheck` pass.

---

## Risks (where this phase quietly goes wrong)

1. **Healing past a regression via a leaked success signal.** If any "execution completed" /
   "all steps passed" signal reaches the verifier prompt, BUG-002+MUT-001 can PASS. The
   no-success-signal hygiene test is the tripwire; keep the verifier's inputs to criterion +
   evidence only.
2. **The wrong catcher for BUG-002.** "Subtotal + Tax == Total" is satisfied when tax is dropped
   to $0.00, so it passes the buggy cart. The proportional rule "Tax equals 10% of the Subtotal"
   is the real catcher. Do not let the verifier rationalise $0.00 tax, and do not "simplify" the
   rule into a hardcoded constant.
3. **Verifier arithmetic non-determinism.** Rule-based criteria push arithmetic into the verifier
   on purpose. That is a Phase 8 reliability finding to measure — never hidden behind memorised
   constants, and never used as a reason to weaken the criteria.
4. **The resolver drifting into criterion interpretation.** The moment it reads criterion text to
   choose snapshots, determinism dies and Phase 2's non-determinism contaminates the deterministic
   layer (the D8 mistake, one phase later). Structural only; the window is a function of position.
5. **A mis-tuned disambiguation rule hiding a real FAIL as INCONCLUSIVE.** The conservative rule
   must still reach FAIL on a genuine application-caused inability. BUG-007 is the test that it
   does; an INCONCLUSIVE there is a finding to inspect, not to accept.
6. **Verifier confabulating a real-ref / wrong-text citation.** A citation that names a real ref
   but misreports its text would justify a false verdict. The verbatim `observedText` containment
   check is the guard; keep it harness-computed and keep the downgrade.
7. **`failureDetail` truncated before it is scrubbed.** Truncate-first can leave a secret fragment
   the literal-based redaction won't match. Scrub, then truncate — always.
8. **Tests depending on the gitignored live `runs/` dir.** Committed tests must read the frozen
   fixture, never a local run. And the fixture's retained blobs must stay byte-exact or every
   digest check breaks.
9. **Re-importing a model-tier assumption.** The architecture must stay tier-agnostic; the model
   is a recorded, configurable choice selected at the gate and measured in Phase 8 — not a baked-in
   "stronger is better" claim.
10. **Conflating the record with the Phase 4 report.** The evaluation record is a machine artifact.
    No prose summaries, executive overviews, or narrative screenshots here.