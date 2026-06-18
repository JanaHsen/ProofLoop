/**
 * RunLogger — the append-only, single-writer logging spine (Task 4). It owns the run
 * directory, the strictly-increasing `seq`, durable JSONL appends, snapshot-blob
 * storage (redacted, then digested), and atomic manifest finalize. One instance per
 * run is the single event writer, which is what makes `seq` monotonic and the stream
 * recoverable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ParsedSnapshot } from "../mcp/snapshot";
import { digestSnapshot } from "../mcp/snapshot";
import { redactValuesInText } from "./redaction";
import {
  RUN_LOG_SCHEMA_VERSION,
  RunEvent,
  RunEventInput,
  RunManifest,
  RunTotals,
  SnapshotKind,
  StoredSnapshot,
  ExecutionStatus,
} from "./schema";

export interface RunLoggerOptions {
  /** The runs root, e.g. platform/runs. */
  runsRoot: string;
  runId: string;
  flowId: string;
  planHash: string;
  model: string;
  pricingConfigId: string;
  /** Injectable clock (defaults to wall clock) so tests are deterministic. */
  now?: () => Date;
}

export class RunLogger {
  private readonly opts: RunLoggerOptions;
  private readonly now: () => Date;
  readonly runDir: string;
  private readonly eventsPath: string;
  private readonly manifestPath: string;
  private readonly snapshotsDir: string;
  private readonly screenshotsDir: string;

  private seqCounter = 0;
  private snapshotSeq = 0;
  private finished = false;
  private readonly totals: RunTotals = {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    snapshotCount: 0,
    actionCount: 0,
    errorCount: 0,
    retryCount: 0,
  };
  private readonly startedAt: string;

  constructor(opts: RunLoggerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.runDir = path.join(opts.runsRoot, opts.runId);
    this.eventsPath = path.join(this.runDir, "events.jsonl");
    this.manifestPath = path.join(this.runDir, "run.json");
    this.snapshotsDir = path.join(this.runDir, "snapshots");
    this.screenshotsDir = path.join(this.runDir, "screenshots");

    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    this.startedAt = this.now().toISOString();
    this.writeManifest("running");
  }

  /** Append one complete event line; stamps version/runId/seq/ts. Durable per call. */
  append(input: RunEventInput): RunEvent {
    if (this.finished) throw new Error("RunLogger is finalized; no more events");
    const event = {
      runLogSchemaVersion: RUN_LOG_SCHEMA_VERSION,
      runId: this.opts.runId,
      seq: ++this.seqCounter,
      ts: this.now().toISOString(),
      ...input,
    } as RunEvent;
    // appendFileSync opens+writes+closes per call: each line is flushed complete to
    // disk, so a crash can at worst truncate the final line (readers tolerate that).
    fs.appendFileSync(this.eventsPath, JSON.stringify(event) + "\n", "utf8");
    this.accrue(event);
    return event;
  }

  private accrue(event: RunEvent): void {
    switch (event.type) {
      case "snapshot":
        this.totals.snapshotCount += 1;
        break;
      case "action":
        this.totals.actionCount += 1;
        break;
      case "error":
        this.totals.errorCount += 1;
        break;
      case "retry":
        this.totals.retryCount += 1;
        break;
      case "llm_decision":
        this.totals.promptTokens += num(event.usage.input_tokens);
        this.totals.completionTokens += num(event.usage.output_tokens);
        this.totals.costUsd += event.costUsd;
        this.totals.latencyMs += event.latencyMs;
        break;
      default:
        break;
    }
  }

  /**
   * Store a snapshot blob (redacting any known sensitive values FIRST so the stored
   * bytes and the audit-chain digest agree), emit the `snapshot` event, and return
   * the ids the loop threads into the decision/action records.
   */
  recordSnapshot(
    snapshot: ParsedSnapshot,
    kind: SnapshotKind,
    sensitiveValues: readonly string[] = [],
    stepId?: string,
  ): { snapshotId: string; digest: string; path: string } {
    const snapshotId = `snapshot-${pad(++this.snapshotSeq)}`;
    const yaml = redactValuesInText(snapshot.yaml, sensitiveValues);
    const digest = digestSnapshot(yaml);
    const blob: StoredSnapshot = {
      snapshotId,
      digest,
      yaml,
      refs: [...snapshot.refs],
      elements: snapshot.elements.map((e) => ({
        ref: e.ref,
        role: e.role,
        ...(e.name !== undefined ? { name: e.name } : {}),
      })),
      ...(snapshot.pageUrl !== undefined ? { pageUrl: snapshot.pageUrl } : {}),
      ...(snapshot.pageTitle !== undefined ? { pageTitle: snapshot.pageTitle } : {}),
    };
    const rel = path.posix.join("snapshots", `${snapshotId}.json`);
    fs.writeFileSync(
      path.join(this.runDir, "snapshots", `${snapshotId}.json`),
      JSON.stringify(blob, null, 2),
      "utf8",
    );
    this.append({
      type: "snapshot",
      snapshotId,
      snapshotDigest: digest,
      path: rel,
      kind,
      refCount: snapshot.refs.size,
      ...(snapshot.pageUrl !== undefined ? { pageUrl: snapshot.pageUrl } : {}),
      ...(snapshot.pageTitle !== undefined ? { pageTitle: snapshot.pageTitle } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    });
    return { snapshotId, digest, path: rel };
  }

  /** Add token/cost/latency totals not derived from a single event (rare; mostly auto-accrued). */
  addTotals(partial: Partial<RunTotals>): void {
    for (const k of Object.keys(partial) as (keyof RunTotals)[]) {
      this.totals[k] += partial[k] ?? 0;
    }
  }

  currentTotals(): RunTotals {
    return { ...this.totals };
  }

  /** Atomically finalize the manifest with the terminal status. */
  finalize(status: Exclude<ExecutionStatus, "running" | "crashed">): RunManifest {
    const manifest = this.writeManifest(status, this.now().toISOString());
    this.finished = true;
    return manifest;
  }

  private writeManifest(
    executionStatus: ExecutionStatus,
    finishedAt?: string,
  ): RunManifest {
    const manifest: RunManifest = {
      runLogSchemaVersion: RUN_LOG_SCHEMA_VERSION,
      runId: this.opts.runId,
      flowId: this.opts.flowId,
      planHash: this.opts.planHash,
      model: this.opts.model,
      mode: "headed",
      startedAt: this.startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      executionStatus,
      pricingConfigId: this.opts.pricingConfigId,
      totals: { ...this.totals },
    };
    // atomic: write temp, then rename over run.json
    const tmp = this.manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.manifestPath);
    return manifest;
  }
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}
