/**
 * Phase 5 Task 6 — deterministic cross-mode checkpoint capture infrastructure.
 *
 * This is the SINGLE, PRODUCTION launch path for headed/headless captures. It drives the
 * ordinary production client and the Task 3 mode plumbing only:
 *
 *   PlaywrightMcpClient → McpClientOptions.mode → resolveLaunchArgs → managed MCP subprocess
 *
 * There is NO alternate launch seam here: no subclass, no overridden `buildLaunchArgs`, no
 * hand-built argv, no second mode toggle. Mode is set EXCLUSIVELY via `McpClientOptions.mode`
 * and the production `resolveLaunchArgs` decides the `--headless` flag. The headed-without-
 * display refusal is the production client's (D36) — captures never silently fall back.
 *
 * It is mode-AGNOSTIC capture plumbing: the only per-capture variable is the requested
 * `BrowserMode`; everything else (engine, isolation, viewport, snapshot/output mode) is the
 * production default. Snapshots are taken through the production `snapshot()` and scrubbed
 * through the production redaction path, so the parity input is the production canonical YAML.
 *
 * Imports are limited to the production browser/snapshot/redaction surface plus the FROZEN
 * Task 4 comparator — no decider, verifier, summarizer, or LLM client is reachable from here.
 */

import * as fs from "node:fs";

import {
  McpClientOptions,
  PlaywrightMcpClient,
} from "../../src/mcp/client";
import { digestSnapshot } from "../../src/mcp/snapshot";
import { redactValuesInText } from "../../src/run/redaction";
import type { BrowserMode } from "../../src/run/schema";
import type { Viewport } from "../../src/flow-plan";
import {
  compareSnapshotYaml,
  type SnapshotParityResult,
} from "../../src/parity/snapshot-parity";

/** Builds a client for a given config. Default = the ordinary production client. */
export type McpClientFactory = (opts: McpClientOptions) => PlaywrightMcpClient;

/** The production launcher. The default factory; tests may inject a spy to assert opts. */
export const productionClientFactory: McpClientFactory = (opts) =>
  new PlaywrightMcpClient(opts);

/**
 * Production scrub→digest, mirroring `RunLogger.recordSnapshot` exactly: redact FIRST, then
 * digest the scrubbed bytes (stored bytes and digest agree). Reuses the production redactor
 * and digest — no alternate implementation.
 */
export function scrubAndDigest(
  rawYaml: string,
  sensitiveValues: readonly string[] = [],
): { scrubbedYaml: string; digest: string } {
  const scrubbedYaml = redactValuesInText(rawYaml, sensitiveValues);
  return { scrubbedYaml, digest: digestSnapshot(scrubbedYaml) };
}

export interface CheckpointCapture {
  captureId: string;
  mode: BrowserMode;
  route: string;
  url: string;
  pageUrl?: string;
  pageTitle?: string;
  refCount: number;
  /** Production-scrubbed canonical YAML — the parity input. */
  scrubbedYaml: string;
  /** sha256 of `scrubbedYaml` (production digest). */
  digest: string;
}

export interface CaptureParams {
  captureId: string;
  mode: BrowserMode;
  baseUrl: string;
  route: string;
  /** A fresh, empty dir — guarantees an isolated in-memory browser profile per capture. */
  outputDir: string;
  viewport?: Viewport;
  /** Auth-free checkpoints type nothing, so this is [] — still routed through redaction. */
  sensitiveValues?: readonly string[];
}

/** The exact production `McpClientOptions` for a capture: mode is the ONLY per-mode variable. */
export function captureClientOptions(p: CaptureParams): McpClientOptions {
  return { viewport: p.viewport ?? "desktop", outputDir: p.outputDir, mode: p.mode };
}

function joinUrl(baseUrl: string, route: string): string {
  return baseUrl.replace(/\/+$/, "") + "/" + route.replace(/^\/+/, "");
}

/**
 * Capture one auth-free checkpoint in the requested mode through the production client.
 * One fresh isolated subprocess per call. Mode is passed only via `McpClientOptions.mode`.
 */
export async function captureCheckpoint(
  p: CaptureParams,
  factory: McpClientFactory = productionClientFactory,
): Promise<CheckpointCapture> {
  fs.mkdirSync(p.outputDir, { recursive: true });
  const url = joinUrl(p.baseUrl, p.route);
  const client = factory(captureClientOptions(p));
  try {
    await client.launch(); // production launch → resolveLaunchArgs(mode); headed-without-display fails loudly
    await client.navigate(url);
    const parsed = await client.snapshot(); // production parseSnapshot
    const { scrubbedYaml, digest } = scrubAndDigest(parsed.yaml, p.sensitiveValues ?? []);
    return {
      captureId: p.captureId,
      mode: p.mode,
      route: p.route,
      url,
      ...(parsed.pageUrl !== undefined ? { pageUrl: parsed.pageUrl } : {}),
      ...(parsed.pageTitle !== undefined ? { pageTitle: parsed.pageTitle } : {}),
      refCount: parsed.refs.size,
      scrubbedYaml,
      digest,
    };
  } finally {
    await client.close();
  }
}

// --- parity over a headed/headless pair (FROZEN Task 4 comparator only) -----------------

export interface CheckpointParityOutcome {
  route: string;
  headedId: string;
  headlessId: string;
  headedDigest: string;
  headlessDigest: string;
  /** Exact byte-equality of the scrubbed canonical YAML. */
  byteEqual: boolean;
  /** Equality of the production digests. */
  digestEqual: boolean;
  /** The frozen comparator's structured result (closed allow-list + raw-source fallback). */
  result: SnapshotParityResult;
}

/** Raised when a checkpoint pair is not equivalent. Carries the structured diff. */
export class CheckpointParityError extends Error {
  constructor(public readonly outcome: CheckpointParityOutcome) {
    super(
      `checkpoint ${outcome.route} parity FAILED: equal=${outcome.result.equal} ` +
        `diffs=${outcome.result.differences.length} byteEqual=${outcome.byteEqual} ` +
        `digestEqual=${outcome.digestEqual}`,
    );
    this.name = "CheckpointParityError";
  }
}

/**
 * Compare a headed/headless pair with the FROZEN Task 4 comparator (`compareSnapshotYaml`,
 * empty allow-list, raw-source fallback). Pure — returns the outcome; does NOT throw, so a
 * caller can report the per-checkpoint result before asserting.
 */
export function checkCheckpointParity(
  headed: CheckpointCapture,
  headless: CheckpointCapture,
): CheckpointParityOutcome {
  const result = compareSnapshotYaml(headed.scrubbedYaml, headless.scrubbedYaml, {
    left: "headed",
    right: "headless",
  });
  return {
    route: headed.route,
    headedId: headed.captureId,
    headlessId: headless.captureId,
    headedDigest: headed.digest,
    headlessDigest: headless.digest,
    byteEqual: headed.scrubbedYaml === headless.scrubbedYaml,
    digestEqual: headed.digest === headless.digest,
    result,
  };
}

/** Throw `CheckpointParityError` (preserving the diff) unless the pair is fully equivalent.
 *  A mismatch is NEVER converted into success. */
export function assertCheckpointParity(outcome: CheckpointParityOutcome): void {
  if (
    !outcome.result.equal ||
    outcome.result.differences.length > 0 ||
    !outcome.byteEqual ||
    !outcome.digestEqual
  ) {
    throw new CheckpointParityError(outcome);
  }
}
