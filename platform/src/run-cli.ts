// CLI entry for the Phase 2 execution engine.
//
// Usage: `npm run run -- <path/to/file.flow.md>`
// Boots a managed Playwright MCP browser (headed, isolated), drives the flow through
// the snapshot-then-act loop, and writes artifacts under platform/runs/<runId>/.
// The SUT must already be running (e.g. `npm --prefix app run dev`); the executor is
// only given BASE_URL + the flow file — it never reads app/ source.

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { parseFlowFile, FlowParseError } from "./parser";
import { readEngineConfig } from "./config";
import { AnthropicDecider } from "./engine/decider";
import { runFlow } from "./engine/loop";
import { PlaywrightMcpClient } from "./mcp/client";

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write("usage: npm run run -- <path/to/file.flow.md>\n");
    return 2;
  }

  let plan;
  try {
    plan = parseFlowFile(args[0]);
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

  const runsRoot = path.join(__dirname, "..", "runs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${plan.id}-${stamp}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(runsRoot, runId);

  const decider = new AnthropicDecider({
    apiKey: cfg.anthropicApiKey,
    model: cfg.model,
  });
  const actuator = new PlaywrightMcpClient({
    viewport: plan.viewport,
    outputDir: runDir,
  });

  process.stdout.write(
    `▶ flow=${plan.id} model=${cfg.model} baseUrl=${cfg.baseUrl}\n  runId=${runId}\n`,
  );
  const manifest = await runFlow({
    plan,
    baseUrl: cfg.baseUrl,
    runId,
    runsRoot,
    model: cfg.model,
    pricingConfigId: cfg.pricingConfigId,
    decider,
    actuator,
  });

  process.stdout.write(
    `■ executionStatus=${manifest.executionStatus}  ` +
      `actions=${manifest.totals.actionCount} ` +
      `llmCost=$${manifest.totals.costUsd.toFixed(4)}\n  dir: ${runDir}\n`,
  );
  return manifest.executionStatus === "completed" ? 0 : 1;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
