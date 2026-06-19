// CLI entry for the Phase 3 outcome verifier.
//
// Usage: `npm run verify -- --run <runId>`
// Reads a FINISHED run's frozen artifacts under platform/runs/<runId>/, re-parses the
// flow from fixtures/flows/<flowId>.flow.md, pins it to the executed plan via planHash,
// grades each acceptance criterion with the live Anthropic verifier, and writes an
// evaluation record under platform/runs/<runId>/evaluations/<evaluationId>/.
//
// Black-box boundary: like the executor, this only reads the run's own artifacts and the
// flow file. It never reads app/ source, the bug ledger, PROOFLOOP_BUGS, or the debug
// token. The verifier model has NO default — requireVerifierModel fails loud if unset, so
// an absent config can never silently spend money on a fallback model.

import * as path from "node:path";

import { readEngineConfig, requireVerifierModel } from "./config";
import { AnthropicVerifier, VERIFIER_PARAMS } from "./verify/verifier";
import { writeEvaluation, PlanHashMismatchError } from "./verify/writer";

function parseArgs(args: string[]): { runId: string } | null {
  // Only `--run <runId>` is supported; keep the surface minimal and explicit.
  if (args.length === 2 && args[0] === "--run" && args[1].length > 0) {
    return { runId: args[1] };
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if (!parsed) {
    process.stderr.write("usage: npm run verify -- --run <runId>\n");
    return 2;
  }

  const cfg = readEngineConfig();
  if (!cfg.anthropicApiKey) {
    process.stderr.write(
      "ANTHROPIC_API_KEY is not set. Put it in .env (gitignored); it is read from env only.\n",
    );
    return 2;
  }

  let verifierModel: string;
  try {
    verifierModel = requireVerifierModel(cfg);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const runsRoot = path.join(__dirname, "..", "runs");
  const runDir = path.join(runsRoot, parsed.runId);
  const flowsDir = path.join(__dirname, "..", "..", "fixtures", "flows");

  const verifier = new AnthropicVerifier({
    apiKey: cfg.anthropicApiKey,
    model: verifierModel,
  });

  process.stdout.write(
    `▶ verify run=${parsed.runId} verifierModel=${verifierModel}\n`,
  );
  try {
    const { record, evaluationId, evaluationPath } = await writeEvaluation({
      runDir,
      flowsDir,
      verifier,
      verifierModel,
      verifierParams: VERIFIER_PARAMS,
      pricingConfigId: cfg.pricingConfigId,
    });
    process.stdout.write(
      `■ flowVerdict=${record.flowVerdict}  ` +
        `criteria=${record.criteria.map((c) => c.verdict).join(",")}  ` +
        `verifierCost=$${record.totals.costUsd.toFixed(4)}\n` +
        `  ${evaluationId}: ${evaluationPath}\n`,
    );
    return record.flowVerdict === "PASS" ? 0 : 1;
  } catch (e) {
    if (e instanceof PlanHashMismatchError) {
      process.stderr.write(`plan mismatch: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
