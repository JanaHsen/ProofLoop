# ProofLoop — Project Constitution

> This file is auto-loaded by Claude Code at the start of every session. It is the
> single source of truth for **how this repo is structured** and **the rules that
> apply to every phase**. Keep it short. Phase-specific work lives in `phases/`.

## What ProofLoop is

An LLM-based, **intent-driven** end-to-end testing platform. You describe a flow in
plain English; an LLM drives a real browser (via Playwright MCP) to carry it out,
adapts when the UI *structure* shifts, stays strict on *behaviour*, writes an
evidence-backed summary, and runs in CI/CD.

**The spec (canonical — do NOT pivot or "improve" the concept):**
1. Natural-language flow definition in plain English
2. Self-healing & adaptive LLM navigation
3. Flexible execution (headless for CI / headed for local debug)
4. Smart AI-written summaries of results & failures
5. DevOps-ready CI/CD integration

The full brief in `phases/` reference material is canonical. Everything we build
serves these five pillars. Reference articles are *how-to inputs*, not licence to
re-scope the project.

## How to work this repo (read before coding)

- **Phases are executed in order.** The active spec is the lowest-numbered file in
  `phases/` whose Exit Checklist is not yet fully checked.
- **Do not start a phase until the previous phase's Exit Checklist is fully true.**
  The ordering exists because each phase depends on the one before it.
- **Read the active phase file on demand** (e.g. `phases/00-foundations.md`). Do NOT
  `@import` phase files here — they are large and would bloat every session.
- **Tick the checkboxes** in the phase file as you complete each item. They are the
  progress ledger.
- **Stop at `🚦 HUMAN GATE` markers** and wait for the human. Do not proceed past them
  on your own.
- **Commit at every `✅ COMMIT` checkpoint** with the suggested message. Small,
  reviewable commits.
- **When unsure, ask. Do not invent scope.** This codebase punishes over-building.

## Canonical directory structure (do not deviate — later phases assume these paths)

```
proofloop/
├── CLAUDE.md              # this file
├── README.md             # human orientation
├── .gitignore
├── .env.example          # documents every env var the project will ever need
├── app/                  # the System Under Test (SUT) — the minimal app we control
├── platform/             # the ProofLoop tester (engine, parser, verifier, reporter) — built Phases 1–6
│   └── runs/             # generated run artifacts, one dir per runId — contents gitignored (Phase 2+)
│       └── <runId>/evaluations/   # per-run evaluation records (Phase 3); gitignored alongside runs/
├── fixtures/
│   ├── bug-ledger.yaml   # GROUND TRUTH: seeded bugs + structure mutations + expected verdicts
│   └── flows/            # *.flow.md — plain-English flow definitions (Phase 1+)
├── presentation/         # tracked demonstration artifacts — e.g. phase5-parity.json
│                         #   (Phase 5 Task 7 deterministic cross-mode parity report)
├── phases/               # the phase runbooks (specs you execute, in order)
└── .github/workflows/    # CI (Phase 6)
```

## Cross-cutting rules (apply from the phase noted, then permanently)

- **Never guess a selector** *(from Phase 2)*. The engine reads the live page first and
  locates elements by intent. No locator without reading the live page.
- **Assert intent, not elements** *(from Phase 3)*. A test passes/fails on what the user
  *achieved*, never on whether a named element exists. A renamed button must not fail a
  run; a wrong total must — even if the button moved.
- **Log as you go** *(from Phase 2)*. Logging is stood up early and grows every phase. It
  is never bolted on at the end.
- **Secrets by layer** *(from commit 1)*. Local `.env` is gitignored and developer-machine
  only. `.env.example` (dummy values) is committed as documentation. CI uses GitHub
  Actions encrypted secrets. **Nothing is ever hardcoded.**
- **Black-box boundary = the URL** *(from commit 1)*. The tester is only ever given
  `BASE_URL` + a flow file. It never receives a filesystem path into `app/` and never
  reads the SUT's source. This is how the "browser-only, never reads source" rule is
  *enforced*, not just promised.
- **Execution mode is launch-seam only** *(from Phase 5)*. `npm run run -- <flow>` runs
  **headless by default** (the CI path); `--headed` is the only override (local debug).
  There is **no `--headless` flag** and **no `PROOFLOOP_HEADED` env var** — one override,
  one source of truth. Headed requested without a display **fails loudly**, never a silent
  fallback to headless. Mode may be parsed, validated, recorded, and reported, but **only
  the MCP/browser launch seam** may let it change runtime browser behavior (D32).
- **Run-log is additive and version-tolerant** *(from Phase 5)*. The run log is at
  `runLogSchemaVersion` **`1.2`**; every version-aware reader tolerates `1.0`/`1.1`/`1.2`.
  The manifest records the **effective** `mode`, the **`requestedMode`**, and a **typed
  `browser`** config (engine, isolation, viewport, accessibility-snapshots, vision-off) —
  **never raw subprocess arguments**. Re-opening this Phase 2-frozen schema is human-gated
  and always accompanies this constitution edit.
- **Never auto-merge** *(from Phase 6)*. The platform posts a verdict; a human approves
  the merge. Always.

## Ground truth

`fixtures/bug-ledger.yaml` is the answer key the entire evaluation harness (Phase 7)
grades against. If it is wrong, every accuracy number downstream is meaningless. Treat
it as a test oracle. Every entry must be manually verified before its phase is "done."
