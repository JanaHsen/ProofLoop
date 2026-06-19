/**
 * INVESTIGATION-ONLY runner (Phase 5 Task 2). Manually executed — NOT part of
 * `npm test`, NOT wired into the CLI/run path. Requires the clean SUT running
 * (PROOFLOOP_BUGS empty) and a real browser; spends NO API credits (no LLM at all).
 *
 *   node --require ts-node/register/transpile-only \
 *     test/investigation/run-capture.ts --base http://localhost:3000 --out <dir>
 *
 * For each auth-free checkpoint (/login, /form) it captures, via the production
 * snapshot path, in three isolated sessions:
 *   - headed  #1   (cross-mode A)
 *   - headed  #2   (same-mode control — distinguishes temporal churn from mode deltas)
 *   - headless #1  (cross-mode B)
 * then records same-mode (headed1 vs headed2) and cross-mode (headed1 vs headless1)
 * comparisons. Raw scrubbed snapshots + a deterministic report.json are written to --out.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Capture,
  CaptureComparison,
  captureCheckpoint,
  compareCaptures,
  writeCaptureEvidence,
} from "./mode-delta";

const CHECKPOINTS = ["/login", "/form"] as const;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface CheckpointReport {
  route: string;
  captures: { id: string; mode: string; digest: string; refCount: number; lines: number }[];
  sameModeControl: CaptureComparison; // headed#1 vs headed#2
  crossMode: CaptureComparison; // headed#1 vs headless#1
}

async function main(): Promise<void> {
  const baseUrl = arg("--base", process.env.BASE_URL ?? "http://localhost:3000");
  const outDir = arg(
    "--out",
    path.join(os.tmpdir(), `proofloop-task2-${process.pid}`),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const sessionsRoot = path.join(outDir, "sessions");

  const report: { baseUrl: string; checkpoints: CheckpointReport[] } = {
    baseUrl,
    checkpoints: [],
  };

  for (const route of CHECKPOINTS) {
    const slug = route.replace(/[^a-z0-9]+/gi, "") || "root";
    const cap = async (id: string, mode: "headed" | "headless"): Promise<Capture> =>
      captureCheckpoint({
        captureId: `${slug}.${id}`,
        mode,
        baseUrl,
        route,
        outputDir: path.join(sessionsRoot, `${slug}.${id}`),
      });

    // Sequential, fresh isolated session each — keeps non-mode inputs constant.
    const headed1 = await cap("headed-1", "headed");
    const headed2 = await cap("headed-2", "headed");
    const headless1 = await cap("headless-1", "headless");

    for (const c of [headed1, headed2, headless1]) {
      writeCaptureEvidence(path.join(outDir, "snapshots"), c);
    }

    report.checkpoints.push({
      route,
      captures: [headed1, headed2, headless1].map((c) => ({
        id: c.captureId,
        mode: c.mode,
        digest: c.digest,
        refCount: c.refCount,
        lines: c.scrubbedYaml.split(/\r?\n/).length,
      })),
      sameModeControl: compareCaptures(headed1, headed2),
      crossMode: compareCaptures(headed1, headless1),
    });
  }

  fs.writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );

  // Human-readable summary to stdout.
  for (const cp of report.checkpoints) {
    process.stdout.write(`\n=== ${cp.route} ===\n`);
    for (const c of cp.captures) {
      process.stdout.write(
        `  ${c.id.padEnd(20)} mode=${c.mode.padEnd(8)} refs=${c.refCount} lines=${c.lines} ${c.digest}\n`,
      );
    }
    const sm = cp.sameModeControl;
    process.stdout.write(
      `  same-mode control (headed1 vs headed2): byteIdentical=${sm.byteIdentical} digestMatch=${sm.digestMatch} diffs=${sm.differences.length}\n`,
    );
    for (const d of sm.differences) {
      process.stdout.write(`     L${d.line}  A:${JSON.stringify(d.a)}  B:${JSON.stringify(d.b)}\n`);
    }
    const cm = cp.crossMode;
    process.stdout.write(
      `  cross-mode (headed1 vs headless1):       byteIdentical=${cm.byteIdentical} digestMatch=${cm.digestMatch} diffs=${cm.differences.length}\n`,
    );
    for (const d of cm.differences) {
      process.stdout.write(`     L${d.line}  headed:${JSON.stringify(d.a)}  headless:${JSON.stringify(d.b)}\n`);
    }
  }
  process.stdout.write(`\nartifacts: ${outDir}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
