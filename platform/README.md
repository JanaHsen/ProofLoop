# `platform/` — the ProofLoop tester

The intent-driven testing platform: the deterministic flow parser (Phase 1), the
snapshot-then-act execution engine (Phase 2), and — in later phases — the verifier and
reporter. It is its **own** package, independent of `app/`.

## Black-box boundary (the rule the platform is named for)

The executor's **only** knowledge of the System Under Test is `BASE_URL`. It must
**never**:

- start the app by reading `app/`;
- receive a filesystem path into `app/`;
- import application code;
- inspect application source.

It reaches every page after the entry page by **clicking links it finds in live
accessibility snapshots** — never by a known route, never by a guessed selector. This
boundary is enforced in the harness, not merely promised here.

It also must never receive `PROOFLOOP_BUGS` (ground truth) or `PROOFLOOP_DEBUG_TOKEN`,
and must never call `/debug/*`. The engine is given `BASE_URL` + a flow file and nothing
else about the SUT.

## Running the SUT (System Under Test)

Starting the app is the **human's / outer orchestration layer's** job — **not** the
executor's. From the repo root:

```bash
npm --prefix app run dev    # serves the SUT on APP_PORT (default 3000)
```

The SUT is then reachable at `BASE_URL` (default `http://localhost:3000`). The executor
is handed only that URL.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | run the platform test suite (`node:test` + ts-node transpile-only) |
| `npm run typecheck` | full TypeScript type-check (tests run transpile-only, so this is the type gate) |
| `npm run parse -- <file.flow.md>` | print a parsed `FlowPlan` as canonical JSON |
| `npm run run` | execute a flow (wired in Phase 2 Task 5; placeholder until then) |

## Generated artifacts

Run output lands under [`runs/`](runs/README.md) — one subdirectory per `runId`, all
gitignored except `.gitkeep` and the README.
