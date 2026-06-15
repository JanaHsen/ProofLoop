# Phase 0 — Foundations & Ground Truth

> **Goal:** Have something real to test, and know in advance what should pass and fail.
> **Exit criterion:** You can open the app, manually trigger each seeded bug, and the
> ledger documents exactly which flow each bug should break.

---

## How to use this file (Claude Code)

1. Read `../CLAUDE.md` first (auto-loaded) — it pins the canonical paths and the
   cross-cutting rules. Do not deviate from those paths.
2. Work the **Task checklist** top to bottom. Tick each `[ ]` as you finish it.
3. **Stop at every `🚦 HUMAN GATE`** and wait for the human. Do not proceed past it.
4. **Commit at every `✅ COMMIT`** checkpoint using the suggested message.
5. You are NOT done with Phase 0 until the **Exit Checklist** at the bottom is fully
   checked. Do not start Phase 1 before then.
6. Read the **Out of scope** section before you start. It is a hard fence.

---

## Why this phase is first (don't skip the reasoning)

Every number ProofLoop produces later — false-pass rate, false-fail rate, verdict
accuracy, cost-vs-script — is a comparison against an answer key. **If the answer key
is wrong, vague, or non-reproducible, every downstream number is unfalsifiable and the
whole credibility argument collapses.** This phase builds the measurement instrument
the eval harness will calibrate against. Treat the ledger as a test oracle.

---

## Decisions already locked (do NOT relitigate)

- **D1 — Build a minimal app we control.** Not a heavy fork, not hosted SauceDemo/ParaBank
  (you can't inject bugs into an app you don't host). Testing against real third-party
  apps happens *after* the platform is trustworthy, not here. The app is a fixture, not
  the product — keep it small.
- **D2 — Every seeded bug is toggleable** via a single source (`PROOFLOOP_BUGS` env, see
  `../.env.example`). With a flag off, behaviour == clean baseline. Needed because Phase 7
  measures **false-fail** (working flows wrongly flagged), which requires a known-good
  version of the same flow on demand.
- **D3 — Bugs and structure-mutations are different things in different registries.**
  Bugs (`BUG-xxx`) → expected verdict FAIL. Mutations (`MUT-xxx`, e.g. renamed/moved
  element) → expected verdict PASS (self-heal must absorb them). Both live in
  `fixtures/bug-ledger.yaml`.
- **D4 — Black-box boundary = the URL.** The tester only ever gets `BASE_URL` + a flow
  file. Build the app so that boundary is natural.
- **D5 — Secrets by layer from commit 1.** Already scaffolded in `.gitignore` /
  `.env.example`. Never hardcode.
- **D6 — SUT carries no test instrumentation; oracle access is via token-gated `/debug` API;
  the ledger is the verdict oracle, `/debug/state` is a state mirror.** The SUT models an
  uninstrumented app (no `data-test` anchors). Ground-truth state is read through a token-gated
  `/debug` API: `/debug/state` mirrors the app's *actual* state (wrong totals and all, when bugs
  are on) and is a diagnosis mirror, NOT the answer key — `fixtures/bug-ledger.yaml` remains the
  verdict oracle. Honesty caveat: "On a fully test-id-instrumented codebase, a traditional script
  regains most structural robustness; ProofLoop's strongest claim is for uninstrumented apps.
  Phase 7's comparison and writeup must carry this caveat."
- **D7 — `detection_requires` is a first-class ledger field; the rest of the pipeline MUST honor it.**
  Several defects are only observable if the flow/execution does a specific thing: attempt an
  invalid (non-positive) amount (BUG-003); verify order *persistence* rather than trusting the
  success screen (BUG-005); run at a mobile viewport ≤480px (BUG-007); have visual-regression
  capability (BUG-006, not planned). Each bug records this in `detection_requires`. **Phase 1's flow
  set and Phase 5's execution config MUST satisfy every non-empty `detection_requires`, and Phase 7
  scores verdicts against them.** A defect whose `detection_requires` is never met is a
  *structurally guaranteed* false-pass, not a platform miss — and the headline numbers would
  silently flatter the platform. The injection-layer taxonomy is `shared-logic | render-site |
  route-handler | session-lifecycle`; `shared-logic` defects also corrupt `/debug/state` (mirror
  agrees), whereas `render-site` defects leave the mirror correct — the divergence localizes the layer.

---

## App requirements (what "minimal but real" means)

Pick the boring stack you move fastest in (a small Node/TS server + thin frontend is the
default; small Next.js is fine). A little async/dynamic rendering is **desirable** — it
keeps Phases 5/8 honest about timing and non-determinism. The app MUST have:

