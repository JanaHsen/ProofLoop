// CLI for the Phase 6 deterministic report:ci aggregator (D43).
//
// Usage: npm run report:ci -- --results <ci-results.json> --out-dir <dir>
//
// Reads ci-results.json (the workflow's runtime ledger), aggregates all flows, and
// writes <out-dir>/summary.json + <out-dir>/summary.md. Exits 0 whenever both
// artifacts are successfully produced — including aggregates that contain FAIL,
// INCONCLUSIVE, or pipeline ERROR rows. Exit 0 means the summaries are trustworthy;
// the final enforcement step (in the workflow) reads allPass, not this exit code.
// Non-zero is reserved for inability to produce trustworthy summaries.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  aggregateCiResults,
  CiResultsError,
  CiReportError,
  type AggregateCiResultsOptions,
  type AggregateCiResultsOutput,
} from "./ci/report-ci";

export interface ParsedReportCiArgs {
  resultsPath: string;
  outDir: string;
  /** Optional explicit repository root for resolving repo-root-relative reportPaths.
   *  CI passes `$GITHUB_WORKSPACE`; absent => the library default (derived from __dirname). */
  repoRoot?: string;
}

/**
 * Parse `--results <path> --out-dir <dir> [--repo-root <dir>]` (results+out-dir required,
 * order-independent). Pure/testable. `--repo-root` lets CI pin the repository root explicitly
 * (`$GITHUB_WORKSPACE`) so a ledger's repo-root-relative reportPaths resolve on the runner
 * regardless of where the process was launched.
 */
export function parseReportCiArgs(args: readonly string[]): ParsedReportCiArgs | null {
  let resultsPath: string | undefined;
  let outDir: string | undefined;
  let repoRoot: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) return null;
    if (flag === "--results") resultsPath = value;
    else if (flag === "--out-dir") outDir = value;
    else if (flag === "--repo-root") repoRoot = value;
    else return null;
  }
  if (!resultsPath || !outDir) return null;
  return repoRoot !== undefined ? { resultsPath, outDir, repoRoot } : { resultsPath, outDir };
}

export interface ReportCiCliDeps {
  aggregate: (opts: AggregateCiResultsOptions) => AggregateCiResultsOutput;
  mkdir: (dir: string) => void;
  writeFile: (filePath: string, content: string) => void;
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

function defaultDeps(): ReportCiCliDeps {
  return {
    aggregate: aggregateCiResults,
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
    out: process.stdout,
    err: process.stderr,
  };
}

export function reportCiCli(argv: readonly string[], deps: Partial<ReportCiCliDeps> = {}): number {
  const d: ReportCiCliDeps = { ...defaultDeps(), ...deps };

  const parsed = parseReportCiArgs(Array.from(argv).slice(2));
  if (!parsed) {
    d.err.write(
      "usage: npm run report:ci -- --results <ci-results.json> --out-dir <dir> [--repo-root <dir>]\n",
    );
    return 2;
  }

  const resultsAbsPath = path.resolve(parsed.resultsPath);
  const outAbsDir = path.resolve(parsed.outDir);
  const jsonPath = path.join(outAbsDir, "summary.json");
  const mdPath = path.join(outAbsDir, "summary.md");

  let output: AggregateCiResultsOutput;
  try {
    output = d.aggregate({
      resultsPath: resultsAbsPath,
      ...(parsed.repoRoot !== undefined ? { repoRoot: path.resolve(parsed.repoRoot) } : {}),
    });
  } catch (e) {
    if (e instanceof CiResultsError || e instanceof CiReportError) {
      d.err.write(`${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }

  try {
    d.mkdir(outAbsDir);
  } catch (e) {
    d.err.write(`failed to create output directory ${outAbsDir}: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    d.writeFile(jsonPath, output.summaryJson);
  } catch (e) {
    d.err.write(`failed to write ${jsonPath}: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    d.writeFile(mdPath, output.summaryMd);
  } catch (e) {
    d.err.write(`failed to write ${mdPath}: ${(e as Error).message}\n`);
    return 1;
  }

  d.out.write(`■ report:ci summary.json + summary.md → ${outAbsDir}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(reportCiCli(process.argv));
}
