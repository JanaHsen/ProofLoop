# Phase 2 — Execution Engine: Snapshot-Then-Act 🐍

> **Goal:** Drive a real browser through a parsed `FlowPlan`, locating interactive
> elements from fresh live-page accessibility snapshots — never from guessed or
> memorized selectors.
> **Exit criterion:** The `login` and `add-to-cart` flows complete locally in headed
> mode, and the run logs independently prove that every element-targeted action was
> resolved from — and validated against — the latest live snapshot. **No acceptance
> criterion is evaluated and no PASS / FAIL / INCONCLUSIVE verdict is produced in this
> phase.**

---

## How to use this file (Claude Code)

1. Read `../CLAUDE.md` first (auto-loaded) — it pins the canonical paths and the
   cross-cutting rules. Do not deviate from those paths.
2. Work the **Task checklist** top to bottom. Tick each `[ ]` as you finish it.
3. **Stop at every `🚦 HUMAN GATE`** and wait for the human. Do not proceed past it.
4. **Commit at every `✅ COMMIT`** checkpoint using the suggested message. Small,
   reviewable commits.
5. You are NOT done with Phase 2 until the **Exit Checklist** at the bottom is fully
   checked. Do not start Phase 3 before then.
6. Read the **Out of scope** section before you start. It is a hard fence.
7. Phase 1's Exit Checklist must be fully true before you begin (it is). This phase
   stands up the execution engine, the Playwright MCP client, and the logging spine
   inside `platform/`.

---

## Why this phase matters (don't skip the reasoning)

This is the phase the whole platform is named after. The three-post series' central
failure was an LLM confidently writing `#username` when the live page used
`name="username"` — it guessed a selector from its prior instead of reading the page.
**The cure is not a better prompt; it is a hard architectural rule the harness enforces:
no element-targeted action without a fresh snapshot, and every action must reference an
element that provably exists in that snapshot.** If that rule is a request to the model
rather than a constraint in code, the platform's core claim is unfalsifiable.

Two things follow, and they shape every decision below:

- **Enforcement lives in the harness, not the prompt.** The model proposes; the harness
  disposes. The model returns a narrow decision; deterministic code decides whether that
  decision is allowed to become a browser action. This is what makes the Exit-criterion
  *provable from the logs* rather than merely asserted.
- **This is where non-determinism legitimately enters the system — and only here.**
  Phase 1's parser is deterministic on purpose. Phase 2 introduces exactly one
  non-deterministic component: the LLM reading a live page and choosing the next action.
  Everything around it (snapshot timing, reference validation, dispatch, sequencing,
  budgets, logging, cleanup) stays deterministic so that Phase 8 can *measure* the
  reliability of the one non-deterministic part instead of drowning in incidental
  flakiness.

A non-obvious consequence to internalize now: the executor knows **only** `BASE_URL`.
It is never handed a route map, never told where the product list or cart lives. It
reaches every page after the entry page by **clicking links it finds in live
snapshots**. That is the black-box boundary doing real work, and it is also the sharpest
risk in this phase (see Risks).

---

## Decisions already locked (do NOT relitigate)

Continuing the global decision series (D1–D7 from Phase 0, D8–D12 from Phase 1 — all
still apply, especially **D9 action≠outcome** and the black-box boundary). New for
Phase 2:

### D13 — Deterministic harness-controlled outer loop

The LLM does not own the browser loop. The deterministic harness controls: (1) when
snapshots are captured; (2) what context is sent to the LLM; (3) whether the returned
decision is valid; (4) whether an action may reach the MCP server; (5) retries,
timeouts, budgets, and stopping conditions; (6) logging and browser cleanup. The LLM is
used **only** as a schema-constrained, one-action-at-a-time decider.

### D14 — Fresh snapshot before every element-targeted action

