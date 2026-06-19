// CLI entry for the Phase 2 execution engine (Phase 5: headed/headless contract;
// Phase 6: --id-file emission + the D38 exit-code contract).
//
// Usage: `npm run run -- <path/to/file.flow.md> [--headed] [--id-file <path>]`
//   default        headless  (the CI / production path)
//   --headed       headed    (local debugging only; fails loudly with no display)
//   --id-file <p>  write ONLY the runId to <p> (D39) so CI threads it without scraping stdout
// There is deliberately NO `--headless` flag and no `PROOFLOOP_HEADED` env var (one
// override, one source of truth — D36). Mode reaches runtime browser behavior only at
// the MCP launch seam (D32); here it is parsed, validated, and recorded.
//
// D38 exit codes: run-cli exits 0 whenever it FINALIZES a trustworthy run artifact and
// exposes its runId — regardless of the recorded executionStatus (completed | blocked |
// guard_tripped | error | cancelled). Recorded terminal states are DATA, not process
// failures. Non-zero is reserved for failures that mean the artifact could not be produced
// or trusted: invalid args, missing config, malformed flow, headed-without-display, an
// --id-file write failure, or an uncaught crash.
//
// Boots a managed Playwright MCP browser (isolated), drives the flow through the
// snapshot-then-act loop, and writes artifacts under platform/runs/<runId>/. The SUT
// must already be running (e.g. `npm --prefix app run dev`); the executor is only given
// BASE_URL + the flow file — it never reads app/ source.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlowFile, FlowParseError } from "./parser";
import type { FlowPlan } from "./flow-plan";
import { readEngineConfig, type EngineConfig } from "./config";
import { AnthropicDecider } from "./engine/decider";
import { runFlow } from "./engine/loop";
import {
  PlaywrightMcpClient,
  assertHeadedDisplay,
  browserConfigFor,
} from "./mcp/client";
import type { BrowserMode, RunManifest } from "./run/schema";
import { writeIdFile } from "./cli-idfile";

const USAGE =
  "usage: npm run run -- <path/to/file.flow.md> [--headed] [--id-file <path>]";

export type ParsedRunArgs =
  | { ok: true; flowPath: string; requestedMode: BrowserMode; idFilePath?: string }
  | { ok: false; error: string };

/**
 * Parse the run CLI args: exactly one positional flow path, the single optional `--headed`
 * override, and the optional `--id-file <path>` (D39). Any other option (including
 * `--headless`) is rejected loudly so an unsupported flag never silently no-ops. Pure +
 * exported so the contract is unit-tested without invoking the live run. This is the SINGLE
 * site where `--headed` is parsed. `idFilePath` is omitted (not set to undefined) when absent
 * so the result shape stays minimal.
 */
export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const positionals: string[] = [];
  let requestedMode: BrowserMode = "headless";
  let idFilePath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--headed") {
      requestedMode = "headed";
      continue;
    }
    if (a === "--id-file") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--id-file requires a file path argument." };
      }
      idFilePath = value;
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      return {
        ok: false,
        error:
          `unknown option: ${a}. The only mode override is --headed ` +
          `— headless is the default and there is no --headless flag.`,
      };
    }
    positionals.push(a);
  }
  if (positionals.length !== 1) {
    return { ok: false, error: "exactly one flow file path is required." };
  }
  return {
    ok: true,
    flowPath: positionals[0],
    requestedMode,
    ...(idFilePath !== undefined ? { idFilePath } : {}),
  };
}

/** Everything the run executor needs — what the CLI resolved from args + config. */
export interface RunInputs {
  plan: FlowPlan;
  baseUrl: string;
  apiKey: string;
  model: string;
  pricingConfigId: string;
  runId: string;
  runsRoot: string;
  mode: BrowserMode;
  requestedMode: BrowserMode;
}

/**
 * Executes one flow and returns its FINALIZED manifest. This is the injection seam that lets
 * the CLI's exit-code + id-file contract be unit-tested without a live browser/LLM. The
 * production implementation is `defaultRunExecutor`.
 */
export type RunExecutor = (inputs: RunInputs) => Promise<RunManifest>;

/**
 * The production executor: wires the real decider + managed MCP browser into runFlow, with
 * the exact scratch-dir handling and cleanup of the pre-Phase-6 CLI body (unchanged).
 */
