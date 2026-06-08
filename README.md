# ProofLoop

An LLM-based, intent-driven end-to-end testing platform. Describe a flow in plain
English; an LLM drives a real browser to execute it, self-heals around UI structure
changes, stays strict on behaviour, writes an evidence-backed report, and runs in CI.

This repo is built in **dependency-ordered phases**. Each phase is a spec in `phases/`.

## Working model

- **You** (human) work in VS Code and review/approve.
- **Claude Code** writes the code by executing the phase specs in order.
- `CLAUDE.md` is the constitution Claude Code reads automatically — structure + rules.

## How to drive a phase

1. Open the repo in VS Code; start Claude Code at the repo root.
2. Point it at the active phase, e.g. *"Execute `phases/00-foundations.md`."*
3. Claude Code ticks checkboxes as it goes, stops at `🚦 HUMAN GATE` markers, and
   commits at `✅ COMMIT` checkpoints.
4. A phase is done **only** when its Exit Checklist is fully checked. Do not advance
   early.

## Layout

| Path | What it is | Built in |
|---|---|---|
| `app/` | The System Under Test — a minimal app we fully control | Phase 0 |
| `fixtures/bug-ledger.yaml` | Ground truth: seeded bugs + mutations + expected verdicts | Phase 0 |
| `fixtures/flows/` | Plain-English flow definitions (`*.flow.md`) | Phase 1+ |
| `platform/` | The ProofLoop tester (engine, parser, verifier, reporter) | Phases 1–6 |
| `.github/workflows/` | CI integration | Phase 6 |
| `phases/` | The phase runbooks | now |

## Setup

```bash
cp .env.example .env   # fill in real local values; .env is gitignored
```

`ANTHROPIC_API_KEY` is not needed until Phase 2. Phase 0 only needs the app to run.