Before the LLM may choose an element: (1) the harness captures a fresh accessibility
snapshot; (2) it gives the LLM the current step plus that snapshot's available elements;
(3) the LLM selects one atomic action by element reference; (4) the harness confirms the
reference exists in **that exact snapshot**; (5) only then is the action executed.

An action may **never** use: CSS selectors; XPath; DOM ids supplied from memory; guessed
element names; references from an older snapshot; coordinates derived from a screenshot.
The restriction is enforced by the harness, not merely stated in the prompt.

Harness-owned operations that do **not** target a page element — initial navigation to
`BASE_URL + entry`, viewport setup, snapshot capture, screenshot capture — do not require
an element reference.

### D15 — One schema-constrained LLM decision at a time

For each decision the LLM receives: the current `FlowStep`; the latest accessibility
snapshot; the available element references, roles, and accessible names; a bounded
summary of actions already attempted **in the current step**; and the allowed decision
schema. It must return exactly one of:

```ts
type StepDecision =
  | { kind: "action"; action: AllowedElementAction; ref: string; value?: string; rationale: string }
  | { kind: "step_complete"; rationale: string }
  | { kind: "blocked"; reason: string };
```

`step_complete` means the requested action was performed and an application response was
observed. It does **not** mean the application behaved correctly — outcome judgment is
Phase 3.

For Phase 2, `AllowedElementAction` is scoped to `{ click, type }` — all that `login`
and `add-to-cart` require. Additional actions (select, press, etc.) are added only when a
later flow needs them. Arbitrary selector strings are not an allowed action.

### D16 — Official Playwright MCP, controlled by `platform/`

Use a **pinned** version of Microsoft's official `@playwright/mcp`. `platform/` is the
MCP **client** and launches the server as a managed `stdio` subprocess. The server runs
in **accessibility-snapshot mode**; vision and coordinate-based actions are disabled and
forbidden. The LLM never connects to the MCP server directly — it returns a narrow
decision to the harness, and the harness decides whether that decision becomes an MCP
call. Direct Playwright selectors and direct LLM-to-MCP control are rejected because they
weaken snapshot enforcement, reference validation, guard control, and per-action logging.

### D17 — Isolated browser context per flow run

Each flow run gets **one fresh isolated browser context** that: starts clean; lives for
the whole flow; preserves cookies/state across steps and navigations; closes on finish or
abort. State persists within one flow and must not leak into the next. Session continuity
is **tested and logged**, never assumed.

### D18 — Non-determinism is contained, not eliminated

Non-determinism first enters here, through the LLM decision layer. The surrounding system
stays deterministic (snapshot timing, ref validation, dispatch, sequencing, budgets,
retries, timeouts, logging, cleanup). Phase 8 measures the resulting reliability rather
than pretending the system is fully deterministic.

### D19 — Append-only, auditable run logs

```text
platform/runs/<runId>/
├── run.json            # manifest (atomic finalize)
├── events.jsonl        # append-only event stream
├── snapshots/<snapshotId>.json
└── screenshots/<screenshotId>.png
```

Large snapshots/screenshots stay **outside** `events.jsonl`; events reference them by id,
relative path, and digest. The run log is an **execution artifact, not a Phase 3
evaluation record** (`FlowPlan.schemaVersion` versions the static plan; the run log
carries its own `runLogSchemaVersion`).

---

## Task checklist

### Task 1 — Dependencies, runtime contract, and the `runs/` artifact location

*Serves:* gives the engine its dependencies, its SUT boundary, and a blessed home for
generated artifacts.
*Next depends on it:* every later task imports these deps and writes under `platform/runs/`.

- [x] Add **pinned** versions to `platform/package.json`: `@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk`, `@playwright/mcp`. Keep `app/` and `platform/` independent
  — do **not** add a root package.
- [x] Install the browser from `platform/`: `npx playwright install chromium`.
- [x] Add a `run` script to `platform/package.json` (CLI entry filled in Task 5;
  placeholder is fine now). Keep the existing `test` / `typecheck` / `parse` scripts.