- [ ] Real **server-side session/auth** (not just a localStorage flag) — required for the
      state-dependent bug.
- [ ] Four flows: **login**, **add-to-cart**, **checkout**, a **form with validation**.
- [ ] **Deployable headless in CI** (runs behind a URL in GitHub Actions, Phase 6).
- [ ] **Bug state read from config at startup** (`PROOFLOOP_BUGS`), never edited per-run.

---

## The state matrix (what the toggles are FOR)

Phase 0's job is to make these four states *producible and documented*. **Running them
is Phase 7 — do not build the harness here.** If a toggle you're about to add doesn't
map to a cell below, don't add it.

| State | Bugs on? | Mutations on? | Expected verdict (affected flow) | Measures later |
|---|---|---|---|---|
| CLEAN | none | none | PASS | false-fail |
| BUGGY | one+ | none | FAIL | false-pass |
| MUTATED | none | one+ | PASS | self-heal |
| BUGGY + MUTATED | one+ | one+ | FAIL | the regression trap |

---

## Task checklist

### Task 1 — Confirm the skeleton & first commit
*Serves:* establishes the URL boundary and secrets discipline before any code.
*Next depends on it:* the app reads `PROOFLOOP_BUGS`, a contract that must already exist.

- [x] Confirm the directory structure matches `../CLAUDE.md` (`app/`, `platform/`,
      `fixtures/flows/`, `phases/`, `.github/workflows/`). Create any missing dir.
- [x] Confirm `.gitignore` ignores `.env`; confirm `.env.example` exists and lists every
      planned var. Do **not** create a real `.env` with secrets — that's the human's job.
- [x] `git init` if not already a repo.

🚦 **HUMAN GATE:** ask the human to run `cp .env.example .env` and fill local values.
Do not create or populate `.env` yourself.

✅ **COMMIT:** `chore: scaffold repo, hygiene, secrets-by-layer`

### Task 2 — Scaffold the app shell with the four flow surfaces
*Serves:* gives the surfaces the canonical flows will exercise.
*Next depends on it:* you can't define "correct behaviour" without the flows existing,
and you can't seed a state-dependent bug without real sessions.

- [x] Stand up the app in `app/`, served on `APP_PORT`.
- [x] Routes/pages for: login (real session), product list + add-to-cart, cart +
      checkout, and a standalone validated form.
- [x] App boots, all four pages reachable. No bugs yet.

✅ **COMMIT:** `feat(app): scaffold SUT shell with four flow surfaces`

### Task 3 — Implement and verify the CLEAN baseline
*Serves:* the CLEAN row — your false-fail reference (the zero point).
*Next depends on it:* if "clean" is silently wrong, every false-fail number is garbage.

- [x] Make all four flows genuinely correct (right totals, valid/invalid input handled
      correctly, checkout completes, session enforced). Orders now freeze a full line
      snapshot; `/order/:id` renders solely from the order record (architect gate fix).
- [x] With `PROOFLOOP_BUGS` empty, manually walk all four flows and confirm correct.
      (Human verified in-browser; re-verified via curl smoke checks — cart/checkout/order
      totals identical at $58.97/$5.90/$64.87 for the sample cart.)
- [x] Strip all hand-placed test instrumentation (`data-test` attributes) from the SUT
      templates — the SUT models an *uninstrumented* app, ProofLoop's primary target case.
      Verified zero `data-test` occurrences under `app/src`.
- [x] Add a token-gated `/debug` test-fixture API (header `X-Debug-Token` vs env
      `PROOFLOOP_DEBUG_TOKEN`; default-deny 404 when the token is unset/empty):
      `GET /debug/state` (actual-state mirror across **all** sessions — for the separate-process
      grading harness) and `POST /debug/expire-session` (on-demand session destruction for the
      Task 8 verification walk). This is test infrastructure, not one of the four flows.

🚦 **HUMAN GATE:** human confirms the clean baseline is actually correct before any bug
is injected.

- [x] Tag the verified baseline: `git tag v0-clean`. (Annotated tag on commit `131b98f`.)

✅ **COMMIT:** `feat(app): correct, verified clean baseline for all four flows`

### Task 4 — Lock the bug set (design before code)
*Serves:* ensures real difficulty range and a defensible answer key.
*Next depends on it:* Tasks 5–7 implement and document exactly this set.

- [ ] Adopt the recommended bug set below (adjust to the app, keep the spread). Confirm
      the set includes: at least one obvious, several moderate/subtle, **at least one
      state-dependent**, and the two honest-blind-spot cases (visual + viewport).

See **Recommended bug set** and **Honesty notes** below — read both before coding.

### Task 5 — Implement seeded bugs behind toggles
*Serves:* the BUGGY row.
*Next depends on it:* BUGGY+MUTATED requires bugs and mutations to compose cleanly.