async function defaultRunExecutor(inputs: RunInputs): Promise<RunManifest> {
  const decider = new AnthropicDecider({ apiKey: inputs.apiKey, model: inputs.model });
  // The MCP server writes its own (unmasked) scratch artifacts to its output dir. Keep that
  // OUTSIDE the run dir so the run dir holds only our masked artifacts; delete on exit.
  const mcpScratch = path.join(os.tmpdir(), `proofloop-mcp-${inputs.runId}`);
  const actuator = new PlaywrightMcpClient({
    viewport: inputs.plan.viewport,
    outputDir: mcpScratch,
    mode: inputs.mode,
  });
  // Typed browser config for the manifest (D36) — derived from the same launch facts +
  // viewport mapping as the MCP server args; never raw subprocess args.
  const browser = browserConfigFor(inputs.plan.viewport);
  try {
    return await runFlow({
      plan: inputs.plan,
      baseUrl: inputs.baseUrl,
      runId: inputs.runId,
      runsRoot: inputs.runsRoot,
      model: inputs.model,
      pricingConfigId: inputs.pricingConfigId,
      decider,
      actuator,
      mode: inputs.mode,
      requestedMode: inputs.requestedMode,
      browser,
    });
  } finally {
    fs.rmSync(mcpScratch, { recursive: true, force: true });
  }
}

/** The runId namespace: `<flowId>-<iso-stamp>-<rand8>`. No randomness anywhere else. */
function defaultRunId(flowId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${flowId}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/** Injectable seams (all default to the production implementations). */
export interface RunCliDeps {
  parseFlow: (flowPath: string) => FlowPlan;
  readConfig: () => EngineConfig;
  assertDisplay: (mode: BrowserMode) => void;
  execute: RunExecutor;
  writeIdFile: (filePath: string, id: string) => void;
  newRunId: (flowId: string) => string;
  runsRoot: string;
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

/**
 * The run CLI as a pure-ish function returning a PROCESS EXIT CODE. Stdout/stderr go to the
 * injected streams (defaulting to the real process streams), so the human-facing lines are
 * byte-identical to the pre-Phase-6 CLI; only the exit-code contract and the optional
 * `--id-file` are new.
 */
export async function runCli(
  argv: readonly string[],
  deps: Partial<RunCliDeps> = {},
): Promise<number> {
  const parseFlow = deps.parseFlow ?? parseFlowFile;
  const readConfig = deps.readConfig ?? readEngineConfig;
  const assertDisplay = deps.assertDisplay ?? assertHeadedDisplay;
  const execute = deps.execute ?? defaultRunExecutor;
  const writeId = deps.writeIdFile ?? writeIdFile;
  const newRunId = deps.newRunId ?? defaultRunId;
  const runsRoot = deps.runsRoot ?? path.join(__dirname, "..", "runs");
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  const parsed = parseRunArgs(argv.slice(2));
  if (!parsed.ok) {
    err.write(`${USAGE}\n${parsed.error}\n`);
    return 2;
  }
  const { flowPath, requestedMode, idFilePath } = parsed;

  let plan: FlowPlan;
  try {
    plan = parseFlow(flowPath);
  } catch (e) {
    err.write(
      e instanceof FlowParseError ? `parse error: ${e.message}\n` : `${e}\n`,
    );
    return 1;
  }

  const cfg = readConfig();
  if (!cfg.anthropicApiKey) {
    err.write(
      "ANTHROPIC_API_KEY is not set. Put it in .env (gitignored); it is read from env only.\n",
    );
    return 2;
  }

  // Fail loud BEFORE any browser work if headed was requested without a display (D36).
  // No silent fallback to headless — a "headed" run must never become secretly headless.
  try {
    assertDisplay(requestedMode);
  } catch (e) {
    err.write(`${(e as Error).message}\n`);
    return 2;
  }
  // Effective mode equals the requested mode: D36 defines no silent fallback.
  const mode: BrowserMode = requestedMode;

  const runId = newRunId(plan.id);
  const runDir = path.join(runsRoot, runId);

  out.write(
    `▶ flow=${plan.id} mode=${mode} model=${cfg.model} baseUrl=${cfg.baseUrl}\n  runId=${runId}\n`,
  );

  const manifest = await execute({
    plan,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.anthropicApiKey,
    model: cfg.model,
    pricingConfigId: cfg.pricingConfigId,
    runId,
    runsRoot,
    mode,
    requestedMode,
  });

  out.write(
    `■ executionStatus=${manifest.executionStatus}  ` +
      `mode=${manifest.mode} ` +
      `actions=${manifest.totals.actionCount} ` +
      `llmCost=$${manifest.totals.costUsd.toFixed(4)}\n  dir: ${runDir}\n`,
  );

  // D39: emit ONLY the runId to the id-file, AFTER a trustworthy artifact is finalized.
  // A write failure here means CI cannot thread the id → a real failure (never a false
  // success), so exit non-zero.
  if (idFilePath) {
    try {
      writeId(idFilePath, manifest.runId);
    } catch (e) {
      err.write(
        `failed to write --id-file ${idFilePath}: ${(e as Error).message}\n`,
      );
      return 1;
    }
  }

  // D38: a finalized run manifest is a trustworthy artifact regardless of executionStatus
  // (completed | blocked | guard_tripped | error | cancelled) → exit 0. This is the
  // load-bearing reason CI can record a non-PASS flow and STILL run the remaining flows.
  return 0;
}

// Only run the CLI when executed directly — importing this module (e.g. to unit-test
// parseRunArgs / runCli) must NOT spawn a run.
if (require.main === module) {
  runCli(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
