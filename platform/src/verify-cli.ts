// CLI entry for the Phase 3 outcome verifier (Phase 6: --id-file + the D38 exit-code contract).
//
// Usage: `npm run verify -- --run <runId> [--id-file <path>]`
//   --id-file <p>  write ONLY the evaluationId to <p> (D39) so CI threads it without scraping
//                  stdout.
// Reads a FINISHED run's frozen artifacts under platform/runs/<runId>/, re-parses the flow
// from fixtures/flows/<flowId>.flow.md, pins it to the executed plan via planHash, grades each
// acceptance criterion with the live Anthropic verifier, and writes an evaluation record under
// platform/runs/<runId>/evaluations/<evaluationId>/.
//
// D38 exit codes: verify-cli exits 0 whenever it writes a TRUSTWORTHY evaluation record —
// regardless of the verdict (PASS | FAIL | INCONCLUSIVE). The verdict is data the report /
// aggregator consumes. Non-zero is reserved for failures that mean no trustworthy record
// exists: invalid args, missing config/model, plan-hash mismatch, evidence-integrity error,
// unsupported schema, missing run, an --id-file write failure, or an uncaught crash.
//
// Black-box boundary: like the executor, this only reads the run's own artifacts and the
// flow file. It never reads app/ source, the bug ledger, PROOFLOOP_BUGS, or the debug token.
// The verifier model has NO default — requireVerifierModel fails loud if unset, so an absent
// config can never silently spend money on a fallback model.

import * as path from "node:path";

import { readEngineConfig, requireVerifierModel, type EngineConfig } from "./config";
import { AnthropicVerifier, VERIFIER_PARAMS, type Verifier } from "./verify/verifier";
import { writeEvaluation, PlanHashMismatchError } from "./verify/writer";
import { writeIdFile } from "./cli-idfile";

export interface ParsedVerifyArgs {
  runId: string;
  idFilePath?: string;
}

/**
 * Parse `--run <runId> [--id-file <path>]` (order-independent). Returns null on any unknown
 * flag, a missing/empty value, or an absent `--run`. Pure + exported so the surface is
 * unit-tested directly. `idFilePath` is omitted (not set to undefined) when absent.
 */
export function parseVerifyArgs(args: readonly string[]): ParsedVerifyArgs | null {
  let runId: string | undefined;
  let idFilePath: string | undefined;
  for (let i = 0; i < args.length; ) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--run") {
      if (value === undefined || value.length === 0) return null;
      runId = value;
      i += 2;
      continue;
    }
    if (flag === "--id-file") {
      if (value === undefined || value.startsWith("-")) return null;
      idFilePath = value;
      i += 2;
      continue;
    }
    return null; // unknown flag / stray positional
  }
  if (!runId) return null;
  return idFilePath !== undefined ? { runId, idFilePath } : { runId };
}

/** Injectable seams (all default to the production implementations). */
export interface VerifyCliDeps {
  readConfig: () => EngineConfig;
  requireModel: (cfg: EngineConfig) => string;
  makeVerifier: (opts: { apiKey: string; model: string }) => Verifier;
  writeEvaluationFn: typeof writeEvaluation;
  writeIdFile: (filePath: string, id: string) => void;
  runsRoot: string;
  flowsDir: string;
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

/**
 * The verify CLI as a function returning a PROCESS EXIT CODE. Stdout/stderr go to the injected
 * streams (defaulting to the real process streams), so the human-facing lines are byte-identical
 * to the pre-Phase-6 CLI; only the exit-code contract and the optional `--id-file` are new.
 */
export async function verifyCli(
  argv: readonly string[],
  deps: Partial<VerifyCliDeps> = {},
): Promise<number> {
  const readConfig = deps.readConfig ?? readEngineConfig;
  const requireModel = deps.requireModel ?? requireVerifierModel;
  const makeVerifier =
    deps.makeVerifier ??
    ((opts: { apiKey: string; model: string }) => new AnthropicVerifier(opts));
  const writeEvaluationFn = deps.writeEvaluationFn ?? writeEvaluation;
  const writeId = deps.writeIdFile ?? writeIdFile;
  const runsRoot = deps.runsRoot ?? path.join(__dirname, "..", "runs");
  const flowsDir = deps.flowsDir ?? path.join(__dirname, "..", "..", "fixtures", "flows");
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;

  const parsed = parseVerifyArgs(argv.slice(2));
  if (!parsed) {
    err.write("usage: npm run verify -- --run <runId> [--id-file <path>]\n");
    return 2;
  }

  const cfg = readConfig();
  if (!cfg.anthropicApiKey) {
    err.write(
      "ANTHROPIC_API_KEY is not set. Put it in .env (gitignored); it is read from env only.\n",
    );
    return 2;
  }

  let verifierModel: string;
  try {
    verifierModel = requireModel(cfg);
  } catch (e) {
    err.write(`${(e as Error).message}\n`);
    return 2;
  }

  const runDir = path.join(runsRoot, parsed.runId);
  const verifier = makeVerifier({ apiKey: cfg.anthropicApiKey, model: verifierModel });

  out.write(`▶ verify run=${parsed.runId} verifierModel=${verifierModel}\n`);
  try {
    const { record, evaluationId, evaluationPath } = await writeEvaluationFn({
      runDir,
      flowsDir,
      verifier,
      verifierModel,
      verifierParams: VERIFIER_PARAMS,
      pricingConfigId: cfg.pricingConfigId,
    });
    out.write(
      `■ flowVerdict=${record.flowVerdict}  ` +
        `criteria=${record.criteria.map((c) => c.verdict).join(",")}  ` +
        `verifierCost=$${record.totals.costUsd.toFixed(4)}\n` +
        `  ${evaluationId}: ${evaluationPath}\n`,
    );

    // D39: emit ONLY the evaluationId, AFTER the trustworthy record is written. A write
    // failure here is a real failure → non-zero (never a false success).
    if (parsed.idFilePath) {
      try {
        writeId(parsed.idFilePath, evaluationId);
      } catch (e) {
        err.write(
          `failed to write --id-file ${parsed.idFilePath}: ${(e as Error).message}\n`,
        );
        return 1;
      }
    }

    // D38: a trustworthy evaluation record was written → exit 0 regardless of the verdict
    // (PASS | FAIL | INCONCLUSIVE).
    return 0;
  } catch (e) {
    if (e instanceof PlanHashMismatchError) {
      err.write(`plan mismatch: ${e.message}\n`);
      return 1;
    }
    // Evidence-integrity, unsupported schema, missing run, and write failures are real
    // integrity/infra failures: rethrow so the process exits non-zero (top-level handler).
    throw e;
  }
}

// Only run the CLI when executed directly — importing this module (e.g. to unit-test
// parseVerifyArgs / verifyCli) must NOT spawn a verification.
if (require.main === module) {
  verifyCli(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
