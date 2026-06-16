# Phase 1 — Natural-Language Flow Definition 📝

> **Goal:** Let a non-engineer describe a flow and its expected outcome in plain English,
> and turn that file **deterministically** into a structured plan the engine will later
> consume.
> **Exit criterion:** A `*.flow.md` file parses into a structured plan with its acceptance
> criteria intact, validated on the five canonical flows; re-parsing the same file is
> byte-identical.

---

## How to use this file (Claude Code)

1. Read `../CLAUDE.md` first (auto-loaded) — it pins the canonical paths and the
   cross-cutting rules. Do not deviate from those paths.
2. Work the **Task checklist** top to bottom. Tick each `[ ]` as you finish it.
3. **Stop at every `🚦 HUMAN GATE`** and wait for the human. Do not proceed past it.
4. **Commit at every `✅ COMMIT`** checkpoint using the suggested message.
5. You are NOT done with Phase 1 until the **Exit Checklist** at the bottom is fully
   checked. Do not start Phase 2 before then.
6. Read the **Out of scope** section before you start. It is a hard fence.
7. Phase 0's Exit Checklist must be fully true before you begin (it is: tags `v0-clean`
   and `v0-ground-truth` exist). This phase stands up `platform/` for the first time.

---

## Why this phase matters (don't skip the reasoning)

This is Pillar 1 — the product's front door. Two non-negotiables drive every decision
below:

- **Acceptance criteria are mandatory, not decorative.** The whole thesis is catching
  *subtle* bugs. A flow that only lists steps and never states what "correct" means
  cannot catch a wrong total or a silently-lost order — it can only confirm a button got
  clicked. **A flow with zero acceptance criteria is a hard parse error**, by design.

- **The parser must be deterministic, and it is deterministic *because* it does not
  understand the English.** Phase 1 structures the *document* — it carves the file into
  metadata, an ordered list of step strings, and a list of criterion strings — and
  preserves that text **verbatim**. It never converts "log in as alice" into
  `{navigate, fill, click}`. That semantic interpretation is Phase 2's LLM reading a live
  page, and that is the one place non-determinism legitimately belongs. If we let any
  meaning-interpretation (or LLM "help") leak into this parser, we import Phase 2's
  non-determinism into the one layer the eval harness and CI need to be reproducible. Same
  file in → same plan out, every run, or every downstream number is built on sand.

`platform/` is empty today and the repo has no test infrastructure. Phase 1 bootstraps the
parser **and** the first test runner inside `platform/`, as its own package, independent of
`app/`. That independence is not cosmetic: a separate package makes it structurally
impossible for the tester to `import` from the SUT's source, which is how the black-box
boundary is *enforced* rather than merely promised.

---

## Decisions already locked (do NOT relitigate)

Continuing the global decision series from Phase 0 (D1–D7).

- **D8 — The parser is deterministic and structural ONLY.** It never interprets the meaning
  of a step or criterion. Step/criterion English is preserved verbatim as opaque strings.
  No LLM, no semantic keyword-matching. IDs are derived deterministically from position;
  **no UUIDs, no timestamps, no randomness** anywhere in the output.

- **D9 — Action ≠ outcome (forward contract to Phase 2).** Steps are actions the user
  performs; criteria are assertions about outcomes. A step "succeeds" when its action was
  *performed and a response observed* — **not** when the outcome was favorable. A `400`
  validation response is a *completed* submit, not a failed step. Outcome judgment lives in
  criteria, never in step execution. (This is what makes the BUG-003 negative path
  expressible without any special grammar.)

- **D10 — Criteria assert OUTCOMES the user achieved, never element labels, link/button
  text, selectors, HTTP status codes, or DOM structure.** This is the Phase-1 authoring
  expression of the standing "assert intent, not elements" rule, and it is exactly what lets
  these same five flows self-heal across the Phase 3 mutations (a renamed button or moved
  element must not change a verdict). A criterion that says "a button labelled 'Add to Cart'
  exists" or "expect HTTP 422" is a defect in the flow.

