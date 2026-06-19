# Mode-isolation architecture proof (Phase 5 Task 5 · D32)

> **Invariant proved here:**
> Mode may be **parsed, validated, recorded, and reported** outside the launcher, but it may
> affect **runtime browser behavior** only at the MCP/browser launch seam. No
> execution-loop, prompting, verification, evidence-resolution, verdict, reporting, guard,
> retry, redaction, or cost logic branches on mode.

Permitted categories: `parse` · `validate` · `record` · `report` · `launch`. **Only `launch`
may change runtime browser behavior.** This record is enforced, not asserted: see
[`mode-isolation.test.ts`](../mode-isolation.test.ts) (runtime invariance + a static
source-surface guard that fails if a mode-bearing identifier enters a forbidden module).

## The sole runtime-behavior branch

**`resolveLaunchArgs` — [`platform/src/mcp/client.ts`](../../src/mcp/client.ts)** is the ONLY
function in the package where mode changes runtime browser behavior:

```ts
export function resolveLaunchArgs(opts: McpClientOptions): string[] {
  const base = buildServerArgs(opts);
  return effectiveMode(opts.mode) === "headless" ? [...base, HEADLESS_FLAG] : [...base];
}
```

Everything else only parses, validates, records, or reports mode.

## Complete mode-reader classification

### `mcp/client.ts` — the launch seam
| Symbol | Category | Changes browser behavior? | Justification |
|---|---|---|---|
| `resolveLaunchArgs` | **launch** | **YES** | adds exactly one `--headless` for headless; omits it for headed. The sole branch. |
| `PlaywrightMcpClient.buildLaunchArgs` | launch | indirect | returns `resolveLaunchArgs(this.opts)`. |
| `McpClientOptions.mode` | launch | only via the seam | consumed exclusively by `resolveLaunchArgs` + the display check. |
| `effectiveMode` | launch | no (resolver) | maps optional mode → effective (default headless); feeds the seam. |
| `HEADLESS_FLAG` | launch | no (constant) | the `--headless` literal. |
| `assertHeadedDisplay` | **validate** | no | branches on `mode === "headed"` only to **throw** (refuse a displayless headed launch); never alters a successful launch (D36, no fallback). |
| `isDisplayAvailable` | validate | no | reads env/platform, not mode. |
| `HeadedDisplayUnavailableError` | validate | no | error type. |
| `launch()` → `assertHeadedDisplay(effectiveMode(...))` | validate | no | pre-spawn refusal only. |
| `viewportDimensions` | record | no | derives `browser.viewport` metadata; no mode input. |
| `browserConfigFor` | record | no | builds the typed `browser` manifest metadata from viewport; no mode input. |
| `buildServerArgs` | launch | no | mode-**agnostic** base argv; does not read mode. |

### `run/schema.ts` — the run-log contract
| Symbol | Category | Justification |
|---|---|---|
| `BrowserMode`, `BrowserConfig` | record | type definitions for the manifest. |
| `isBrowserMode`, `isBrowserConfig`, `assertValidModeMetadata`, `InvalidRunManifestError` | validate | 1.2 write/read validation (shape + `requestedMode === mode`). |
| `RunManifest.mode` / `.requestedMode` / `.browser` | record | recorded manifest fields. |

### `run/logger.ts` — the manifest writer
| Symbol | Category | Justification |
|---|---|---|
| `RunLoggerOptions.mode/requestedMode/browser` | record | required 1.2 write input. |
| constructor `assertValidModeMetadata(opts)` | validate | refuses an incomplete/contradictory manifest before any write. |
| `writeManifest` mode/requestedMode/browser | record | written verbatim; never branched on. |

### `run/audit.ts` — the manifest reader
| Symbol | Category | Justification |
|---|---|---|
| `readManifest` → `if (version === "1.2") assertValidModeMetadata(manifest)` | validate | read boundary; does not alter execution. |

### `run-cli.ts` — the single CLI entry
| Symbol | Category | Justification |
|---|---|---|
| `parseRunArgs` / `ParsedRunArgs.requestedMode` | parse | the only `--headed` parse site; rejects `--headless`/unknown. |
| `assertHeadedDisplay(requestedMode)` | validate | fails loudly before any browser work; no fallback. |
| `const mode = requestedMode` | record | effective = requested (D36 has no silent fallback). |
| `new PlaywrightMcpClient({ …, mode })` | launch | hands the resolved mode to the seam. |
| `browserConfigFor(plan.viewport)` | record | typed browser metadata for the manifest. |
| `runFlow({ mode, requestedMode, browser })` | record | passes metadata to the logger. |
| stdout `mode=${mode}` / `mode=${manifest.mode}` | report | operator display only. |

### `engine/loop.ts` — the execution loop
| Symbol | Category | Justification |
|---|---|---|
| `RunFlowOptions.mode/requestedMode/browser` | record | forwarded to the logger. |
| runFlow logger construction `mode/requestedMode/browser` | record | **forward only** — the loop never reads mode again; no branch, prompt, guard, retry, or decision uses it. |

### `parity/snapshot-parity.ts` — Phase 5 comparison tooling
| Symbol | Category | Justification |
|---|---|---|
| optional `labels { left, right }` (e.g. `{headed, headless}`) | report | caller-supplied display annotations; the comparator treats them opaquely and never branches on them. |

## Forbidden modules — confirmed to contain NO mode-bearing logic

These execution/verification/reporting modules contain **zero** mode-bearing identifiers
(only ordinary prose like "drive a real web browser" or "failure mode" in comments, which the
static guard ignores). The static surface guard fails if that ever changes:

`engine/decider.ts` · `verify/verifier.ts` · `verify/prompt.ts` · `verify/resolver.ts` ·
`verify/citation.ts` · `verify/evaluation.ts` · `verify/writer.ts` · `engine/guards.ts` ·
`run/redaction.ts` · `run/pricing.ts` · `report/summary.ts` · `report/builder.ts` ·
`report/compare.ts` · `report/html.ts` · `report/manifest.ts` · `report/labels.ts`.

Notably the Phase 4 report builder records `model`, `executionStatus`, `totals`, `planHash`,
and `runLogSchemaVersion` from the manifest but **not** `mode` — reporting does not even
surface mode, let alone branch on it.

## Distinguishing legitimate validation from runtime behavior

- `assertHeadedDisplay` is permitted **validation** — it refuses loudly, it does not change a
  successful run's browser behavior or its verdict.
- CLI `--headed` parsing is permitted **parse**.
- Manifest `mode`/`requestedMode`/`browser` recording is permitted **record**.
- Parity tooling reading/displaying mode labels is permitted **report**.
- None of these alter execution decisions, evidence, or verdicts — proven by the runtime
  invariance tests (same fixed inputs ⇒ identical events, decisions, evidence, evaluation,
  and report apart from the explicitly recorded manifest mode metadata).

## Excluded false positives (not mode logic)

`--snapshot-mode` / `--output-mode` / `--browser` (MCP CLI flags); "failure mode",
"the browser", "no browser", "drive a real web browser" (prose); `model` (the LLM id).
