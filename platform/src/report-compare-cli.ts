// CLI entry for the Phase 4 four-state comparison page (Task 3).
//
// Usage: `npm run report:compare -- --manifest ../presentation/phase3-demo-manifest.json`
// Reads the human-authored presentation manifest, builds each selected per-run report from
// the frozen run + evaluation artifacts (same Task 1 builder — D28 integrity + D29 redaction
// included), and writes ONE self-contained comparison.html next to the manifest (or --out).
//
// Offline by construction: no browser, verifier, LLM, or network. The manifest is the only
// place display labels live; nothing here infers bug/mutation state from run artifacts.

import * as path from "node:path";

import { ReportArtifactNotFoundError, ReportIntegrityError } from "./report/builder";
import { buildComparison, renderComparisonHtml } from "./report/compare";
import { ManifestError } from "./report/manifest";

import * as fs from "node:fs";

export interface CompareArgs {
  manifestPath: string;
  outPath?: string;
}

/** Parse `--manifest <path>` (required) and optional `--out <path>`. Pure / testable. */
export function parseCompareArgs(args: string[]): CompareArgs | null {
  let manifestPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) return null;
    if (flag === "--manifest") manifestPath = value;
    else if (flag === "--out") outPath = value;
    else return null;
  }
  if (!manifestPath) return null;
  return outPath ? { manifestPath, outPath } : { manifestPath };
}

function main(argv: string[]): number {
  const parsed = parseCompareArgs(argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      "usage: npm run report:compare -- --manifest <path> [--out <path>]\n",
    );
    return 2;
  }

  const runsRoot = path.join(__dirname, "..", "runs");
  const flowsDir = path.join(__dirname, "..", "..", "fixtures", "flows");
  const outPath =
    parsed.outPath ?? path.join(path.dirname(parsed.manifestPath), "comparison.html");

  try {
    const model = buildComparison({ manifestPath: parsed.manifestPath, runsRoot, flowsDir });
    fs.writeFileSync(outPath, renderComparisonHtml(model), "utf8");
    process.stdout.write(
      `■ comparison runs=${model.runs.length} ` +
        `verdicts=${model.runs.map((r) => `${r.label}:${r.flowVerdict}`).join(", ")}\n` +
        `  ${outPath}\n`,
    );
    return 0;
  } catch (e) {
    if (
      e instanceof ManifestError ||
      e instanceof ReportIntegrityError ||
      e instanceof ReportArtifactNotFoundError
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
