// CLI entry for the Phase 4 deterministic report generator (Task 1).
//
// Usage: `npm run report -- --run <runId> --evaluation <evaluationId>`
// Reads a FINISHED run's frozen artifacts under platform/runs/<runId>/, the EXPLICITLY
// selected evaluation under .../evaluations/<evaluationId>/, and re-parses the flow from
// fixtures/flows/<flowId>.flow.md. After asserting every D28 join invariant it writes
// report.json + report.html under platform/runs/<runId>/reports/<evaluationId>/.
//
// This path is OFFLINE by construction: no browser, no verifier, no LLM, no network, no API
// key. The evaluation is NEVER chosen implicitly — both flags are required, and the highest
// or newest evaluation is never assumed. Any integrity mismatch fails loud and writes nothing.

import * as path from "node:path";

import {
  ReportArtifactNotFoundError,
  ReportIntegrityError,
  UnsupportedEvaluationSchemaError,
} from "./report/builder";
import { writeReport } from "./report/writer";

export interface ReportArgs {
  runId: string;
  evaluationId: string;
}

/**
 * Parse `--run <runId> --evaluation <evaluationId>` (order-independent). Returns null if
 * either flag is missing or empty — the evaluation must be selected explicitly, never
 * defaulted. Pure and side-effect free so it can be unit-tested without running `main`.
 */
export function parseReportArgs(args: string[]): ReportArgs | null {
  let runId: string | undefined;
  let evaluationId: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) return null;
    if (flag === "--run") runId = value;
    else if (flag === "--evaluation") evaluationId = value;
    else return null;
  }
  if (!runId || !evaluationId) return null;
  return { runId, evaluationId };
}

function main(argv: string[]): number {
  const parsed = parseReportArgs(argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      "usage: npm run report -- --run <runId> --evaluation <evaluationId>\n",
    );
    return 2;
  }

  const runsRoot = path.join(__dirname, "..", "runs");
  const runDir = path.join(runsRoot, parsed.runId);
  const flowsDir = path.join(__dirname, "..", "..", "fixtures", "flows");

  try {
    const { jsonPath, htmlPath, report } = writeReport({
      runDir,
      evaluationId: parsed.evaluationId,
      flowsDir,
    });
    process.stdout.write(
      `■ report run=${parsed.runId} evaluation=${parsed.evaluationId} ` +
        `flowVerdict=${report.verification.flowVerdict} executionStatus=${report.execution.status}\n` +
        `  ${jsonPath}\n  ${htmlPath}\n`,
    );
    return 0;
  } catch (e) {
    if (
      e instanceof ReportIntegrityError ||
      e instanceof ReportArtifactNotFoundError ||
      e instanceof UnsupportedEvaluationSchemaError
    ) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}
