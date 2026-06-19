/**
 * INVESTIGATION-ONLY / TEST-ONLY launcher and capture harness for Phase 5 Task 2
 * (mode-delta characterization). NOT PRODUCTION CODE and NOT wired into the CLI, the
 * run path, the run-log schema, or the manifest.
 *
 * Its sole job: drive the pinned @playwright/mcp server in BOTH browser modes
 *   - headed   = the production argv, unchanged (no --headless)
 *   - headless = the production argv plus exactly one trailing `--headless`
 * and capture the scrubbed canonical accessibility snapshot at a checkpoint, so the
 * raw cross-mode differences can be observed BEFORE any normalizer exists (Task 4).
 *
 * It controls ONLY browser mode. Everything else is the production path, reused
 * verbatim and never re-implemented:
 *   - MCP init / lifecycle / navigation / snapshot capture  → inherited from
 *     PlaywrightMcpClient (this class overrides only `buildLaunchArgs`)
 *   - snapshot parsing                                       → PlaywrightMcpClient.snapshot()
 *                                                              (→ production parseSnapshot)
 *   - run-scoped redaction                                  → redactValuesInText (production)
 *   - canonical digest                                      → digestSnapshot (production)
 *
 * There is deliberately NO alternate parser, serializer, redactor, or digest here.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  McpClientOptions,
  PlaywrightMcpClient,
  buildServerArgs,
} from "../../src/mcp/client";
import { digestSnapshot } from "../../src/mcp/snapshot";
import { redactValuesInText } from "../../src/run/redaction";
import type { Viewport } from "../../src/flow-plan";

export type BrowserMode = "headed" | "headless";

/** The single flag this investigation toggles. */
export const HEADLESS_FLAG = "--headless";

export interface InvestigationOptions extends McpClientOptions {
  mode: BrowserMode;
}

/**
 * A PlaywrightMcpClient that differs from production in exactly one way: when `mode`
 * is "headless" it appends one `--headless` to the otherwise-identical production
 * argv. `headed` is byte-identical to production (which is headed-by-default because
 * @playwright/mcp is headed by default and the production launcher passes no mode flag).
 */
export class InvestigationMcpClient extends PlaywrightMcpClient {
  private readonly investigationMode: BrowserMode;
  private readonly investigationOpts: McpClientOptions;

  constructor(opts: InvestigationOptions) {
    super({ viewport: opts.viewport, outputDir: opts.outputDir });
    this.investigationMode = opts.mode;
    this.investigationOpts = { viewport: opts.viewport, outputDir: opts.outputDir };
  }

  /** Override the production launch seam: headed = production args; headless = +1 flag. */
  protected buildLaunchArgs(): string[] {
    const base = buildServerArgs(this.investigationOpts);
    return this.investigationMode === "headless" ? [...base, HEADLESS_FLAG] : [...base];
  }

  /** Test accessor: the exact argv this client would launch with (no browser spawned). */
  get launchArgsForInspection(): string[] {
    return this.buildLaunchArgs();
  }
}

/**
 * Production-path scrub→digest, factored so a non-browser test can assert it reuses the
 * production redactor + digest. Mirrors RunLogger.recordSnapshot's order exactly:
 * redact FIRST, then digest the scrubbed bytes (so stored bytes and digest agree).
 */
export function scrubAndDigest(
  rawYaml: string,
  sensitiveValues: readonly string[] = [],
): { scrubbedYaml: string; digest: string } {
  const scrubbedYaml = redactValuesInText(rawYaml, sensitiveValues);
  return { scrubbedYaml, digest: digestSnapshot(scrubbedYaml) };
}

export interface Capture {
  captureId: string;
  mode: BrowserMode;
  route: string;
  url: string;
  pageUrl?: string;
  pageTitle?: string;
  refCount: number;
  /** Production-scrubbed canonical YAML (the comparison surface). */
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
  /** Clean auth-free checkpoints type nothing, so this is [] — still routed through redaction. */
  sensitiveValues?: readonly string[];
}

function joinUrl(baseUrl: string, route: string): string {
  return baseUrl.replace(/\/+$/, "") + "/" + route.replace(/^\/+/, "");
}

/**
 * Launch a fresh isolated browser in the given mode, navigate to one auth-free
 * checkpoint, capture the snapshot through the production client, and return the
 * production-scrubbed canonical YAML + digest. One subprocess per call (isolated).
 */
export async function captureCheckpoint(params: CaptureParams): Promise<Capture> {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const url = joinUrl(params.baseUrl, params.route);
  const client = new InvestigationMcpClient({
    viewport: params.viewport ?? "desktop",
    outputDir: params.outputDir,
    mode: params.mode,
  });
  try {
    await client.launch();
    await client.navigate(url);
    const parsed = await client.snapshot(); // production parseSnapshot under the hood
    const { scrubbedYaml, digest } = scrubAndDigest(
      parsed.yaml,
      params.sensitiveValues ?? [],
    );
    return {
      captureId: params.captureId,
      mode: params.mode,
      route: params.route,
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

export interface LineDiff {
  /** 1-based line position (positional alignment). */
  line: number;
  a?: string;
  b?: string;
}

export interface CaptureComparison {
  aId: string;
  bId: string;
  byteIdentical: boolean;
  digestMatch: boolean;
  lineCount: { a: number; b: number };
  /** Empty when byte-identical. Positional line differences otherwise. */
  differences: LineDiff[];
}

/**
 * Raw, NON-normalizing comparison of two scrubbed snapshots. Positional line alignment
 * (transparent; no LCS, no field stripping) — this is evidence collection for Task 4,
 * NOT the parity normalizer. Reports byte-identity, digest-identity, and every differing
 * line with its number and both values.
 */
export function compareCaptures(a: Capture, b: Capture): CaptureComparison {
  const byteIdentical = a.scrubbedYaml === b.scrubbedYaml;
  const digestMatch = a.digest === b.digest;
  const aLines = a.scrubbedYaml.split(/\r?\n/);
  const bLines = b.scrubbedYaml.split(/\r?\n/);
  const differences: LineDiff[] = [];
  if (!byteIdentical) {
    const n = Math.max(aLines.length, bLines.length);
    for (let i = 0; i < n; i++) {
      if (aLines[i] !== bLines[i]) {
        differences.push({
          line: i + 1,
          ...(aLines[i] !== undefined ? { a: aLines[i] } : {}),
          ...(bLines[i] !== undefined ? { b: bLines[i] } : {}),
        });
      }
    }
  }
  return {
    aId: a.captureId,
    bId: b.captureId,
    byteIdentical,
    digestMatch,
    lineCount: { a: aLines.length, b: bLines.length },
    differences,
  };
}

/** Persist a capture's raw scrubbed YAML next to a machine-readable record, for review. */
export function writeCaptureEvidence(dir: string, capture: Capture): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${capture.captureId}.snapshot.yaml`);
  fs.writeFileSync(file, capture.scrubbedYaml, "utf8");
  return file;
}