- [x] Create `platform/runs/` with a committed `.gitkeep` **and** a short `README.md`
  explaining that this directory holds generated run artifacts, one subdirectory per
  `runId`, and that its generated contents are gitignored.
- [x] Update `.gitignore` to ignore `platform/runs/*` **while keeping** `.gitkeep` and
  `README.md` tracked (e.g. ignore `platform/runs/*` then negate the two committed files).
- [x] Document the SUT boot command for the human / outer orchestration layer (it is
  **not** the executor's job to start the app): `npm --prefix app run dev` serves the SUT
  on `APP_PORT` (default `3000`), reachable at `BASE_URL` (default `http://localhost:3000`).
- [x] Reaffirm the SUT boundary in code and comments. The executor must **not**: start the
  app by reading `app/`; receive a filesystem path into `app/`; import application code;
  inspect application source. Its only knowledge of the SUT is `BASE_URL`.
- [x] Update `../CLAUDE.md`'s canonical directory tree to list `platform/runs/` as the
  generated-artifact location, with a one-line note that generated contents are gitignored.

🚦 **HUMAN GATE:** the human reviews and approves the `CLAUDE.md` edit (the constitution
is not edited silently) and the `runs/` location before it is frozen.

- [ ] Confirm both are green: `npm test` and `npm run typecheck`.

✅ **COMMIT:** `chore(platform): add pinned LLM + Playwright MCP deps and runs/ artifact location`

### Task 2 — Managed MCP subprocess and browser lifecycle

*Serves:* the actuator layer — a controlled browser the harness drives.
*Next depends on it:* the loop (Task 5) calls snapshot/act through this client.

- [x] Implement an MCP client under `platform/src/` that launches `@playwright/mcp` as a
  managed `stdio` subprocess, performs MCP initialization and capability discovery, and
  closes the subprocess on success, error, timeout, or cancellation. *(`src/mcp/client.ts`;
  cleanup also covers uncaught exception / Ctrl-C via signal handlers; live test confirms
  no orphaned Chromium survives.)*
- [x] Create **one fresh isolated browser context per flow**, kept alive for the whole
  flow and closed on finish/abort. *(`--isolated` = in-memory profile; one subprocess per
  flow = one fresh context; never sets `--user-data-dir`/`--storage-state`.)*
- [x] **Honor `FlowPlan.viewport`** at context/launch time: `desktop` default; `mobile` ⇒
  width ≤480px (via the MCP resize tool). Read the field — never hardcode desktop. (Both
  Phase 2 gate flows are `desktop`, so this runs at the default size; the wiring exists so
  Phase 5/mobile does not require a retrofit.) *(`--viewport-size` from `FlowPlan.viewport`
  at launch: desktop 1280x720, mobile 390x844; `resize()` also exposed.)*
- [x] Navigate to `BASE_URL + FlowPlan.entry`, capture an accessibility snapshot, and
  confirm element references are returned from it. *(client `navigate()`+`snapshot()`;
  live test confirms refs returned. `BASE_URL+entry` composition is the engine's job
  (Task 5) and is exercised against the real SUT at Task 6; Task 2 proves the mechanism
  SUT-independently against a `data:` page.)*
- [x] Disable/refuse vision and coordinate-based actions at the client boundary (not just
  in the prompt). *(Two layers: launch never passes `--caps vision` and discovery asserts
  zero coordinate tools present; dispatch allowlist + ref-token guard refuse any non-
  allowlisted tool or selector-as-target.)*
- [x] **Context isolation + persistence test:** prove that browser state set in one
  context persists across an in-context navigation, and that a second fresh context does
  **not** see it. Log the result as a `session_continuity` event. *(Cleanly-provable-now
  subset done: isolated-session config proven deterministically (`buildServerArgs` tests)
  + live mechanism (fresh isolated session works end-to-end). The substantive cross-flow
  no-leak / authenticated-continuity proof and the `session_continuity` **event** ride on
  the Task 6 login run + the Task 5 logging spine — `data:` pages have opaque origins so
  no clean SUT-independent cookie test exists, and per the note below no synthetic auth-
  free test was manufactured.)*
- [x] **Note on authenticated continuity:** the *authenticated*-session proof (a real
  login surviving navigation to the protected product page) is cleanest to observe during
  the Task 6 `login` run, where the loop already performs the login. Do **not** build a
  throwaway, non-product login helper here solely to assert auth continuity; keep Task 2's
  test to the context mechanics above and let Task 6 demonstrate authenticated continuity.
  *(Acknowledged — no throwaway login helper built.)*

✅ **COMMIT:** `feat(platform): managed Playwright MCP client + isolated flow context`

### Task 3 — Freeze the execution-loop and guard contract

*Serves:* the deterministic skeleton that makes the LLM safe to wire in.
*Next depends on it:* Task 5 implements exactly this, and the guards bound cost/runaway.

Define the loop **before** wiring the real LLM call:

```text
capture fresh snapshot
   → request one decision
   → schema-validate decision
   → validate selected ref against the CURRENT snapshot
   → execute one allowed action
   → observe and record result
   → repeat until step_complete, blocked, or a guard trips
```

- [x] Define `AllowedElementAction` = `{ click, type }` and explicitly prohibit arbitrary
  selector strings. *(`mcp/tools.ts`; `StepDecision` in `engine/protocol.ts`. The one-way
  ref→target seal is structural: `ValidatedRef` (branded, sole producer `validateRef`) is
  the only thing the client turns into a `target`, so model free-text can never reach it.)*
- [x] Define the guards (all of them): max actions/step; max actions/flow; max LLM
  calls/step; max LLM calls/flow; wall-clock timeout; prompt-token ceiling;
  completion-token ceiling; cost ceiling; repeated-action detection; no-progress detection
  (e.g. snapshot digest unchanged after an action that claimed progress); cancellation
  handling. Pick concrete starting values; they are tunable, not sacred. *(`engine/guards.ts`
  `DEFAULT_GUARDS` + `GuardTracker`. repeated-action + no-progress are MERGED into one
  digest-keyed guard so "add twice" can't false-trip; the no-progress key normalizes
  volatile bits (refs/active/cursor) and is separate from the audit digest. Cost/token
  ceilings flagged PROVISIONAL + kept generous (cost $5) so the gate flows can't false-trip;
  reconciled at Task 4/5.)*
- [x] Define the invalid-response policy: an invalid model response gets **at most one
  bounded correction attempt**. For an invalid reference specifically: (1) do not send the
  action to MCP; (2) record the rejected decision; (3) record an `INVALID_SNAPSHOT_REF`
  error; (4) allow at most one correction; (5) capture a fresh snapshot before retrying;
  (6) stop with an execution error if the correction also fails. *(`engine/protocol.ts`:
  `MAX_CORRECTIONS_PER_DECISION=1`, `INVALID_SNAPSHOT_REF`, `buildCorrectionNotice` — the
  single correction is INFORMED (fresh snapshot + what was wrong + available refs), not a
  blind re-roll.)*

🚦 **HUMAN GATE:** the human reviews and approves the decision schema, allowed actions,
reference-validation rule, retry policy, and guard values **before** the real LLM is
connected. ✅ *APPROVED (with refinements folded in): one-way ref→target discipline made
structural; informed single correction; merged digest-keyed no-progress with volatile
normalization; enum-of-current-refs kept as a steering aid with harness validation
authoritative; cost/token ceilings provisional pending Task 4/5. Guard numbers approved as
starting values.*

✅ **COMMIT:** `feat(platform): execution protocol + bounded guard contract`

### Task 4 — Freeze the Phase 2 run-log schema

*Serves:* the logging spine that feeds Phases 4 (reporting), 7 (eval), 8 (reliability).
*Next depends on it:* every downstream number is traced back to these records. Getting it
wrong is expensive to retrofit — hence the gate.

**`run.json` (manifest):**

```ts
interface RunManifest {
  runLogSchemaVersion: string;
  runId: string;
  flowId: string;
  planHash: string;          // digest of serializeFlowPlan(plan) — the exact plan executed
  model: string;             // decider model id (env-configurable; a Phase 7 cost variable)
  mode: "headed";
  startedAt: string;
  finishedAt?: string;
  executionStatus:
    | "running"              // self-written while live
    | "completed"
    | "blocked"
    | "guard_tripped"
    | "error"
    | "cancelled"
    | "crashed";             // NEVER self-written — only a recovery/reader tool stamps this
  pricingConfigId: string;
  totals: {
    promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number;
    snapshotCount: number; actionCount: number; errorCount: number; retryCount: number;
  };
}
```

- [x] Do not use the word `outcome` for execution status — later phases reserve
  outcome/verdict for application behavior. *(`run/schema.ts` uses `executionStatus`; no
  `outcome`/verdict anywhere.)*
- [x] A live run only ever writes `running → { completed | blocked | guard_tripped | error
  | cancelled }`. `crashed` is **reader-inferred**: if the process dies with status still
  `running`, a reader classifies it as crashed from the event stream. *(`finalize()`'s type
  excludes `running`/`crashed`; `audit.ts` `inferCrashed()` is the only producer.)*
- [x] **Atomic finalize:** write the full replacement to a temp file, flush/close, then
  rename to `run.json`. *(`logger.ts` writes `run.json.tmp` then `renameSync`.)*

**`events.jsonl`:**

```ts
interface BaseRunEvent {
  runLogSchemaVersion: string;
  runId: string;
  seq: number;     // harness-assigned, strictly increasing, single writer
  ts: string;
  type: RunEventType;
  stepId?: string;
}
```

Event types: `flow_start`, `flow_end`, `step_start`, `step_end`, `snapshot`,
`llm_decision`, `action`, `error`, `retry`, `screenshot`, `guard_tripped`,
`session_continuity`.

- [x] `seq` is assigned **only** by the harness, strictly increasing, from a single event
  writer. *(`RunLogger` is the single writer; `seq = ++counter` per `append()`.)*
- [x] The writer appends one complete JSON object per line, flushes at defined boundaries
  and after critical events, preserves all complete lines after a crash, and treats **one
  truncated final line as a recoverable crash artifact** (not corruption — readers
  tolerate it). *(`appendFileSync` per event = each line flushed complete; `audit.ts`
  `readEvents()` tolerates one truncated final line.)*

**Snapshot→action audit chain (the Exit-criterion proof):**

Every element-targeted `llm_decision` records: `decisionId`, `stepId`, `snapshotId`,
`snapshotDigest`, selected `ref`, selected `action`, model `rationale`. Every executed
element-targeted `action` records: `decisionId`, `stepId`, `snapshotId`,
`snapshotDigest`, `ref`, `action`, execution result, and a **harness-generated**
reference-validation result. Example:

```json
{
  "type": "action", "decisionId": "decision-007",
  "snapshotId": "snapshot-004", "snapshotDigest": "sha256:...",
  "ref": "e16", "action": "click",
  "refValidation": { "valid": true, "validatedBy": "harness" },
  "resolvedFrom": "snapshot-004", "status": "executed"
}
```

- [x] `refValidatedAgainstSnapshot` (or its equivalent) is **always computed by the
  harness and never accepted from the model**. *(`refValidation.validatedBy` is the literal
  type `"harness"`; the loop computes it via `validateRef`, never reads it from the model.)*
- [x] A later reader must be able to: load the referenced snapshot; verify its digest;
  confirm the ref existed; confirm the action used the same snapshot and ref. Log enough
  to make that independently verifiable. *(`audit.ts` `verifyAuditChain()` does exactly this
  from stored artifacts; tested incl. ref-not-present + digest-tamper detection.)*

**Boundary snapshots for Phase 3:**

- [x] Capture and store: the fresh snapshot used before every element-targeted action; a
  **step-boundary** snapshot after every completed step (so Phase 3 can evaluate
  `(after step N)` criteria); and one **terminal** snapshot immediately before `flow_end`
  (for criteria with no `after`). *(Schema + storage frozen: `recordSnapshot(..., kind)`
  with `kind ∈ {pre_action, step_boundary, terminal}`; the loop emits all three at the
  named points in Task 5.)*

**Sensitive data handling:**

- [x] Never log passwords, API keys, tokens, or other sensitive typed values in clear
  text. When the snapshot identifies a password/sensitive field, record
  `{ "value": "[REDACTED]", "valueLength": 11, "sensitive": true }`. Apply the same
  redaction to **stored snapshots** if they expose entered values. *(`run/redaction.ts`:
  structural-first (password-type) + name-regex augmentation, fail-safe; record shape as
  specified; `redactValuesInText` scrubs stored blobs before digesting. Structural signal
  source + whether snapshots expose values finalized at Task 6; `valueLength` flagged as a
  length-oracle to bucket/drop in hosted/Phase 6+.)*

**Token and cost accounting:**

- [x] Store the **raw** model usage (prompt/input and completion/output tokens) as
  returned by the API. Compute `costUsd` from a **versioned pricing configuration** (no
  inline magic numbers), and retain `pricingConfigId` so Phase 7 can recompute cost from
  raw usage. *(`llm_decision.usage` stores the full API usage verbatim incl.
  `cache_creation_input_tokens`/`cache_read_input_tokens` even when zero; rates live in the
  committed `config/pricing.anthropic-2026-06.json`; `computeCostUsd` recomputes from raw
  usage + committed rates.)*

**Ground-truth separation:**

- [x] `PROOFLOOP_BUGS` must never be: placed in the LLM prompt; exposed through the
  decision context; used by the executor to change behavior; read from app source. The
  Phase 2 executor does not write bug-state ground truth into its manifest. If Phase 7
  later needs ground truth, the **outer** evaluation harness may write a separate,
  evaluator-owned `platform/runs/<runId>/ground-truth.json` that is inaccessible to the
  action-deciding LLM and the Phase 2 execution logic. *(The manifest has no bug-state
  field; the MCP subprocess env is `stripSensitiveEnv` (PROOFLOOP_/ANTHROPIC_ removed).)*

🚦 **HUMAN GATE:** the human reviews and freezes the manifest, event, artifact-reference,
redaction, pricing, and audit-chain schemas. ✅ *APPROVED (with the five decisions +
enrichments folded in): runLogSchemaVersion "1.0"; planHash = sha256(serializeFlowPlan);
structural-first fail-safe redaction (regex now, structural signal at Task 6); verbatim
usage incl. cache tokens + committed versioned pricing file; schema-include /
capture-none screenshots.)*