- [ ] Implement each `BUG-xxx` gated behind its flag in `PROOFLOOP_BUGS`.
- [ ] Flag off == identical to clean. Bugs are **isolated** — enabling one must not
      perturb another, or the matrix becomes uninterpretable.

✅ **COMMIT:** `feat(app): seeded bugs behind PROOFLOOP_BUGS toggles`

### Task 6 — Implement structure mutations behind toggles
*Serves:* the MUTATED and BUGGY+MUTATED rows — Phase 3's self-heal & regression-trap tests.
*Next depends on it:* Phase 3 cannot prove "heal structure, fail behaviour" without these.

- [ ] Implement each `MUT-xxx` (rename element, move it in DOM, change `id`/`name`) behind
      a toggle. **None changes behaviour** — only structure.

✅ **COMMIT:** `feat(app): benign structure mutations behind toggles`

### Task 7 — Write the bug ledger (the answer key)
*Serves:* the machine-parseable ground truth the eval harness grades against.
*Next depends on it:* Phase 7 parses this; Phase 1 writes acceptance criteria to match
what the ledger calls "correct."

- [ ] Author `fixtures/bug-ledger.yaml` using the schema below. One entry per `BUG-xxx`
      and `MUT-xxx`. Every field present, including the honesty column.

✅ **COMMIT:** `feat(fixtures): bug ledger + mutation registry with expected verdicts`

### Task 8 — Manual verification pass (this IS the exit criterion)
*Serves:* proves the answer key is true, not aspirational.
*Next depends on it:* you do not advance to Phase 1 without this.