- **D11 — Three-outcome verdict space (forward contract to Phases 3/4/7).** Each criterion
  will resolve to **PASS / FAIL / INCONCLUSIVE**. **ERROR** (could-not-execute /
  could-not-interact / could-not-inspect) is recorded as a *reason under* INCONCLUSIVE,
  kept distinct from ambiguous-evidence, because an unreliable platform and an indecisive
  one are different failure modes worth reporting separately. **Phase 1 builds none of this.**
  Its single obligation toward it is to emit **stable criterion IDs** — the join key later
  phases attach evidence, evaluator reasoning, and outcomes to.

- **D12 — Black-box authoring + separate coverage map.** Flow files contain **no** bug ids,
  **no** selectors, **no** source references. The flow→bug coverage map lives at
  `fixtures/flow-coverage.md` (next to the ledger), **never** inside `fixtures/flows/`,
  which is the tester's input directory.

These hold from prior phases and still apply: **never guess a selector** (the parser never
emits one — there's nothing to guess from, it never reads a page); **assert intent, not
elements** (D10); **black-box boundary = the URL** (flows reference relative paths, never a
filesystem path into `app/`); **secrets by layer / nothing hardcoded**.

---

## The flow file format (`*.flow.md`)

A thin, fixed skeleton around plain English. The skeleton exists so a no-LLM parser can
carve the file; the English inside the skeleton is what the non-engineer writes and what
Phase 2 later interprets. The grammar is **domain-agnostic**: front-matter + `Steps` +
`Acceptance Criteria`. There are **no** commerce concepts (cart, product, order) reserved as
keywords or schema fields — those words appear only inside the opaque English.

**Front-matter** (YAML-style block fenced by `---`), fixed small schema:

| Key | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | Human title of the flow. |
| `entry` | no | `/` | Relative path the run starts on; appended to `BASE_URL`. Never an absolute URL, never a path into `app/`. |
| `viewport` | no | `desktop` | `desktop` or `mobile` only. `mobile` ⇒ Phase 5 runs the flow at ≤480px. Phase 1 only records the label. |
| `tags` | no | `[]` | Free-form author labels. **Never** bug ids. |
| `description` | no | — | Optional one-liner. |

Unknown front-matter keys are a **parse error** (fail loud — a typo'd key must not be
silently ignored).

**`## Steps`** — an ordered (numbered) markdown list, ≥1 item. Each item is one action in
plain English. Preserved verbatim.

**`## Acceptance Criteria`** — a markdown list, **≥1 item** (zero ⇒ hard error). Each item
is one outcome assertion in plain English, preserved verbatim. A criterion item **may**
end with the optional suffix `(after step N)` to pin *when* it is evaluated; absent ⇒ the
criterion is **terminal** (evaluated at flow end). `N` must reference an existing step
ordinal, else parse error. (Only step-association is supported; no named checkpoints.)

### Annotated example

```markdown
---
name: Complete checkout and confirm the order persists
entry: /login
viewport: desktop
tags: [checkout, persistence]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" twice and the "Coffee Mug" once.
3. Proceed to checkout and place the order.
4. Revisit the order's own link as a fresh visit.

## Acceptance Criteria
- Placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order — not an error page and not a dead end. (after step 3)
- On the confirmation, the figures reconcile: the Subtotal plus the Tax equals the Total shown. (after step 3)
- When the order's own link is revisited, the same order is still retrievable and shows the same items and the same Total as when it was placed. (after step 4)
```

Note what the criteria do **not** say: no button text, no element ids, no HTTP codes, no DOM
positions. They assert what the *user* achieved. That is why the same file will pass
unchanged when Phase 3 renames the checkout button or moves it in the DOM.

**Criteria encode the rule, not the output.** Write "the Tax equals 10% of the Subtotal", not
"the Tax is $5.90". A memorised constant is brittle (it breaks the moment the catalogue or a
price changes), it does not carry to another app, and — fatally for the thesis — it is
indistinguishable from a dumb script's `assert text == "$5.90"`, so it forfeits the
intent-based advantage exactly where Phase 7 sets out to measure it. State the relationship
the app must honour and let the verifier read the live figures and check it. (Knowing the rule
— "tax is 10%" — is not reading source; it is knowing the spec, which is what writing an
acceptance criterion *is*. The black-box boundary forbids reading `app/`'s code, not knowing
what the product is supposed to do.)

---

## The structured plan (the parser's output — the contract Phase 2 consumes)

Illustrative TypeScript; Claude Code finalises naming/placement under `platform/src/`.

```ts
export type Viewport = "desktop" | "mobile";

export interface FlowStep {
  id: string;      // deterministic, positional, flow-namespaced, e.g. "checkout:S1"
  ordinal: number; // 1-based
  text: string;    // verbatim plain English — OPAQUE to Phase 1
}

export interface FlowCriterion {
  id: string;      // deterministic, positional, flow-namespaced, e.g. "checkout:C3"
  ordinal: number;
  text: string;    // verbatim plain-English assertion — OPAQUE to Phase 1
  after?: string;  // step id this criterion is evaluated after; absent => terminal
}

export interface FlowPlan {
  schemaVersion: string;     // version of THIS static plan schema (e.g. "1.0")
  id: string;                // from filename: "checkout.flow.md" => "checkout"
  name: string;
  description?: string;
  entry: string;             // relative path appended to BASE_URL; default "/"
  viewport: Viewport;        // default "desktop"
  tags: string[];
  steps: FlowStep[];         // length >= 1, enforced
  criteria: FlowCriterion[]; // length >= 1, enforced
}
```

### Forward contract — documented here, NOT built in Phase 1

Write this as comments alongside the schema so later phases inherit it cleanly. Build none
of it now.

- **Verdict space (Phase 3 verifier / Phase 7 harness):** each criterion → `PASS | FAIL |
  INCONCLUSIVE`; `ERROR` is a reason recorded under `INCONCLUSIVE`. Flow verdict aggregates:
  all PASS → PASS; any FAIL → FAIL; otherwise INCONCLUSIVE.
- **Action ≠ outcome (Phase 2 executor):** a step is "performed" once its action completes
  and a response is observed; a non-favorable response is a completed step, not a step
  failure. The canonical hard case is BUG-007: "the place-order control is not actionable at
  mobile" is a behavior **FAIL** (the control *should* be actionable — it is at desktop), not
  an infra ERROR. The verifier disambiguates ERROR vs FAIL by asking *was the action supposed
  to be possible*; Phase 1 only states the outcome criterion.
- **Evidence join (Phases 3/4/7):** runtime evidence (status, captured figures, screenshots,
  trace refs) and evaluator reasoning attach to criteria **by criterion ID**. Stable IDs are
  the join key — that is why Phase 1 must emit them deterministically.
- **The runtime "evaluation record"** (evidence + reasoning + outcomes + its own version) is
  a *different artifact* from `FlowPlan`. Do not conflate them. `FlowPlan.schemaVersion`
  versions the static input plan only.

---

## Task checklist

### Task 1 — Bootstrap `platform/` and the first test runner
*Serves:* gives Pillars 1–6 their home and the parser somewhere to live.
*Next depends on it:* every later phase builds inside `platform/`; the black-box boundary is
enforced by `platform/` being a package that cannot reach `app/` source.

- [x] Create `platform/package.json` (npm) and `platform/tsconfig.json`, **independent of
  `app/`** (they share no code). Match the app's conventions: TypeScript 5.x, CommonJS,
  `strict: true`, `ts-node`. Do **not** import anything from `app/`.
- [x] Wire the test runner as **Node's built-in `node:test`** via `ts-node/register`. No
  Vitest, no Jest, no extra test dependency. Add a `test` script; confirm it discovers
  `*.test.ts` files. Land one trivial passing test to prove the harness runs green.
- [x] Add a `parse` script (CLI entry, filled in Task 4) — placeholder is fine here.
- [x] Confirm `platform/` paths match `../CLAUDE.md`. Do not add a root-level
  `package.json`/`tsconfig` — keep `app/` and `platform/` as two independent packages.

✅ **COMMIT:** `chore(platform): bootstrap platform package + node:test runner`

### Task 2 — Write the flow-format document
*Serves:* the human-facing contract a non-engineer writes against.
*Next depends on it:* the schema and parser implement exactly this grammar.

- [x] Author `fixtures/flows/FORMAT.md` documenting the grammar exactly as in **The flow
  file format** above: front-matter table (with "unknown key ⇒ error"), `## Steps`,
  `## Acceptance Criteria`, the optional `(after step N)` suffix, and the rule that **≥1
  criterion is mandatory**. State plainly that step/criterion text is plain English, never
  selectors/labels/HTTP codes, and never bug ids.

✅ **COMMIT:** `docs(flows): plain-English flow format spec`

### Task 3 — Define the structured-plan schema + forward contract
*Serves:* the contract Phase 2 consumes and the join surface Phases 3/4/7 extend.
*Next depends on it:* the parser produces exactly this shape.

- [x] Implement the `FlowPlan` / `FlowStep` / `FlowCriterion` types under `platform/src/`.
- [x] Add the **Forward contract** block as comments (verdict space incl. ERROR-under-
  INCONCLUSIVE; action≠outcome; evidence-join-by-criterion-ID; runtime-record-is-not-
  FlowPlan). Build none of that behavior.

✅ **COMMIT:** `feat(platform): FlowPlan schema + forward-contract notes`

### Task 4 — Implement the deterministic parser + CLI
*Serves:* the core deliverable — flow file → structured plan.
*Next depends on it:* the tests and the Done-when both run this.

- [x] Parse the front-matter with **`js-yaml`** (add `js-yaml` + `@types/js-yaml` to
  `platform/` deps). Load it in a safe mode (`yaml.load`, no custom types). Validate the result
  against the fixed schema and **reject unknown keys** — js-yaml will happily accept them, so
  the unknown-key check is yours to enforce, not the library's.
- [x] Extract `## Steps` (ordered list, ≥1) and `## Acceptance Criteria` (list, ≥1),
  preserving each item's text **verbatim**. Strip and record the optional `(after step N)`
  suffix on criteria; `N` must reference an existing step or it's an error.
- [x] Assign IDs deterministically: `<flowId>:S<ordinal>` and `<flowId>:C<ordinal>`, where
  `flowId` = basename minus `.flow.md`. **No** UUIDs/timestamps/random.
- [x] Validation, all fail-loud with a specific message: missing `name`; unknown front-matter
  key; `viewport` not in {desktop, mobile}; missing/empty `Steps`; **missing/empty
  `Acceptance Criteria`**; `(after step N)` referencing a non-existent step; file not named
  `*.flow.md`.
- [x] The parser performs **no** interpretation of step/criterion meaning beyond extracting
  the after-suffix.
- [x] CLI: `npm run parse -- <path>` prints the `FlowPlan` as JSON with **stable key order**
  and 2-space indent (diffable, the basis for golden tests).

✅ **COMMIT:** `feat(platform): deterministic *.flow.md parser + parse CLI`

### Task 5 — Author the five canonical flows against the REAL app
*Serves:* satisfies D7 — the flow set must be able to surface every non-blind-spot defect.
*Next depends on it:* the golden tests and the coverage map both reference these exact files.

Create these **verbatim** in `fixtures/flows/`. They are written against the verified app
(creds `alice`/`password123`; products Desk Lamp `p-003` $24.99, Coffee Mug `p-004` $8.99;
the 2×Lamp+1×Mug cart = Subtotal **$58.97**, Tax **$5.90**, Total **$64.87**). Every
criterion asserts an outcome, never a label/selector/code — so the Phase 3 mutations
(MUT-001/002/003) leave them passing.

**`fixtures/flows/login.flow.md`**
```markdown
---
name: Log in with valid credentials
entry: /login
viewport: desktop
tags: [auth, smoke]
---

## Steps
1. Enter the username "alice" and the password "password123".
2. Submit the sign-in form.
3. Go to the product list, which is only available to signed-in users.

## Acceptance Criteria
- After submitting valid credentials the user is signed in: the product list loads instead of bouncing back to the sign-in page.
```

**`fixtures/flows/add-to-cart.flow.md`** (surfaces BUG-002)
```markdown
---
name: Add items to the cart and verify the totals
entry: /login
viewport: desktop
tags: [cart, totals]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Open the product list.
3. Add the "Desk Lamp" to the cart twice.
4. Add the "Coffee Mug" to the cart once.
5. Open the cart.

## Acceptance Criteria
- The Subtotal equals the sum of the line totals, where each line total is the item's unit price multiplied by its quantity.
- The Tax equals 10% of the Subtotal, rounded to the nearest cent — it must not be zero or a different proportion.
- The Total equals the Subtotal plus the Tax.
```

**`fixtures/flows/checkout.flow.md`** (surfaces BUG-001, BUG-004, BUG-005)
```markdown
---
name: Complete checkout and confirm the order persists
entry: /login
viewport: desktop
tags: [checkout, persistence]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" twice and the "Coffee Mug" once.
3. Proceed to checkout and place the order.
4. Revisit the order's own link as a fresh visit.

## Acceptance Criteria
- Placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order — not an error page and not a dead end. (after step 3)
- On the confirmation, the figures reconcile: the Subtotal plus the Tax equals the Total shown. (after step 3)
- When the order's own link is revisited, the same order is still retrievable and shows the same items and the same Total as when it was placed. (after step 4)
```

**`fixtures/flows/checkout-mobile.flow.md`** (surfaces BUG-007)
```markdown
---
name: Complete checkout at a mobile viewport
entry: /login
viewport: mobile
tags: [checkout, mobile]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" twice and the "Coffee Mug" once.
3. Proceed to checkout.
4. Place the order.

## Acceptance Criteria
- At this mobile viewport the place-order control is actionable and placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order. (after step 4)
```

**`fixtures/flows/form.flow.md`** (surfaces BUG-003)
```markdown
---
name: Validated form rejects an invalid amount
entry: /form
viewport: desktop
tags: [form, validation]
---

## Steps
1. Fill in the name "Jana", the email "jana@example.com", and an amount of "25", then submit the form.
2. Fill in the name "Jana", the email "jana@example.com", and an amount of "-5", then submit the form.

## Acceptance Criteria
- The valid submission (a positive whole-number amount with a valid name and email) is accepted: the form reports the request was received. (after step 1)
- The submission with a negative amount of -5 is rejected as invalid and is NOT accepted, even though the name and email are valid. (after step 2)
```

- [x] Create all five files exactly as above.

🚦 **HUMAN GATE:** the human confirms, against the running app, that the creds, product
names, the $58.97/$5.90/$64.87 figures, the `entry` paths (`/login`, `/form`), and the
described outcomes all match reality before these are frozen as golden inputs. Do not
self-certify.

✅ **COMMIT:** `feat(flows): five canonical flows authored against the verified app`

### Task 6 — Parser tests (golden + negative + determinism)
*Serves:* proves the Done-when; locks parser behavior against regression.
*Next depends on it:* Phase 2 builds on a parser whose output shape is pinned.

- [x] **Golden:** parse each of the five flows; compare to a committed expected JSON under
  `platform/test/golden/`. Generate the goldens from the parser, eyeball them for
  correctness, then commit.
- [x] **Criteria-intact (the Done-when):** assert each parsed criterion's `text` equals the
  source line verbatim (minus a stripped `(after step N)`), and that `after` resolved to the
  right step id — proven on at least the checkout persistence criterion.
- [x] **Determinism:** parse the same file twice and assert the two `FlowPlan`s are identical
  (deep-equal **and** identical serialized bytes). This is the CI-stability guard.
- [x] **Negative (use throwaway fixtures under `platform/test/fixtures/`, NOT
  `fixtures/flows/`):** a flow missing `## Acceptance Criteria` ⇒ throws; `viewport: tablet`
  ⇒ throws; `(after step 9)` with no step 9 ⇒ throws; an unknown front-matter key ⇒ throws.

✅ **COMMIT:** `test(platform): golden, determinism, and validation tests for the parser`

### Task 7 — Coverage map (kept OUT of the flow inputs)
*Serves:* shows D7 is satisfied and records the honest blind spot, without leaking ground
truth into the tester's inputs.
*Next depends on it:* Phase 7 scores against this mapping.

- [x] Author `fixtures/flow-coverage.md` (next to `bug-ledger.yaml`, **not** in
  `fixtures/flows/`). State at the top that this is architect/ground-truth documentation and
  is **never** handed to the tester. Map each flow to the defects its criteria can surface and
  the `detection_requires` it satisfies:

  | Flow | Surfaces | `detection_requires` satisfied |
  |---|---|---|
  | `login` | (smoke / prerequisite) | — |
  | `add-to-cart` | BUG-002 (Tax/Total value criteria) | — |
  | `checkout` | BUG-001 (confirmation reached), BUG-004 (on-page reconcile), BUG-005 (persistence on revisit) | BUG-005: verify persistence |
  | `checkout-mobile` | BUG-007 (place-order actionable at ≤480px) | BUG-007: mobile viewport |
  | `form` | BUG-003 (negative amount rejected) | BUG-003: attempt an invalid non-positive amount |

- [x] Record explicitly: **BUG-006 has no flow** — it is the documented visual blind spot
  (`PASS-known-blind-spot`); an outcome-based check "the name is displayed" passes while the
  layout is broken. Do not invent a flow that pretends to catch it.
- [x] Record that **MUT-001/002/003 get no flows of their own**: the five flows above,
  written intent-first, must still PASS under each mutation. That is the Phase 3 self-heal
  test, not new input.
- [x] Record the **BUG-007 ERROR-vs-FAIL note** for Phase 3: failure to click the place-order
  control at mobile is a behavior FAIL (the control is actionable at desktop), not an infra
  ERROR.

✅ **COMMIT:** `docs(fixtures): flow→bug coverage map + blind-spot record`

### Task 8 — Validation pass (this IS the exit criterion)
*Serves:* proves the parser turns real flow files into structured plans with criteria intact.

- [x] Run `npm run parse` on all five canonical flows; confirm each emits a `FlowPlan` with
  every step and **every acceptance criterion present and verbatim**, `viewport` correct
  (`mobile` on `checkout-mobile`), and `after` associations resolved.
- [x] Confirm the full test suite is green.

🚦 **HUMAN GATE:** the human reviews the five emitted plans (criteria intact, mobile viewport
set, persistence criterion pinned to the revisit step) and signs off Phase 1 complete. Do not
self-certify.

---

## Out of scope for Phase 1 (HARD FENCE — do not build)

- ❌ No Playwright MCP, no browser, no navigation, no screenshots (Phase 2).
- ❌ No LLM calls, and **no semantic interpretation** of step/criterion English — the parser
  is purely structural.
- ❌ No verdict, evidence, evaluator-reasoning, or outcome logic; no INCONCLUSIVE/ERROR
  computation (Phases 3/4/7). Only the *forward-contract notes* land here.
- ❌ No execution of any flow; no running of `app/`; no use of `PROOFLOOP_BUGS`.
- ❌ No selectors, no DOM reasoning, nothing that reads `app/` source.
- ❌ No flow includes / macros / shared-setup mechanism — flows are standalone and may repeat
  their setup steps.
- ❌ No author-supplied criterion slugs and no named checkpoints — positional IDs and
  optional `after step N` only (slugs deferred until post-Phase-7 evidence-join needs them).
- ❌ No reporting, eval harness, or CI workflow (Phases 4 / 6 / 7).
- ❌ No edits to `app/` or to `fixtures/bug-ledger.yaml`.
- ❌ No markdown-parsing library — the body is a fixed list structure; hand-extract the `Steps`
  and `Acceptance Criteria` items. (`js-yaml` is permitted, for the front-matter only.)

---

## Exit Checklist (the gate to Phase 2)

- [x] `platform/` exists as its own package (`package.json` + `tsconfig.json`), independent of
  `app/`, with `node:test` wired via `ts-node` and a green test run. No root configs added.
- [x] `fixtures/flows/FORMAT.md` documents the grammar: front-matter (unknown key ⇒ error),
  `Steps`, `Acceptance Criteria` (**≥1 mandatory**), optional `(after step N)`, domain-agnostic.
- [x] `FlowPlan` schema implemented with the forward-contract block (verdict space incl.
  ERROR-under-INCONCLUSIVE; action≠outcome; evidence-join-by-criterion-ID; runtime-record ≠
  FlowPlan).
- [x] Deterministic structural parser: verbatim text preservation; deterministic positional
  namespaced IDs (no UUID/timestamp/random); fail-loud validation incl. the zero-criteria
  error; `parse` CLI emits stable-ordered JSON.
- [x] Five canonical flows authored at `fixtures/flows/*.flow.md` against the verified app;
  human-confirmed (creds, products, $58.97/$5.90/$64.87, entry paths, outcomes).
- [x] Tests green: golden per flow, criteria-intact, determinism (re-parse identical),
  negatives (no-criteria / bad-viewport / bad-after / unknown-key all throw).
- [x] `fixtures/flow-coverage.md` maps flows→bugs + `detection_requires`; BUG-006 recorded as
  the blind spot; mutations noted as self-heal targets; lives outside `fixtures/flows/`.
- [x] All five flows parse into structured plans with acceptance criteria intact (the
  Done-when — and ≥2 was the floor; we hit five to satisfy D7).
- [x] No bug ids, selectors, or source references in any `*.flow.md`.

---

## Risks (where this phase quietly goes wrong)

1. **Semantic creep into the parser.** The moment it tries to "understand" a step (or an LLM
   is invited to "help"), determinism dies and Phase 2's non-determinism contaminates the one
   reproducible layer. Structural only. The determinism test is the tripwire.
2. **Criteria that assert mechanism, not outcome.** "A button labelled X exists", "expect HTTP
   422", "the element is in the second row" — each silently breaks Phase 3 self-heal and may
   false-fail across apps. Keep criteria at the outcome layer (D10).
3. **Using a constant, or the wrong invariant, as BUG-002's catcher.** Two traps here. First,
   "Subtotal + Tax == Total" does **not** catch BUG-002: when tax is dropped to $0.00 the
   equation `58.97 + 0 == 58.97` still holds, so that invariant passes a buggy cart. BUG-002's
   actual catcher is the proportional rule **"Tax equals 10% of the Subtotal"** (tax of $0.00
   violates it). Second, do not "simplify" that rule back into the hardcoded **"$5.90"** — it
   would catch the bug too, but it is brittle, app-coupled, and indistinguishable from a script
   string-match (see "Criteria encode the rule, not the output"). The reconcile invariant still
   earns its place on the *checkout confirmation*, where BUG-004 makes a correct Subtotal+Tax ≠
   the displayed Total — a genuinely inconsistent page.
4. **Asserting a product count.** `p-005` appears only when BUG-006 is on, making five products.
   No flow may assert "exactly four products" — that would false-fail in a BUGGY state.
5. **Conflating ERROR with FAIL** in the forward-contract notes. BUG-007's "can't click" is a
   FAIL; a genuine harness/network failure is ERROR. Phase 1 just records the distinction for
   Phase 3 — but record it correctly.
6. **Leaking ground truth into inputs.** Negative-test fixtures and the coverage map must live
   **outside** `fixtures/flows/`, or they pollute the golden set and hand the tester the answer
   key. `fixtures/flows/` holds exactly the five canonical flows.
7. **Promising ID stability you haven't built.** Positional IDs renumber on edits; that's fine
   now (no stored history to break), but don't document cross-version stability as a guarantee.
8. **Rule-based criteria push arithmetic into the verifier — that's the point, not a bug.**
   "Tax equals 10% of the Subtotal" makes the Phase 3 verifier read two live figures and
   compute, and LLM arithmetic is a known non-determinism source. Do **not** hide that behind
   memorised constants — surfacing and measuring verifier-reliability is exactly Phase 8's job.
   Phase 1 only states the rule; whether the platform checks it reliably is a finding to report,
   not a weakness to paper over.