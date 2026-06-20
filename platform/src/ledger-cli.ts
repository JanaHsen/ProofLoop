// CLI for the Phase 6 CI runtime ledger (Task 4). A thin, deterministic wrapper over
// ci/ledger.ts so the workflow's bash never hand-edits JSON. No secret, no model call.
//
// Subcommands:
//   init           --out <ledger.json> [--manifest <ci-flows.json>] [--repo-root <dir>]
//   record         --ledger <ledger.json> --flow <flowPath> --stage <run|verify|report|complete>
//                  [--run-id <id>] [--evaluation-id <id>] [--report-path <repo-rel>]
//                  [--error-class <CLASS>] [--error-message <safe text>]
//   mark-all-error --ledger <ledger.json> --stage <run> --error-class <CLASS>
//                  [--error-message <safe text>]

import * as fs from "node:fs";

import { CiFlowManifestError, loadCiFlowManifest } from "./ci/flow-manifest";
import {
  initialLedger,
  LedgerError,
  markAllError,
  recordEntry,
  serializeLedger,
  type CiStage,
  type LedgerEntry,
} from "./ci/ledger";

const STAGES = new Set<CiStage>(["run", "verify", "report", "complete"]);

export interface LedgerCliDeps {
  readFile: (p: string) => string;
  writeFile: (p: string, c: string) => void;
  loadManifest: typeof loadCiFlowManifest;
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

function defaultDeps(): LedgerCliDeps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf8"),
    loadManifest: loadCiFlowManifest,
    out: process.stdout,
    err: process.stderr,
  };
}

/** Parse `--flag value` pairs into a map. Returns null on a dangling flag or non-`--` token. */
function parseFlags(args: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag.startsWith("--") || value === undefined) return null;
    out[flag.slice(2)] = value;
  }
  return out;
}

function readLedger(deps: LedgerCliDeps, path: string): LedgerEntry[] {
  const parsed = JSON.parse(deps.readFile(path));
  if (!Array.isArray(parsed)) {
    throw new LedgerError(`ledger at ${path} is not a JSON array.`);
  }
  return parsed as LedgerEntry[];
}

export function ledgerCli(argv: readonly string[], deps: Partial<LedgerCliDeps> = {}): number {
  const d: LedgerCliDeps = { ...defaultDeps(), ...deps };
  const [sub, ...rest] = Array.from(argv).slice(2);

  try {
    if (sub === "init") {
      const f = parseFlags(rest);
      if (!f || !f.out) {
        d.err.write("usage: ledger-cli init --out <ledger.json> [--manifest <path>] [--repo-root <dir>]\n");
        return 2;
      }
      const manifest = d.loadManifest({
        ...(f.manifest !== undefined ? { manifestPath: f.manifest } : {}),
        ...(f["repo-root"] !== undefined ? { repoRoot: f["repo-root"] } : {}),
      });
      const ledger = initialLedger(manifest.flows.map((fl) => fl.flowPath));
      d.writeFile(f.out, serializeLedger(ledger));
      d.out.write(`■ ledger init — ${ledger.length} flow(s) → ${f.out}\n`);
      return 0;
    }

    if (sub === "record") {
      const f = parseFlags(rest);
      if (!f || !f.ledger || !f.flow || !f.stage || !STAGES.has(f.stage as CiStage)) {
        d.err.write(
          "usage: ledger-cli record --ledger <path> --flow <flowPath> --stage <run|verify|report|complete> " +
            "[--run-id <id>] [--evaluation-id <id>] [--report-path <p>] [--error-class <C>] [--error-message <t>]\n",
        );
        return 2;
      }
      const ledger = readLedger(d, f.ledger);
      const next = recordEntry(ledger, {
        flowPath: f.flow,
        stage: f.stage as CiStage,
        runId: f["run-id"],
        evaluationId: f["evaluation-id"],
        reportPath: f["report-path"],
        errorClass: f["error-class"],
        errorMessage: f["error-message"],
      });
      d.writeFile(f.ledger, serializeLedger(next));
      d.out.write(`■ ledger record — ${f.flow} → ${f.stage}\n`);
      return 0;
    }

    if (sub === "mark-all-error") {
      const f = parseFlags(rest);
      if (!f || !f.ledger || !f.stage || !f["error-class"]) {
        d.err.write(
          "usage: ledger-cli mark-all-error --ledger <path> --stage <run> --error-class <C> [--error-message <t>]\n",
        );
        return 2;
      }
      const ledger = readLedger(d, f.ledger);
      const next = markAllError(ledger, {
        stage: f.stage as CiStage,
        errorClass: f["error-class"],
        errorMessage: f["error-message"],
      });
      d.writeFile(f.ledger, serializeLedger(next));
      d.out.write(`■ ledger mark-all-error — ${next.length} flow(s) → ${f["error-class"]}\n`);
      return 0;
    }

    d.err.write("usage: ledger-cli <init|record|mark-all-error> ...\n");
    return 2;
  } catch (e) {
    if (e instanceof LedgerError || e instanceof CiFlowManifestError) {
      d.err.write(`${(e as Error).message}\n`);
      return 1;
    }
    if (e instanceof SyntaxError) {
      d.err.write(`ledger is not valid JSON: ${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exit(ledgerCli(process.argv));
}
