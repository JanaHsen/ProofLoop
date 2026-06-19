# Phase 5 — Flexible Execution: Headed/Headless Parity ⚙️

> **Goal:** The same unmodified `FlowPlan` runs headless (the CI path) and headed (the
> local-debug path) with no rewriting, and the choice of mode affects **only** the
> browser-launch seam — never any decision, verification, evidence, verdict, logging,
> guard, or redaction logic.
>
> **Exit criterion:** A run accepts a mode selection (default `headless`, `--headed`
> override); the manifest records requested and effective mode plus a typed browser
> configuration under run-log schema `1.2`; an architecture proof and targeted tests show
> mode reaches runtime browser behavior only at the launch seam; controlled checkpoint
> snapshots are **semantically equivalent across modes** after a frozen, human-reviewed,
> closed-by-default normalization; and a single clean flow run in each mode completes,
> verifies, and returns the **same recorded verdict** — labelled a demonstration, not a
> statistical proof of deterministic parity, with repeated cross-mode stability deferred
> to Phase 8.

---

## How to use this file (Claude Code)

1. Read `../CLAUDE.md` first (auto-loaded) — canonical paths and cross-cutting rules.
2. Work the **Task checklist** top to bottom. Tick each `[ ]` as you finish it.
3. **Stop at every `🚦 HUMAN GATE`** and wait for the human. Never self-certify.
4. **Commit at every `✅ COMMIT`** checkpoint with the suggested message. Small, reviewable
   commits.
5. Phases run strictly in order. Do not start Phase 6 until the **Exit Checklist** is fully
   true.
6. Read **Out of scope** before starting. It is a hard fence.
7. **Evidence-first ordering is mandatory.** Task 1 (audit) and Task 2 (delta experiment)
   produce the observations that *design* the run-log change and the normalizer. Do not
   pre-specify the normalizer from theory, and do not implement Task 3 production plumbing
   before the audit confirms the launch seam in code.

---

## Why this phase matters (don't skip the reasoning)

The portfolio brief makes a visible, product-facing promise: the same flow definition runs
**headless in CI and headed for local debugging**, with no per-mode rewriting. That promise
has to be honored.

But the roadmap's literal acceptance bar — *"an identical flow file runs to the same verdict
in both modes"* — is **not a sound proof of parity on its own**, and implementing it
literally builds the wrong thing. Per **D18**, the executor's decider and the Phase 3
verifier both contain intentional LLM non-determinism. A single headed run and a single
headless run returning the same verdict could agree or disagree for reasons that have
nothing to do with mode. You cannot attribute a one-shot verdict match (or mismatch) to mode
versus ordinary flakiness. **Phase 8 exists to measure that variability; Phase 5 must not
pretend to measure it here.**

So Phase 5 splits the claim into two layers:

- **Structural proof (the strong, deterministic claim).** Mode reaches runtime browser
  behavior only at the launch seam; everything else is byte-for-byte the same code path; and
  at controlled, equivalent checkpoints the two modes produce the **same accessibility
  semantics** after an explicitly approved, closed normalization. This is provable and
  largely LLM-free.
- **Live product demonstration (the visible promise, honestly labelled).** One clean flow
  run in each mode completes, both frozen artifacts verify, both selected evaluation records
  return the same verdict — shown as a **demonstration**, with an explicit non-determinism
  caveat and a Phase 8 pointer.

A second-order trap to internalize now: **the normalizer is itself a parity oracle.** An
over-permissive normalizer manufactures false parity — the same disease this platform was
built to cure (enforcement by code, not by vibes), relocated. The normalizer is therefore
constrained hard (D37): closed by default, field-aware, designed only from observed deltas,
independently frozen, and guarded by negative tests that prove it still fails on real
behavioral differences.

A consequence worth stating plainly: **verification is mode-invariant by construction
(D33).** Phase 3 is offline post-hoc replay over frozen artifacts and launches no browser.
There is no "headless verifier." Headed/headless is purely an *execution-layer* property,
which is why this phase is small in code and concentrates its rigor in the audit, the
experiment, and the normalizer.