✅ **COMMIT:** `feat(platform): versioned append-only execution logging spine`

### Task 5 — Implement the snapshot-then-act engine

*Serves:* the working engine — the Phase 2 deliverable.
*Next depends on it:* Tasks 6–7 run real flows through it.

Wire the real Anthropic Messages API decision call (tool-use / schema-constrained,
`ANTHROPIC_API_KEY` from env, `model` from env and logged) into the approved loop. For
each `FlowStep`:

- [x] (1) emit `step_start`; (2) capture a fresh snapshot; (3) store snapshot + digest;
  (4) request one schema-constrained decision; (5) record raw token usage + latency;
  (6) schema-validate the response; (7) if an action, validate the ref against the
  **current** snapshot; (8) execute the validated action through MCP; (9) record decision,
  validation, action, result; (10) repeat from a fresh snapshot; (11) on `step_complete`,
  capture a step-boundary snapshot and emit `step_end`; (12) on `blocked`, guard trip, or
  execution error, stop per the frozen execution-status rules. *(`engine/loop.ts` `runFlow`;
  decider = `engine/decider.ts` (real Messages API tool-use, model `claude-sonnet-4-6` from
  env, key from env, never logged). LLM is decider-only — harness does validateRef →
  ValidatedRef → dispatch; model never sees `target`/MCP/secrets. `step_complete` = action
  performed + response observed, never correctness. No verdict logic.)*
