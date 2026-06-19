// CLI for the Phase 5 Task 7 deterministic parity artifact.
//
// Usage:
//   node --require ts-node/register/transpile-only src/parity/parity-report-cli.ts \
//     --headed-run <id> --headed-eval <id> --headless-run <id> --headless-eval <id>
//
// All four selections are EXPLICIT and REQUIRED — the latest run/evaluation is never chosen
// automatically. Writes the validated, deterministic artifact to presentation/phase5-parity.json.
// No browser, decider, verifier, summarizer, or LLM client is involved.

import * as path from "node:path";

import { writeParityReport, type ParityReportInputs } from "./parity-report";

export type ParsedParityArgs =
  | { ok: true; inputs: ParityReportInputs }
  | { ok: false; error: string };

const FLAGS = ["--headed-run", "--headed-eval", "--headless-run", "--headless-eval"] as const;

export function parseParityArgs(args: readonly string[]): ParsedParityArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!FLAGS.includes(flag as (typeof FLAGS)[number]) || value === undefined || value.startsWith("--")) {
      return { ok: false, error: `bad or missing value for "${flag}"` };
    }
    map.set(flag, value);
  }
  const missing = FLAGS.filter((f) => !map.has(f));
  if (missing.length > 0) {
    return { ok: false, error: `missing required flags: ${missing.join(", ")}` };
  }
  return {
    ok: true,
    inputs: {
      headedRunId: map.get("--headed-run")!,
      headedEvaluationId: map.get("--headed-eval")!,
      headlessRunId: map.get("--headless-run")!,
      headlessEvaluationId: map.get("--headless-eval")!,
    },
  };
}

function main(argv: string[]): number {
  const parsed = parseParityArgs(argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(
      `usage: parity-report-cli ${FLAGS.map((f) => `${f} <id>`).join(" ")}\n${parsed.error}\n`,
    );
    return 2;
  }
  const runsRoot = path.join(__dirname, "..", "..", "runs");
  const flowsDir = path.join(__dirname, "..", "..", "..", "fixtures", "flows");
  const outPath = path.join(__dirname, "..", "..", "..", "presentation", "phase5-parity.json");

  const report = writeParityReport(outPath, parsed.inputs, { runsRoot, flowsDir });
  process.stdout.write(
    `■ wrote ${outPath}\n` +
      `  flow=${report.flow.flowId} planHash=${report.flow.planHash}\n` +
      `  headed=${report.demonstration.headed.runId} (${report.demonstration.headed.flowVerdict})\n` +
      `  headless=${report.demonstration.headless.runId} (${report.demonstration.headless.flowVerdict})\n` +
      `  sameVerdict=${report.demonstration.sameVerdict}\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