---

## Decisions locked for this phase

Continuing the global series (D1–D12 Phases 0–1; D13–D19 Phase 2; D20–D25 Phase 3;
D26–D31 Phase 4 — all still apply).

### D32 — Mode affects runtime browser behavior only at the launch seam

Mode **may** be parsed, validated, recorded, and reported outside the launcher — the CLI
must parse the flag, the logger must record it, and the parity tooling must read it. These
are legitimate consumers. The invariant is narrower than "exactly one consumer":

> Mode may be parsed, validated, recorded, and reported outside the launcher, but it may
> affect **runtime browser behavior** only at the MCP/browser launch seam. No
> execution-loop, prompting, verification, evidence-resolution, verdict, reporting, guard,
> or redaction logic may branch on mode.

Enforced by **code inspection plus targeted tests** (Task 5), not by an arity rule that
would wrongly reject the necessary logging and comparison work.

### D33 — Verification is mode-invariant by construction

Phase 3 verification is offline post-hoc replay over frozen artifacts; it launches no
browser. Mode is therefore an execution-layer property only. Cross-mode verdict agreement is
**inherited** from execution-layer snapshot parity plus the recorded artifacts — it is never
separately re-derived by running a "headless verifier," which does not exist.

### D34 — Parity is proven at the deterministic layer, demonstrated at the verdict layer

The provable invariant is **semantic accessibility-snapshot equivalence at controlled,
equivalent checkpoints**, after a frozen, reviewed, closed normalization that preserves
meaningful differences (roles, accessible names, values, checked/disabled/selected states,
relevant text, presence/absence of meaningful elements) and removes only explicitly approved
mode-incidental volatility. End-to-end verdict agreement across modes is a **demonstration**,
explicitly labelled, never claimed as a deterministic guarantee. **Repeated cross-mode
verdict stability is deferred to Phase 8.**

Raw stored-snapshot **digest** equality is **not** required and must not be assumed: the
Phase 2 no-progress guard already normalizes volatile snapshot fields separately from the
audit digest, which is direct evidence that raw bytes are not a stable cross-mode oracle.
Equivalence is asserted over the **normalized** projection, not the raw digest.

### D35 — Run-log evolves additively to `1.2`