- [x] After the final step: capture the terminal snapshot; emit `flow_end`; compute
  totals; atomically finalize the manifest; close the context and MCP subprocess. *(terminal
  snapshot best-effort; `flow_end` carries executionStatus; `finalize()` atomic; actuator
  closed in `finally`.)*
- [x] **Test every guard** using mocked model decisions or controlled fixtures. Guard
  tests must not require actually spending unbounded tokens/cost or hitting the live API.
  *(`test/loop.test.ts`: mocked decider + actuator cover happy path, redaction in events +
  stored snapshots, no-progress / action-cap / llm-call-cap / cancellation trips, invalid-
  ref (correct-then-error + correct-then-recover), schema-invalid, blocked — all offline.
  One env-gated live Sonnet smoke (`test/decider-live.test.ts`) confirmed the mock matches
  the real tool-use + usage shape (incl. cache_creation breakdown) before trusting mocks.)*

✅ **COMMIT:** `feat(platform): harness-controlled snapshot-then-act execution loop`

### Task 6 — Bootstrap run: `login`

*Serves:* the minimal end-to-end proof; the fastest green that exercises the `#username`
cure directly.

Run `login.flow.md` locally in headed mode against the **clean** SUT
(`PROOFLOOP_BUGS` empty). The run must finish `executionStatus: completed`, and the logs
must prove: the initial page was reached via `BASE_URL + entry`; the username and password
fields came from live snapshots; the selected refs existed in those snapshots; no selector
string or coordinate action was used; the authenticated session survived navigation to the
protected product page; sensitive values were redacted. **No acceptance criterion is
evaluated.**

