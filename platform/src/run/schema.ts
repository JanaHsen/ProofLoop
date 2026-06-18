/**
 * The frozen Phase 2 run-log schema (Task 4). Versioned with its OWN
 * `runLogSchemaVersion`, independent of `FlowPlan.schemaVersion` (decision #1). The
 * run log is an EXECUTION artifact — no `outcome`/verdict appears anywhere (that is
 * Phase 3). The snapshot→ref→action audit chain here is what makes the Exit criterion
 * independently re-verifiable from the logs (see run/audit.ts).
 */

import { createHash } from "node:crypto";
import type { FlowPlan } from "../flow-plan";
import { serializeFlowPlan } from "../parser";
import type { RawUsage } from "./pricing";
import type { RedactedValue } from "./redaction";

/**
 * The CURRENT run-log schema version the writer emits. Bumped to "1.1" for the D25
 * additive change: `ActionEvent` gains optional `failureDetail` / `failureDetailTruncated`
 * (failed-action evidence). The change is purely additive — the new fields are optional
 * and absent on every "1.0" shape, so "1.0" records still parse.
 *
 * Readers must check MEMBERSHIP in `SUPPORTED_RUN_LOG_SCHEMA_VERSIONS` — not pin the
 * single current version (that would refuse still-readable older logs) and not accept
 * arbitrary versions (that would silently mis-read a future shape).
 */
export const RUN_LOG_SCHEMA_VERSION = "1.1";

/**
 * Every run-log schema version this codebase can READ. The writer emits the latest
 * (`RUN_LOG_SCHEMA_VERSION`); readers accept any member and reject the rest.
 */
export const SUPPORTED_RUN_LOG_SCHEMA_VERSIONS = ["1.0", "1.1"] as const;
export type SupportedRunLogSchemaVersion =
  (typeof SUPPORTED_RUN_LOG_SCHEMA_VERSIONS)[number];

/** Thrown by readers when a stored artifact declares a version outside the supported set. */
export class UnsupportedRunLogSchemaError extends Error {
  constructor(public readonly version: unknown) {
    super(
      `unsupported runLogSchemaVersion ${JSON.stringify(version)} (supported: ${SUPPORTED_RUN_LOG_SCHEMA_VERSIONS.join(", ")})`,
    );
    this.name = "UnsupportedRunLogSchemaError";
  }
}

export function isSupportedRunLogSchemaVersion(
  v: unknown,
): v is SupportedRunLogSchemaVersion {
  return (
    typeof v === "string" &&
    (SUPPORTED_RUN_LOG_SCHEMA_VERSIONS as readonly string[]).includes(v)
  );
}

/** Assert a declared version is one we can read; throws `UnsupportedRunLogSchemaError` otherwise. */
export function assertSupportedRunLogSchemaVersion(v: unknown): void {
  if (!isSupportedRunLogSchemaVersion(v)) throw new UnsupportedRunLogSchemaError(v);
}

/** `sha256:<hex>` of the canonical serialized plan — ties a run to the exact plan executed (decision #2). */
export function computePlanHash(plan: FlowPlan): string {
  return (
    "sha256:" +
    createHash("sha256").update(serializeFlowPlan(plan), "utf8").digest("hex")
  );
}