The current run log is `1.1` (Phase 3's `failureDetail` bump). Phase 5 takes **`1.2`**:

- `RunManifest.mode` widens from the literal `"headed"` to `"headed" | "headless"` and now
  carries the **effective** mode (what actually ran).
- Add `requestedMode: "headed" | "headless"` (what the operator asked for). It differs from
  `mode` only if a fallback ever occurs; per D36 there is no silent fallback, so today they
  match, but recording both is cheap honesty and the parity artifact wants the pair.
- Add a **typed** `browser` structure (D36 shape) rather than an arbitrary options dump. Do
  **not** log raw subprocess arguments — some may contain machine-specific paths or
  otherwise unstable values that would break determinism and leak the local environment.
- `runLogSchemaVersion → "1.2"`. Every version-aware reader must tolerate `"1.0"`, `"1.1"`,
  **and** `"1.2"`; `requestedMode` and `browser` are optional so older records remain valid.
- Re-opening the Phase 2-frozen log schema is a **human-gated** change accompanied by the
  `CLAUDE.md` edit (the constitution is never edited silently).

### D36 — Headless is the default; `--headed` is the only override; headed-without-display fails loudly

CI (Phase 6) is the production path and has no display server; a headed default would fail
there confusingly. The contract is deliberately minimal:

```bash
npm run run -- <flow>            # headless (default)
npm run run -- <flow> --headed   # headed, for local debugging
```

No `--headless` flag (it would only enable a contradictory `--headed --headless` state) and
**no `PROOFLOOP_HEADED` env duplicate** (a second source of truth for one boolean). If headed
is requested where no display is available, the run **fails loudly with a clear error** — it
must never silently fall back to headless, because a silent fallback would make a "headed"
demonstration secretly headless.

Manifest browser structure:

```ts
mode: "headed" | "headless";          // effective
requestedMode: "headed" | "headless"; // requested
browser: {
  engine: "chromium";
  isolated: true;
  viewport: { width: number; height: number };
  accessibilitySnapshots: true;
  visionEnabled: false;
};
```

Mode is **orthogonal to viewport**: `FlowPlan.viewport` is honored identically in both modes
(this is part of the structural-proof checklist), so D7's mobile-viewport requirement for
BUG-007 is satisfied the same way headed or headless. Phase 5 does not run BUG-007 (see Out
of scope).

### D37 — The parity normalizer is a frozen, closed-by-default, field-aware allow-list

The normalizer is the parity oracle, so it is constrained:

- **Closed by default.** It drops only fields on an explicit approved-volatile allow-list.
  Any field not on the list — including a newly introduced/unknown one — is treated as
  **significant**, so the comparison fails toward *detecting* divergence, never toward hiding
  it.
- **Designed only from observed Task 2 deltas**, not from theory. The Phase 2 no-progress
  volatile set (`[ref=eN]`, `[active]`, `[cursor=…]`) is a starting hypothesis to validate,
  not an answer to copy.
- **Independently frozen**, separate from the no-progress normalizer, because the jobs
  differ: no-progress strips fields to detect "did anything change at all"; parity must
  *preserve* behavioral semantics while removing only mode-incidental volatility.
- **Field-aware over the parsed accessibility tree**, not broad string cleanup, and applied
  to the already-**scrubbed** canonical snapshot (redaction-then-compare, never raw secrets).
- **Negative-guard tested** (Task 4) and emits a **useful diff** (path + headed/headless
  values), not a bare `false`.

---

## Input artifacts and the canonical comparison surface

- The same `fixtures/flows/<flowId>.flow.md` and its `planHash` are used in both modes,
  unmodified. Identical `planHash` across the two runs is asserted, not assumed.
- Checkpoint snapshots are captured through the **production** Phase 2 snapshot-capture and
  canonical serialization (and run-scoped redaction) so that Task 2's observations are valid
  for the production normalizer. The investigation-only launcher (Task 2) supplies only the
  two browser modes; it must not introduce its own snapshot serialization.

---

## Task checklist

### Task 1 — Read-only implementation audit
*Serves:* turns relayed phase documentation into verified, in-repo facts before anything is
changed.
*Next depends on it:* Task 3's plumbing shape and the reader-extension list; Task 2's
launcher.

This task makes **no edits**. Produce a short findings note recording, from the actual code:

- [x] The current `runLogSchemaVersion` constant and **every** site that checks/accepts it
  (expected: `readEvents`, `verifyAuditChain`, the Phase 3 resolver's record readers, the
  Phase 4 report generator, and any manifest loader). List each as a 1.2 reader-extension
  target.
- [x] The launch seam: where `@playwright/mcp` server args are assembled (e.g.
  `buildServerArgs`), and the **exact** headed/headless mechanism today — specifically
  whether headed is produced by injecting a `--headed` flag (server default is headless) or
  by some other means, and whether mode is already parameterized at all.
- [x] A grep proving no execution-loop, prompting, verification, evidence-resolution,
  verdict, reporting, guard, or redaction code currently branches on a mode value.
- [x] The canonical snapshot serialization and the no-progress normalizer's volatile-field
  list, recorded as the *starting hypothesis* for Task 4 (not an answer).
- [x] The flow CLI entry (the `run` script and its arg parser) — the single site where
  `--headed` will be parsed.
- [x] Report all findings to the human before proceeding. If headless is **not** already
  parameterized at the seam, note it: Task 2 will use an investigation-only launcher and
  Task 3 introduces the production parameter.

> **Task 1 audit done & human-approved (2026-06-19).** Server is headed-by-default; mode was
> unparameterized; `SUPPORTED_RUN_LOG_SCHEMA_VERSIONS` is the single reader-extension control;
> no behavioral path branched on mode. An investigation-only launcher was required for Task 2.

*(No commit — this is a read-only audit. Its output is the findings note that gates the
later tasks.)*

### Task 2 — Mode-delta characterization experiment
*Serves:* the empirical evidence base for the normalizer. You cannot freeze a normalizer you
have not measured.
*Next depends on it:* Task 4's allow-list is designed from these observations.

- [x] Stand up the clean SUT (`PROOFLOOP_BUGS` empty). Drive a **harness-navigated**,
  LLM-free set of controlled checkpoints in **both** modes and capture, through the
  production snapshot serialization, the scrubbed accessibility snapshots at each checkpoint.
  Mandatory checkpoints are deterministic, auth-free, server-rendered pages — at minimum
  `/login` and `/form` — where each mode reaches the *same* page state by navigation alone,
  so mode is the sole variable (this removes D18 path-divergence from the experiment).
- [x] If, and only if, Task 1/early results show the static auth-free pages are not
  representative of the stateful surface, escalate to a **deterministic replay driver** that
  re-resolves each recorded step by `(role, accessibleName)` against the current mode's fresh
  snapshot. A failed re-resolution is a parity finding, not an error to mask. Do not build
  the replay driver speculatively. *(Not escalated — static checkpoints showed perfect parity.)*
- [x] Diff the raw (pre-normalization) snapshots across modes at each checkpoint and record
  **every** observed difference: field path, headed value, headless value, and a short note
  on whether it looks mode-incidental (refs/ordering/active/cursor/transient) or behavioral.
- [x] Output a **findings document** enumerating the observed deltas. This document is the
  sole authorized basis for the Task 4 allow-list.

> **Task 2 done & human-approved (2026-06-19).** Findings:
> [`platform/test/investigation/FINDINGS.md`](../platform/test/investigation/FINDINGS.md).
> **Zero** raw cross-mode deltas at `/login` and `/form` (byte-identical scrubbed YAML,
> matching digests, byte-identical same-mode control); `[ref]/[active]/[cursor]` present but
> invariant. **The approved Task 4 dropped-field allow-list is therefore EMPTY.**

**Investigation-only launcher constraint (per the approved tightening):**

> Task 2 may use a temporary test-only / investigation-only launcher that invokes the pinned
> MCP server in both modes. It must **not** alter production execution behavior, the run-log
> schema, or the CLI. Its only outputs are raw snapshots/diffs and the findings document. It
> is **removed**, or converted into committed test infrastructure, **only after the Task 4
> normalizer contract is approved** — and removal is preferred, since Task 6 should drive both
> modes through the production, mode-capable launcher built in Task 3.

✅ **COMMIT:** `test(platform): mode-delta characterization findings (investigation-only)`
*(Commit the findings document and the scratch experiment harness; the investigation-only
launcher is clearly marked non-production and is not wired into the CLI or the run path.)*

### Task 3 — Mode contract and run-log `1.2`
*Serves:* the production mode-selection plumbing and the additive schema it records into.
*Next depends on it:* Task 5 proves the isolation of exactly this plumbing; Tasks 6–7 run
through it.

- [x] Parse `--headed` at the single CLI entry; default `headless`. No `--headless` flag, no
  env duplicate.
- [x] Thread the resolved mode to the launch seam only. Per the Task 1 finding, this is
  either dropping a hardcoded `--headed` by default and re-adding it when requested, or
  introducing the parameter if absent. The Phase 2 writer that currently hardcodes
  `mode: "headed"` is updated to record the **effective** mode. *(Done by introducing the
  parameter; `resolveLaunchArgs` injects `--headless` for headless and omits it for headed.)*
- [x] Headed requested without an available display **fails loudly**; no silent fallback.
- [x] Widen `RunManifest.mode` to `"headed" | "headless"` (effective); add optional
  `requestedMode` and the typed `browser` struct (D36). Do not log raw subprocess args.
- [x] Bump `runLogSchemaVersion` to `"1.2"`. Extend **every** reader identified in Task 1 to
  accept `"1.0" | "1.1" | "1.2"`; keep `requestedMode`/`browser` optional so older records
  read cleanly.
- [x] Update `../CLAUDE.md`: run-log is now `1.2` (readers tolerate 1.0–1.2); manifest
  carries effective `mode` + `requestedMode` + typed `browser`; record the headed/headless
  CLI contract; add the parity-artifact location to the canonical tree if Task 7 introduces
  a tracked path. *(Parity-artifact tree path deferred to Task 7.)*
- [x] Tests:
  - default invocation records `mode: "headless"`, `requestedMode: "headless"`;
  - `--headed` records `mode: "headed"`, `requestedMode: "headed"`, and (where detectable)
    launches with the headed flag;
  - headed-without-display fails loudly with no `"headless"` fallback recorded;
  - a stored `1.1` manifest/events still reads under the 1.2 readers;
  - a `1.2` manifest with `requestedMode`/`browser` round-trips;
  - no raw subprocess argument string is present in the manifest.

🚦 **HUMAN GATE:** the human reviews and freezes the `1.2` schema (the `mode` widening,
`requestedMode`, the typed `browser` struct, the reader-tolerance set) and approves the
`CLAUDE.md` edit. Do not proceed until approved.

> ✅ **APPROVED 2026-06-19.** The `1.2` schema is **frozen**: headless is the default;
> `--headed` is the only override; no `--headless` flag and no env duplicate;
> headed-without-display fails loudly with no fallback; every 1.2 writer requires and records
> effective `mode` + `requestedMode` + a complete typed `browser`; `requestedMode === mode`;
> stored 1.0/1.1 manifests read without the new fields; incomplete/contradictory 1.2 manifests
> fail loudly; mode reaches runtime browser behavior only via `resolveLaunchArgs`; viewport
> logging and MCP launch share one configuration source. `CLAUDE.md` edit approved.

✅ **COMMIT:** `feat(platform): headed/headless mode contract + run-log 1.2`

### Task 4 — Frozen snapshot-parity normalizer
*Serves:* the parity oracle — the single most safety-critical piece of this phase.
*Next depends on it:* Task 6's checkpoint comparison consumes the frozen normalizer.

- [x] Implement a **field-aware** normalizer over the parsed, already-scrubbed accessibility
  tree. Its dropped-field set is a **closed allow-list** derived **only** from the Task 2
  findings document. Anything not on the list is significant.
  *(`platform/src/parity/snapshot-parity.ts`; allow-list `PARITY_DROPPED_FIELDS` is **empty**.)*
- [x] The normalizer emits a structured, human-readable diff: field path, headed value,
  headless value — never a bare boolean. *(`SnapshotParityResult { equal, differences[] }`,
  generic `left`/`right` + optional mode labels; `kind` ∈ added/removed/changed/type_changed.)*
- [x] **Negative-guard suite (minimum)** — all implemented and passing, plus extras
  (selected/ordering/active/cursor/ref/unknown-removed/unknown-changed/scalar-type = 16 total):

  ```text
  accessible name changed       → mismatch
  disabled false → true         → mismatch
  value changed                 → mismatch
  checked state changed         → mismatch
  role changed                  → mismatch
  meaningful element removed     → mismatch
  meaningful element added       → mismatch
  unknown field introduced       → mismatch until explicitly reviewed
  ```

- [x] **Positive tests:** the specific mode-incidental deltas observed in Task 2 normalize to
  equality; nothing outside the observed-and-approved set is silently dropped. *(Task 2 observed
  ZERO deltas → committed sanitized `/login` + `/form` fixtures compare equal; determinism +
  empty-frozen-list + no-`normalizeForProgress` proofs included.)*

🚦 **HUMAN GATE:** the human reviews and **freezes** the normalization allow-list and the
negative-guard suite. The allow-list is a frozen contract; widening it later requires a new
human gate. Do not proceed until approved.

> ✅ **APPROVED 2026-06-19 — allow-list + negative-guard + raw-fidelity suites FROZEN.**
> - Task 2 observed **no** mode deltas (`/login` + `/form`: byte-identical scrubbed YAML,
>   matching digests, byte-identical same-mode control; `[ref]/[active]/[cursor]` present but
>   invariant). Provenance: [`FINDINGS.md`](../platform/test/investigation/FINDINGS.md).
> - The frozen dropped-field allow-list `PARITY_DROPPED_FIELDS` is **empty** and immutable
>   (`Object.freeze([])`); widening it requires editing the constant, the negative-guard tests,
>   this Phase 5 doc, and passing a **new** human gate.
> - **All** fields — including refs, active, cursor, and any unknown/new field — remain
>   significant; comparison is a field-aware deep diff over the full surface (closed by default).
> - The contract is **field-aware semantic comparison plus a closed raw-source fallback**:
>   the parsed model is field-aware but not byte-lossless, so `compareSnapshotYaml` appends a
>   deterministic raw line diff when the models agree but the scrubbed source bytes differ.
>   With the allow-list empty, **any** byte difference in the scrubbed source ⇒ `equal: false`
>   (spacing, blank lines, quoting/escaping, duplicate bracket syntax, line endings).
> - The negative-guard suite (16 cases) proves meaningful changes — name, disabled, value,
>   checked, selected, role, element add/remove, ordering, active, cursor, ref, unknown
>   add/remove/change, scalar type — still mismatch with a structured diff at the correct path;
>   a raw-fidelity suite (8 cases) proves parser-normalized source differences still mismatch.
> - `normalizeForProgress` is neither imported nor reused (asserted by test).

✅ **COMMIT:** `feat(platform): frozen field-aware snapshot-parity normalizer + negative guards`

### Task 5 — Mode-isolation architecture proof
*Serves:* the D32 invariant, enforced rather than asserted.
*Next depends on it:* it is the structural half of the exit criterion.

- [x] Code-inspection record: enumerate every site that reads the mode value and classify
  each as parse / validate / record / report / **launch**. Confirm the only site that lets
  mode change runtime browser behavior is the launch seam.
  *(Record: [`platform/test/architecture/mode-isolation.md`](../platform/test/architecture/mode-isolation.md);
  sole runtime branch = `resolveLaunchArgs`.)*
- [x] Targeted tests proving no execution-loop, prompting, verification, evidence-resolution,
  verdict, reporting, guard, or redaction path branches on mode (e.g. the same fixed inputs
  produce identical decisions/evidence/verdict records regardless of a mode value, since mode
  never enters those code paths). *(`platform/test/mode-isolation.test.ts`: launch-seam, loop
  invariance, prompt isolation, evidence/verdict invariance, guard+cost invariance, report
  invariance, and a static source-surface guard — 8 tests.)*

✅ **COMMIT:** `test(platform): mode-isolation architecture proof (D32)`

### Task 6 — Deterministic checkpoint parity
*Serves:* the deterministic, repeatable parity check — the provable core of D34.
*Next depends on it:* it is the snapshot-equivalence half of the exit criterion.

- [x] Drive the mandatory controlled checkpoints in both modes **through the production
  mode-capable launcher** (Task 3). Remove the Task 2 investigation-only launcher (preferred)
  unless it was explicitly converted into this committed test infrastructure at the Task 4
  gate. *(Both modes go through `PlaywrightMcpClient` → `McpClientOptions.mode` →
  `resolveLaunchArgs`. The Task 2 `InvestigationMcpClient` subclass + its runner + its test
  were **removed**; `FINDINGS.md` kept as the historical record; mode-agnostic capture moved
  to `platform/test/parity/checkpoint-capture.ts`. No alternate mode-launch seam remains.)*
- [x] Apply the frozen Task 4 normalizer; assert semantic equivalence at every checkpoint;
  on mismatch, surface the structured diff. *(`compareSnapshotYaml(headed, headless, {left,
  right})`; allow-list still empty; a mismatch throws `CheckpointParityError` with the diff.)*
- [x] Test runs offline against the clean SUT, with no LLM in the comparison loop.

> **Task 6 RESULT (2026-06-19) — both checkpoints GREEN through the production launcher.**
> Clean SUT (`PROOFLOOP_BUGS` empty, `bugs:[]`). Both modes launched via the production
> `PlaywrightMcpClient`/`resolveLaunchArgs` (no investigation subclass, no overridden args).
> - `/login`: headed `sha256:dad365c4…0626` == headless `sha256:dad365c4…0626` — byteEqual=true,
>   digestEqual=true, `compareSnapshotYaml.equal=true`, differences=0.
> - `/form`: headed `sha256:291973ef…7725` == headless `sha256:291973ef…7725` — byteEqual=true,
>   digestEqual=true, `compareSnapshotYaml.equal=true`, differences=0.
> - **Zero LLM/API participation** (no decider/verifier/summarizer imported; `ANTHROPIC_API_KEY`
>   not read). The frozen dropped-field allow-list **remained empty**. Digests match the Task 2
>   findings exactly, confirming the production path reproduces the observed snapshots.
> - Live command: `PROOFLOOP_LIVE_MCP=1 BASE_URL=http://localhost:3000 node --require
>   ts-node/register/transpile-only --test test/checkpoint-parity-live.test.ts` → 1 passed.

✅ **COMMIT:** `test(platform): deterministic cross-mode checkpoint parity`

### Task 7 — Two-mode live demonstration and parity artifact
*Serves:* the visible product promise (same flow headed-local / headless-CI), honestly
labelled.
*Next depends on it:* nothing in Phase 5; it is the phase's demonstration deliverable.

- [ ] Run the **same** clean flow (`add-to-cart`, `PROOFLOOP_BUGS` empty) once **headless**
  and once **headed**, both fresh under schema `1.2` (a clean same-schema pair — do not pair
  against an older `1.1` headed run).
- [ ] Both executions complete; verify each frozen artifact with `verifyAuditChain`.
- [ ] Run Phase 3 verification (post-hoc replay) over each; confirm both selected evaluation
  records return the **same** flow verdict.
- [ ] Emit a **deterministic JSON parity artifact** (`PARITY_REPORT_SCHEMA_VERSION = "1.0"`,
  stable key ordering) recording:
  - both run IDs;
  - the shared flow ID and `planHash`;
  - requested and effective modes for each run;
  - the checkpoint-pairing method;
  - the normalized snapshot comparison results (with diffs where any);
  - execution statuses;
  - selected evaluation IDs and verdicts;
  - a visible non-determinism caveat.
- [ ] Embed this caveat verbatim in the artifact (and any optional HTML render):

  > This is a single-run cross-mode demonstration, not a statistical proof of deterministic
  > parity. Both the executor and the verifier contain intentional LLM non-determinism (D18).
  > Verdict agreement here shows the same flow ran headed and headless to the same recorded
  > verdict on this run; repeated cross-mode verdict stability is measured in Phase 8.

- [ ] Optional HTML render only: if produced, it inherits the Phase 4 D29 hygiene (escape
  every artifact-derived string, inline CSS only, no scripts, no external resources). HTML is
  not required for the gate.

🚦 **HUMAN GATE:** the human reviews both runs, both verified artifacts, the matching
verdicts, the parity artifact, and the visible caveat. Do not self-certify or commit
presentation artifacts before approval.

✅ **COMMIT:** `feat(platform): two-mode live demonstration + deterministic parity artifact`

---

## Out of scope for Phase 5 (HARD FENCE — do not build)

- ❌ Any claim of deterministic verdict parity, or any repeated-run / verdict-variance
  measurement. (Phase 8.)
- ❌ CI workflows, PR comments, trace, or video. (Phase 6.)
- ❌ Any new verdict, scoring, evidence-resolution, or citation-validation logic. (Frozen in
  Phase 3.)
- ❌ Any mode-dependent execution, prompting, verification, reporting, guard, or redaction
  behavior. Mode reaches runtime browser behavior only at the launch seam (D32).
- ❌ Raw stored-snapshot digest equality as the parity oracle (D34). Equivalence is asserted
  over the normalized projection only.
- ❌ Widening the normalization allow-list beyond the Task 2 observed-and-approved set without
  a new human gate.
- ❌ A `--headless` flag or a `PROOFLOOP_HEADED` env var. One `--headed` override, headless
  default.
- ❌ Logging raw subprocess arguments into the manifest.
- ❌ BUG-007 live demonstration, mobile-mode demonstration, or any non-clean SUT state in the
  live demonstration.
- ❌ A speculative replay driver, unless Task 2 evidence shows static checkpoints are
  unrepresentative.
- ❌ Edits to frozen Phase 1–4 contracts beyond the additive, human-gated run-log `1.2` change.
- ❌ Source-code inspection of `app/`; direct `/debug` use; exposing `PROOFLOOP_BUGS` to the
  executor or any LLM.

---

## Exit Checklist (the gate to Phase 6)

- [x] Task 1 findings note recorded from real code; reader-extension list and launch seam
  confirmed in-repo.
- [x] Task 2 mode-delta findings document produced; investigation-only launcher confined to
  scratch/test, not the production path.
- [x] `npm run run -- <flow>` defaults headless; `--headed` overrides; no `--headless` flag;
  no env duplicate; headed-without-display fails loudly.
- [x] Manifest records effective `mode`, `requestedMode`, and the typed `browser` struct; no
  raw subprocess args; `runLogSchemaVersion = "1.2"`.
- [x] Every version-aware reader accepts `1.0`/`1.1`/`1.2`; a stored `1.1` record still reads.
- [x] `CLAUDE.md` updated (human-gated) for the `1.2` schema, the mode fields, and the CLI
  contract.
- [x] Normalizer is closed-by-default, field-aware, derived only from Task 2 deltas, frozen at
  a gate, and passes the full negative-guard suite; it emits structured diffs.
- [x] D32 isolation proven by code inspection plus targeted tests.
- [x] Controlled checkpoints are semantically equivalent across modes after the frozen
  normalization, asserted deterministically and offline.
- [ ] One clean flow runs headed and one headless, both fresh under `1.2`, both complete, both
  artifacts verify, both verdicts match.
- [ ] Deterministic JSON parity artifact produced with the full field set and the visible
  non-determinism caveat; verdict agreement labelled a demonstration, not proof.
- [ ] `npm test` and `npm run typecheck` pass.

---

## Risks (where this phase quietly goes wrong)

1. **The normalizer manufactures false parity.** The single sharpest risk. An over-permissive
   allow-list "proves" parity that isn't there — the platform's own original failure mode,
   relocated to the oracle. Mitigation: closed-by-default, observed-deltas-only,
   independently frozen, and the negative-guard suite that proves real behavioral flips still
   mismatch.
2. **Treating the live demonstration as proof.** A single headed/headless verdict match is a
   demonstration, not statistical parity; D18 non-determinism is real in both modes.
   Mitigation: the visible caveat and the Phase 8 deferral, structurally separated from the
   deterministic checkpoint proof.
3. **Path divergence contaminating the checkpoint comparison.** If each mode navigates
   independently via the LLM, "different app state from a different path" masquerades as a
   mode difference. Mitigation: harness-navigated auth-free checkpoints (LLM-free); the
   replay driver only on evidence.
4. **A missed `1.2` reader.** Extending some readers but not all yields either a silent
   rejection of valid `1.2` runs or a silent acceptance that skips validation. Mitigation:
   Task 1 enumerates every reader; a back-compat test asserts both `1.1` and `1.2` read.
5. **Silent headed→headless fallback.** A "headed" demonstration that quietly ran headless
   because no display was present would be a false artifact. Mitigation: headed-without-display
   fails loudly; `requestedMode` and `mode` are both recorded and compared.
6. **Mode leaking into behavior.** A convenience branch ("just skip this wait in headless")
   silently breaks D32 and the whole parity claim. Mitigation: the isolation proof (Task 5)
   plus the out-of-scope fence.
7. **Experiment serialization drift.** If the investigation-only launcher captures snapshots
   through a different serialization than production, Task 2's deltas don't transfer to the
   production normalizer. Mitigation: Task 2 reuses the production snapshot serialization;
   the scratch launcher supplies only the two browser modes.