🚦 **HUMAN GATE:** the human watches the headed run and inspects the
snapshot→ref→action chain.

✅ **COMMIT:** `test(platform): headed login bootstrap run`

### Task 7 — Phase 2 exit run: `add-to-cart`

*Serves:* the real exit gate — genuine intent disambiguation among similar controls.

Run `add-to-cart.flow.md` locally in headed mode against the **clean** SUT. The run must
finish `executionStatus: completed` and demonstrate: login + session continuity;
navigation across multiple pages (by clicking links found in snapshots, never by a
known route); intent-based selection of the **Desk Lamp** among multiple products and
correct association with its nearby add control; repeated execution of "add twice";
correct association of the **Coffee Mug** with its add control; navigation to the cart;
and every element-targeted action resolved from a fresh live snapshot.

This is the Phase 2 exit gate because it tests genuine intent disambiguation, which
`login` cannot. `checkout` and `checkout-mobile` are **deferred — unnecessarily complex
for the minimum Phase 2 gate, not outside the execution engine's eventual remit.**

🚦 **HUMAN GATE:** the human watches the headed run and independently verifies the full
audit chain from the stored artifacts.

✅ **COMMIT:** `test(platform): headed add-to-cart Phase 2 exit run`

---

## Out of scope for Phase 2 (HARD FENCE — do not build)