/** `sha256:<hex>` of verbatim step text — logged instead of the text (may carry secrets). */
export function hashStepText(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Live runs only ever write `running → { completed | blocked | guard_tripped | error
 * | cancelled }`. `crashed` is NEVER self-written — a reader/recovery tool infers it
 * when a process died with status still `running` (see run/audit.ts).
 */
export type ExecutionStatus =
  | "running"
  | "completed"
  | "blocked"
  | "guard_tripped"
  | "error"
  | "cancelled"
  | "crashed";

export interface RunTotals {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  snapshotCount: number;
  actionCount: number;
  errorCount: number;
  retryCount: number;
}

export interface RunManifest {
  runLogSchemaVersion: string;
  runId: string;
  flowId: string;
  planHash: string;
  /** Decider model id (env-configurable; a Phase 7 cost variable). */
  model: string;
  mode: "headed";
  startedAt: string;
  finishedAt?: string;
  executionStatus: ExecutionStatus;
  pricingConfigId: string;
  totals: RunTotals;
}

export type RunEventType =
  | "flow_start"
  | "flow_end"
  | "step_start"
  | "step_end"
  | "snapshot"
  | "llm_decision"
  | "action"
  | "error"
  | "retry"
  | "screenshot"
  | "guard_tripped"
  | "session_continuity";

export interface BaseRunEvent {
  runLogSchemaVersion: string;
  runId: string;
  /** Harness-assigned, strictly increasing, single writer. */
  seq: number;
  ts: string;
  type: RunEventType;
  stepId?: string;
}

/** A typed value that may have been redacted before logging. */
export type LoggedValue = string | RedactedValue;

export type LoggedDecision =
  | {
      kind: "action";
      action: "click" | "type";
      ref: string;
      value?: LoggedValue;
      rationale: string;
    }
  | { kind: "step_complete"; rationale: string }
  | { kind: "blocked"; reason: string };

export type SnapshotKind = "pre_action" | "step_boundary" | "terminal";

export interface FlowStartEvent extends BaseRunEvent {
  type: "flow_start";
  flowId: string;
  planHash: string;
  model: string;
  entryUrl: string;
}

export interface FlowEndEvent extends BaseRunEvent {
  type: "flow_end";
  executionStatus: ExecutionStatus;
}

export interface StepStartEvent extends BaseRunEvent {
  type: "step_start";
  stepId: string;
  ordinal: number;
  /**
   * sha256 of the verbatim step text — the run log does NOT store the instruction
   * text itself (it can carry secret literals, e.g. a password). Exact wording stays
   * recoverable from the FlowPlan via planHash + stepId.
   */
  stepTextHash: string;
}

export interface StepEndEvent extends BaseRunEvent {
  type: "step_end";
  stepId: string;
}

export interface SnapshotEvent extends BaseRunEvent {
  type: "snapshot";
  snapshotId: string;
  /** Digest of the STORED (post-redaction) snapshot blob. */
  snapshotDigest: string;
  /** Path to the blob, relative to the run directory. */
  path: string;
  kind: SnapshotKind;
  refCount: number;
  pageUrl?: string;
  pageTitle?: string;
}

export interface LlmDecisionEvent extends BaseRunEvent {
  type: "llm_decision";
  decisionId: string;
  snapshotId: string;
  snapshotDigest: string;
  decision: LoggedDecision;
  /** Raw API usage, verbatim (incl. cache fields, even when zero). */
  usage: RawUsage;
  costUsd: number;
  latencyMs: number;
  /** True if this decision was the single bounded correction attempt. */
  correction?: boolean;
}

export interface RefValidationRecord {
  valid: boolean;
  /** Always "harness" — never read from the model. */
  validatedBy: "harness";
  reason?: string;
}

export interface ActionEvent extends BaseRunEvent {
  type: "action";
  decisionId: string;
  snapshotId: string;
  snapshotDigest: string;
  ref: string;
  action: "click" | "type";
  value?: LoggedValue;
  refValidation: RefValidationRecord;
  /** snapshotId the ref was resolved from — equals snapshotId for a valid action. */
  resolvedFrom: string;
  status: "executed" | "rejected" | "failed";
  isError?: boolean;
  /**
   * (run-log 1.1, D25) Failed-action evidence: `ToolResult.text` when `isError === true`,
   * SCRUBBED first (run-scoped redaction) then truncated from the END to
   * `FAILURE_DETAIL_MAX_LEN` (the leading Playwright actionability diagnostic is preserved).
   * Populated ONLY on an `isError` action; absent on successful and rejected actions.
   * Pure evidence capture — carries no verdict logic.
   */
  failureDetail?: string;
  /** (run-log 1.1, D25) True iff `failureDetail` was clipped to the bound; absent otherwise. */
  failureDetailTruncated?: boolean;
}

/**
 * (run-log 1.1, D25) Length bound for `ActionEvent.failureDetail`. The already-scrubbed
 * detail is truncated to this many characters FROM THE END, keeping the leading
 * actionability reason while bounding log growth. A few hundred chars is enough to retain
 * the diagnostic Playwright puts first.
 */
export const FAILURE_DETAIL_MAX_LEN = 500;

export interface ErrorEvent extends BaseRunEvent {
  type: "error";
  /** Stable code, e.g. INVALID_SNAPSHOT_REF. */
  code: string;
  detail: string;
  decisionId?: string;
}

export interface RetryEvent extends BaseRunEvent {
  type: "retry";
  ofDecisionId?: string;
  reason: string;
}

export interface ScreenshotEvent extends BaseRunEvent {
  type: "screenshot";
  screenshotId: string;
  path: string;
  digest: string;
}

export interface GuardTrippedEvent extends BaseRunEvent {
  type: "guard_tripped";
  reason: string;
  detail: string;
}

export interface SessionContinuityEvent extends BaseRunEvent {
  type: "session_continuity";
  isolated: boolean;
  detail: string;
  /** Substantive cross-flow / auth-continuity fields are populated at Task 6. */
  authenticatedContinuity?: boolean;
  crossFlowLeak?: boolean;
}

export type RunEvent =
  | FlowStartEvent
  | FlowEndEvent
  | StepStartEvent
  | StepEndEvent
  | SnapshotEvent
  | LlmDecisionEvent
  | ActionEvent
  | ErrorEvent
  | RetryEvent
  | ScreenshotEvent
  | GuardTrippedEvent
  | SessionContinuityEvent;

type DistributiveOmit<T, K extends keyof RunEvent> = T extends unknown
  ? Omit<T, K>
  : never;

/** What a caller supplies to the writer; the writer stamps the rest. */
export type RunEventInput = DistributiveOmit<
  RunEvent,
  "runLogSchemaVersion" | "runId" | "seq" | "ts"
>;

/** The persisted shape of a stored snapshot blob (snapshots/<snapshotId>.json). */
export interface StoredSnapshot {
  snapshotId: string;
  digest: string;
  yaml: string;
  refs: string[];
  elements: { ref: string; role: string; name?: string }[];
  pageUrl?: string;
  pageTitle?: string;
}
