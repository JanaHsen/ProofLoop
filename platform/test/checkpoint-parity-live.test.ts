/**
 * Phase 5 Task 6 — LIVE deterministic cross-mode checkpoint parity. Drives BOTH modes through
 * the ordinary production launcher (PlaywrightMcpClient → McpClientOptions.mode →
 * resolveLaunchArgs) against the clean SUT, captures the production-scrubbed canonical YAML at
 * `/login` and `/form`, and compares with the FROZEN Task 4 comparator.
 *
 * OFF by default (launches real Chromium in BOTH headed and headless). Opt in with the existing
 * live-MCP convention AND a running clean SUT (PROOFLOOP_BUGS unset/empty):
 *   PROOFLOOP_LIVE_MCP=1 BASE_URL=http://localhost:3000 npm test
 *
 * Spends NO API credits: no decider, verifier, or summarizer — no Anthropic client is imported
 * and ANTHROPIC_API_KEY is neither read nor required. If headed mode is unavailable (no display)
 * the production client throws and THIS TEST FAILS — it never silently skips or falls back to
 * headless for both captures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assertCheckpointParity,
  captureCheckpoint,
  checkCheckpointParity,
} from "./parity/checkpoint-capture";

const SKIP = process.env.PROOFLOOP_LIVE_MCP
  ? false
  : "set PROOFLOOP_LIVE_MCP=1 (and run the clean SUT) for live cross-mode checkpoint parity";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const CHECKPOINTS = ["/login", "/form"] as const;

test("live: cross-mode checkpoint parity through the production launcher (clean SUT)", { skip: SKIP }, async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-task6-"));
  try {
    for (const route of CHECKPOINTS) {
      const slug = route.replace(/[^a-z0-9]+/gi, "") || "root";
      // headed FIRST — if no display is available the production client throws here and the
      // test fails loudly (no fallback, no silent headless-for-both).
      const headed = await captureCheckpoint({
        captureId: `${slug}.headed`,
        mode: "headed",
        baseUrl: BASE_URL,
        route,
        outputDir: path.join(outRoot, `${slug}.headed`),
      });
      const headless = await captureCheckpoint({
        captureId: `${slug}.headless`,
        mode: "headless",
        baseUrl: BASE_URL,
        route,
        outputDir: path.join(outRoot, `${slug}.headless`),
      });

      const outcome = checkCheckpointParity(headed, headless);
      // Per-checkpoint evidence to stdout.
      process.stdout.write(
        `\n[parity] ${route}\n` +
          `  headed   ${outcome.headedId}   ${outcome.headedDigest}\n` +
          `  headless ${outcome.headlessId} ${outcome.headlessDigest}\n` +
          `  byteEqual=${outcome.byteEqual} digestEqual=${outcome.digestEqual} ` +
          `parity.equal=${outcome.result.equal} diffs=${outcome.result.differences.length}\n`,
      );
      if (outcome.result.differences.length > 0) {
        process.stdout.write(JSON.stringify(outcome.result.differences, null, 2) + "\n");
      }

      // Frozen contract: any source-byte difference is a parity failure (raw-source fallback).
      assert.equal(outcome.result.equal, true, `${route}: parity must be equal`);
      assert.equal(outcome.result.differences.length, 0, `${route}: no differences`);
      assert.equal(outcome.byteEqual, true, `${route}: scrubbed YAML byte-identical`);
      assert.equal(outcome.digestEqual, true, `${route}: digests match`);
      assertCheckpointParity(outcome); // throws (never converts a mismatch to success)
    }
  } finally {
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});