- ❌ Acceptance-criterion evaluation; PASS / FAIL / INCONCLUSIVE verdicts; evaluator
  reasoning; any application-behavior judgment. (Phase 3.)
- ❌ Mutation testing or any self-healing reliability claim. (Phase 3.)
- ❌ Headless execution or headed/headless parity. (Phase 5.)
- ❌ Playwright trace or video recording. (Phase 4.)
- ❌ CI/CD workflows, PR comments, reports. (Phases 4/6.)
- ❌ Visual or coordinate-based action selection. Screenshots may be captured as debugging
  artifacts but **never** used to choose action coordinates.
- ❌ Source-code inspection; direct imports from `app/`; direct use of `/debug`; sending
  `PROOFLOOP_DEBUG_TOKEN`; exposing `PROOFLOOP_BUGS` to the executor or LLM.
- ❌ Direct LLM-to-MCP connector control.

---

## Exit Checklist (the gate to Phase 3)

- [ ] `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `@playwright/mcp` pinned; Chromium
  installed; MCP server lifecycle-managed over `stdio`.
- [ ] `platform/runs/` exists with committed `.gitkeep` + README; generated contents
  gitignored; `CLAUDE.md` updated (human-gated).
- [ ] Accessibility snapshots used; vision/coordinate actions disabled; arbitrary selectors
  forbidden by the action contract.
- [ ] One fresh isolated browser context per flow; state persists within a flow, isolated
  across flows; viewport read from `FlowPlan`, not hardcoded.
- [ ] The harness forces snapshot-before-decision; every element-targeted action uses a ref
  from the **latest** snapshot; invalid/stale refs are rejected before reaching MCP.
- [ ] The snapshot→ref→action chain is independently re-verifiable from the logs.
- [ ] Every guard has a passing test that demonstrates it trips correctly; one bounded
  correction is allowed for an invalid response, then execution stops.
- [ ] Manifest + events carry `runLogSchemaVersion`; `planHash` ties each run to the exact
  parsed `FlowPlan`; `seq` harness-generated and strictly increasing; manifest finalize is
  atomic; JSONL preserves complete events after a crash; blobs referenced by id + digest.
- [ ] Step-boundary and terminal snapshots captured.
- [ ] Raw token usage, latency, and recomputable cost (versioned pricing) recorded;
  sensitive values redacted; `PROOFLOOP_BUGS` absent from all executor and LLM context.
- [ ] `login` and `add-to-cart` both complete in headed mode and prove live-snapshot
  element resolution.
- [ ] No verdict or criterion-evaluation logic exists.
- [ ] `npm test` and `npm run typecheck` pass.

---

## Risks (where this phase quietly goes wrong)

1. **Navigability — the sharpest risk.** The engine knows only `BASE_URL + entry` and must
   reach the product list and cart by **clicking links it finds in snapshots**. If any
   required page is reachable only by a URL the engine was never given, `add-to-cart`
   cannot run black-box. Phase 1's manual walk implies visible links exist — confirm it
   early (during Task 6/7 bring-up), not at the gate. If a link is genuinely missing, that
   is a finding about the app/flow, not a reason to hand the engine a route.
2. **Enforcement that lives in the prompt, not the harness.** If `refValidatedAgainstSnapshot`
   is ever taken from the model, or the snapshot is ever skippable, the Exit criterion
   becomes unprovable. Validation and snapshot-forcing must be deterministic code.
3. **Snapshot→action races.** The page can change between snapshot capture and action
   dispatch (the SUT deliberately has some async rendering). A ref valid at capture can be
   stale at dispatch. Surface it as an error/retry — never silently mis-target. This is
   Phase 8 fuel, not something to mask here.
4. **A runaway agentic loop.** A model that never returns `step_complete`, or oscillates
   between two actions, burns tokens without progress. The per-step/flow action caps, LLM-
   call caps, no-progress detection, and cost/wall-clock ceilings are what stand between a
   demo and a bill. Test that they trip.
5. **Scope creep into verdicts.** The temptation to "just check the total while we're here"
   is how Phase 3 leaks backward. `step_complete` means *an action happened and a response
   was observed* — nothing about correctness. Keep all judgment out of Phase 2.
6. **Context bleed.** If contexts are reused across flows, a stale cookie can make a later
   flow pass for the wrong reason. One fresh isolated context per flow, verified isolated.
7. **Silent type rot.** Tests run under `transpile-only` and do not type-check. The richer
   MCP/SDK types only stay honest if `npm run typecheck` is part of the gate.