Note: there is no browser-driving engine yet (that's Phase 2), so verification is
human-led. Prepare assistance where you can (e.g. a short script or `curl` checks, a
printed walk-through), then hand off.

- [x] For every ledger entry: enable its flag, walk the documented `trigger`, confirm the
      `actual_behavior` matches reality on exactly the flow named, then disable and
      confirm the flow returns to correct.
- [x] For every mutation: enable it, confirm the flow still *behaves* correctly though
      structure moved.

🚦 **HUMAN GATE:** the human performs (or signs off on) the full verification walk. Do
not self-certify Phase 0 complete. *(Human confirmed 2026-06-15: every walked
observation matched, including the `BUG-002,MUT-001` composition and a final
all-flags-off clean pass.)*

### Task 9 — Freeze ground truth
*Serves:* reproducibility — Phase 7 must re-run identical app states later.

- [x] Record, in the repo, the exact flag combinations that produce each matrix cell.
      (`fixtures/matrix-states.md`.)
- [x] Tag the verified seeded state. (Annotated tag `v0-ground-truth`.)

✅ **COMMIT:** `chore: freeze and document Phase 0 ground-truth states`

---

## Recommended bug set

| Flag | Flow | Category | Subtlety | Sketch | Script would catch? |
|---|---|---|---|---|---|
| BUG-001 | checkout | behaviour | obvious | Checkout button does nothing / 404 | yes |
| BUG-002 | add-to-cart | behaviour | moderate | Cart total computed wrong (e.g. tax dropped) | only with a total assertion |
| BUG-003 | form | behaviour | moderate | Amount/quantity field accepts negative numbers | only with a boundary assertion |
| BUG-004 | checkout | behaviour | subtle | Total right on cart page, **wrong on order confirmation** | rarely (needs cross-page assertion) |
| BUG-005 | login→checkout | **state-dependent** | subtle | Session expires mid-flow; UI still shows logged-in; checkout silently fails | almost never |
| BUG-006 | product page | **visual** | subtle | Long product name overflows its container | no |
| BUG-007 | checkout | **viewport** | subtle | Checkout button unreachable only at mobile viewport | only if run at mobile size |

## Honesty notes (these ARE findings — do not paper over them)

- **BUG-006 (overflow):** an outcome-based tester asserting "the name is displayed" will
  likely PASS it — the text is present, just visually broken. A traditional script misses
  it too without visual regression. Mark its expected verdict honestly as a **known blind
  spot**, not "should catch." If the platform passes it, that's a documented limitation
  for Phase 7/8, not a bug in the platform.
- **BUG-007 (mobile-only):** catching this REQUIRES running the flow at a mobile viewport.
  Note this dependency in the ledger so the flow set / execution config (Phase 1, Phase 5)
  actually exercises mobile. If mobile is never run, this is a permanent false-pass and
  the numbers flatter the platform.
- **BUG-005 (state-dependent):** highest-value bug in the set and the hardest. Make the
  trigger **deterministic and fireable on demand** (e.g. a `/debug/expire-session`
  endpoint is legitimate test infrastructure). A flaky trigger is useless as ground truth.

---

## Bug ledger schema (`fixtures/bug-ledger.yaml`)

```yaml
# Top-level honesty caveat — lands in the ledger so the answer key itself carries it.
notes: >
  On a fully test-id-instrumented codebase, a traditional script regains most
  structural robustness; ProofLoop's strongest claim is for uninstrumented apps.
  Phase 7's comparison and writeup must carry this caveat.

bugs:
  - id: BUG-002
    title: Cart total drops tax line
    flow: add-to-cart            # login | add-to-cart | checkout | form | product-page
    category: behavior           # behavior | state-dependent | visual | viewport
    subtlety: moderate           # obvious | moderate | subtle
    toggle: BUG-002              # exact flag in PROOFLOOP_BUGS
    trigger: Add any taxed item and view the cart total.
    expected_behavior: Total = sum(line items) + tax.
    actual_behavior: Total = sum(line items); tax silently omitted.
    expected_verdict: FAIL       # what ProofLoop SHOULD return on this flow
    script_would_catch: only-with-total-assertion

  - id: BUG-005
    title: Stale session passes UI auth but fails checkout
    flow: checkout
    category: state-dependent
    subtlety: subtle
    toggle: BUG-005
    trigger: Log in, add item, hit /debug/expire-session, attempt checkout.
    expected_behavior: Expired session redirects to login before any charge.
    actual_behavior: Checkout submits with a dead session; order silently lost.
    expected_verdict: FAIL
    script_would_catch: almost-never

  - id: BUG-006
    title: Long product name overflows container
    flow: product-page
    category: visual
    subtlety: subtle
    toggle: BUG-006
    trigger: Render a product whose name exceeds the container width.
    expected_behavior: Name truncates or wraps within the container.
    actual_behavior: Name overflows and clips adjacent UI.
    expected_verdict: PASS-known-blind-spot   # honest: outcome-based testing likely misses this
    script_would_catch: no

mutations:
  - id: MUT-001
    title: Rename "Add to Cart" to "Add to Bag"
    flow: add-to-cart
    toggle: MUT-001
    change: Button label text changed; behaviour identical.
    expected_verdict: PASS       # self-heal must absorb this

  - id: MUT-002
    title: Change login input id username -> user_name
    flow: login
    toggle: MUT-002
    change: Input id/name attribute changed; field behaviour identical.
    expected_verdict: PASS
```

---

## Out of scope for Phase 0 (HARD FENCE — do not build)

- ❌ No Playwright MCP wiring, no browser driving (Phase 2).
- ❌ No LLM calls, no flow parser (Phases 1–2).
- ❌ No verification / self-heal logic (Phase 3).
- ❌ No reporting, no eval harness, no CI workflow (Phases 4 / 6 / 7).
- ❌ No use of `ANTHROPIC_API_KEY` (only declared in `.env.example`).

Phase 0 produces exactly four things: a controllable app, toggleable seeded bugs,
toggleable mutations, and a verified machine-parseable ledger. Nothing more.

---

## Exit Checklist (the gate to Phase 1)

- [ ] App runs behind `BASE_URL` with login, add-to-cart, checkout, validated form.
- [ ] CLEAN baseline manually verified correct on all four flows; tagged `v0-clean`.
- [ ] Each `BUG-xxx` toggles on/off; off == clean; bugs are isolated.
- [ ] Each `MUT-xxx` toggles on/off and does not change behaviour.
- [ ] At least one state-dependent bug with a deterministic, on-demand trigger.
- [ ] `fixtures/bug-ledger.yaml` documents every bug and mutation with all fields incl.
      `expected_verdict` and `script_would_catch`.
- [ ] Every ledger entry manually walked and confirmed (Task 8 human gate passed).
- [ ] Honest blind spots (overflow / mobile dependency) recorded in the ledger.
- [ ] `.gitignore`, `.env.example` correct; nothing hardcoded; no real `.env` committed.
- [ ] The four matrix states reproducible from documented flag combinations; tagged.

---

## Risks (where this phase quietly goes wrong)

1. **A subtly-broken "clean" baseline** poisons every false-fail number. (Task 3 + human gate.)
2. **Toy bugs** make Phase 7 look brilliant and prove nothing — the spread and the
   state-dependent bug are what give the eval teeth.
3. **A flaky state-dependent trigger** makes you chase your own non-determinism in Phase 8.
4. **Overclaiming on visual/viewport bugs** sets up fake failures — score them as blind spots.
5. **Leaking source-awareness into the tester** violates the black-box rule before Phase 6
   even starts. Keep the interface URL-in / verdict-out from day one.
