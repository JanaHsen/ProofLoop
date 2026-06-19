// CLI entry for the Phase 2 execution engine (Phase 5: headed/headless contract).
//
// Usage: `npm run run -- <path/to/file.flow.md> [--headed]`
//   default        headless  (the CI / production path)
//   --headed       headed    (local debugging only; fails loudly with no display)
// There is deliberately NO `--headless` flag and no `PROOFLOOP_HEADED` env var (one
// override, one source of truth — D36). Mode reaches runtime browser behavior only at
// the MCP launch seam (D32); here it is parsed, validated, and recorded.
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
import { readEngineConfig } from "./config";
import { AnthropicDecider } from "./engine/decider";
import { runFlow } from "./engine/loop";
import {
  PlaywrightMcpClient,
  assertHeadedDisplay,
  browserConfigFor,
} from "./mcp/client";
import type { BrowserMode } from "./run/schema";

const USAGE = "usage: npm run run -- <path/to/file.flow.md> [--headed]";

export type ParsedRunArgs =
  | { ok: true; flowPath: string; requestedMode: BrowserMode }
  | { ok: false; error: string };

/**
 * Parse the run CLI args: exactly one positional flow path, plus the single optional
 * `--headed` override. Any other option (including `--headless`) is rejected loudly so an
 * unsupported flag never silently no-ops. Pure + exported so the contract is unit-tested
 * without invoking the live run. This is the SINGLE site where `--headed` is parsed.
 */
export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const options = args.filter((a) => a.startsWith("-"));
  const positionals = args.filter((a) => !a.startsWith("-"));
  const unknown = options.filter((a) => a !== "--headed");
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `unknown option(s): ${unknown.join(", ")}. The only mode override is --headed ` +
        `— headless is the default and there is no --headless flag.`,
    };
  }
  if (positionals.length !== 1) {
    return { ok: false, error: "exactly one flow file path is required." };
  }
  return {
    ok: true,
    flowPath: positionals[0],
    requestedMode: options.includes("--headed") ? "headed" : "headless",
  };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\n${parsed.error}\n`);
    return 2;
  }
  const { flowPath, requestedMode } = parsed;

  let plan;
  try {
    plan = parseFlowFile(flowPath);
  } catch (e) {
    process.stderr.write(
      e instanceof FlowParseError ? `parse error: ${e.message}\n` : `${e}\n`,
    );
    return 1;
  }

  const cfg = readEngineConfig();
  if (!cfg.anthropicApiKey) {
    process.stderr.write(
      "ANTHROPIC_API_KEY is not set. Put it in .env (gitignored); it is read from env only.\n",
    );
    return 2;
  }

  // Fail loud BEFORE any browser work if headed was requested without a display (D36).
  // No silent fallback to headless — a "headed" run must never become secretly headless.
  try {
    assertHeadedDisplay(requestedMode);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  // Effective mode equals the requested mode: D36 defines no silent fallback, so the only
  // way headed→headless could differ is the loud failure above. Both are recorded.
  const mode: BrowserMode = requestedMode;

  const runsRoot = path.join(__dirname, "..", "runs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${plan.id}-${stamp}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(runsRoot, runId);

  const decider = new AnthropicDecider({
    apiKey: cfg.anthropicApiKey,
    model: cfg.model,
  });
  // The MCP server writes its own (unmasked) scratch artifacts to its output dir.
  // Keep that OUTSIDE the run dir so the run dir holds only our masked artifacts;
  // delete the scratch on exit.
  const mcpScratch = path.join(os.tmpdir(), `proofloop-mcp-${runId}`);
  const actuator = new PlaywrightMcpClient({
    viewport: plan.viewport,
    outputDir: mcpScratch,
    mode,
  });

  // Typed browser config for the manifest (D36) — derived from the same launch facts +
  // viewport mapping as the MCP server args; never raw subprocess args.
  const browser = browserConfigFor(plan.viewport);

  process.stdout.write(
    `▶ flow=${plan.id} mode=${mode} model=${cfg.model} baseUrl=${cfg.baseUrl}\n  runId=${runId}\n`,
  );
  try {
    const manifest = await runFlow({
      plan,
      baseUrl: cfg.baseUrl,
      runId,
      runsRoot,
      model: cfg.model,
      pricingConfigId: cfg.pricingConfigId,
      decider,
      actuator,
      mode,
      requestedMode,
      browser,
    });
    process.stdout.write(
      `■ executionStatus=${manifest.executionStatus}  ` +
        `mode=${manifest.mode} ` +
        `actions=${manifest.totals.actionCount} ` +
        `llmCost=$${manifest.totals.costUsd.toFixed(4)}\n  dir: ${runDir}\n`,
    );
    return manifest.executionStatus === "completed" ? 0 : 1;
  } finally {
    fs.rmSync(mcpScratch, { recursive: true, force: true });
  }
}

// Only run the CLI when executed directly — importing this module (e.g. to unit-test
// parseRunArgs) must NOT spawn a run.
if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
