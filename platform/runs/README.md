# `platform/runs/` — generated run artifacts

This directory is the blessed home for **generated** execution artifacts produced by
the ProofLoop engine. It holds **one subdirectory per `runId`** (see D19 in
`phases/02-execution-engine.md`):

```
platform/runs/<runId>/
├── run.json            # manifest (atomically finalized)
├── events.jsonl        # append-only event stream
├── snapshots/<snapshotId>.json
└── screenshots/<screenshotId>.png
```

## What is committed vs. generated

- **Committed (tracked):** only `.gitkeep` (so the directory exists for a fresh clone)
  and this `README.md`.
- **Generated (gitignored):** everything else — every `<runId>/` subdirectory and its
  contents. The `.gitignore` ignores `platform/runs/*` and then re-includes the two
  tracked files. Run artifacts are execution output, never source; they are never
  committed.

## Boundary note

These artifacts are written by the engine, which knows the SUT **only** by `BASE_URL`.
Nothing here is derived from reading `app/` source. See `platform/README.md` for the
full black-box boundary statement.
