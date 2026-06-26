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
 * The CURRENT run-log schema version the writer emits. Bumped to "1.3" for the D48
 * additive change: the new `navigation` event type (trusted observed-URL navigation) and
 * the additive `navigate_to_observed_url` variant of `LoggedDecision`. Like every prior
 * bump (1.1 = D25 `failureDetail`; 1.2 = D35/D36 mode metadata), the change is purely
 * additive — the new event type simply does not appear in older logs, and the new logged
 * decision variant is absent from every "1.0"/"1.1"/"1.2" record, so older records still
 * parse unchanged. No existing field changed shape or meaning.
 *
 * Readers must check MEMBERSHIP in `SUPPORTED_RUN_LOG_SCHEMA_VERSIONS` — not pin the
 * single current version (that would refuse still-readable older logs) and not accept
 * arbitrary versions (that would silently mis-read a future shape).
 */
export const RUN_LOG_SCHEMA_VERSION = "1.3";

/**
 * Every run-log schema version this codebase can READ. The writer emits the latest
 * (`RUN_LOG_SCHEMA_VERSION`); readers accept any member and reject the rest.
 */
export const SUPPORTED_RUN_LOG_SCHEMA_VERSIONS = ["1.0", "1.1", "1.2", "1.3"] as const;
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

/**
 * Browser execution mode (Phase 5, D32/D36). `headless` is the CI-safe default; `headed`
 * is the local-debug override. The pinned @playwright/mcp server is headed by default and
 * has no `--headed` flag, so headless is produced by adding exactly one `--headless` at the
 * launch seam — the ONLY place mode is allowed to change runtime browser behavior (D32).
 */
export type BrowserMode = "headed" | "headless";

/**
 * Typed browser configuration recorded in the manifest (D36). Deliberately a STRUCTURE of
 * stable, meaningful facts — never a dump of raw subprocess arguments (some carry
 * machine-specific paths and would break determinism / leak the local environment).
 */
export interface BrowserConfig {
  engine: "chromium";
  isolated: true;
  viewport: { width: number; height: number };
  accessibilitySnapshots: true;
  visionEnabled: false;
}

/** Thrown when a 1.2 manifest is missing, malforming, or contradicting its mode metadata. */
export class InvalidRunManifestError extends Error {
  constructor(message: string) {
    super(`invalid run manifest: ${message}`);
    this.name = "InvalidRunManifestError";
  }
}

export function isBrowserMode(v: unknown): v is BrowserMode {
  return v === "headed" || v === "headless";
}

/** True iff `v` is a COMPLETE typed browser config (D36) — every field present and exact. */
export function isBrowserConfig(v: unknown): v is BrowserConfig {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  const vp = b.viewport as Record<string, unknown> | undefined;
  return (
    b.engine === "chromium" &&
    b.isolated === true &&
    b.accessibilitySnapshots === true &&
    b.visionEnabled === false &&
    typeof vp === "object" &&
    vp !== null &&
    typeof vp.width === "number" &&
    typeof vp.height === "number"
  );
}

/**
 * Validate run-log 1.2 mode metadata (D35/D36) at BOTH boundaries — the writer refuses to
 * record an incomplete/contradictory manifest, and a stored 1.2 manifest must carry the
 * full, consistent triplet. Enforces:
 *   - `mode` and `requestedMode` are valid BrowserModes;
 *   - `browser` is a COMPLETE typed config;
 *   - `requestedMode === mode` — D36 forbids a silent fallback, so a divergent pair would
 *     be an internally contradictory artifact and is rejected loudly.
 */
export function assertValidModeMetadata(m: {
  mode?: unknown;
  requestedMode?: unknown;
  browser?: unknown;
}): void {
  if (!isBrowserMode(m.mode)) {
    throw new InvalidRunManifestError(
      `mode must be "headed" | "headless", got ${JSON.stringify(m.mode)}`,
    );
  }
  if (!isBrowserMode(m.requestedMode)) {
    throw new InvalidRunManifestError(
      `requestedMode must be "headed" | "headless", got ${JSON.stringify(m.requestedMode)}`,
    );
  }
  if (!isBrowserConfig(m.browser)) {
    throw new InvalidRunManifestError("browser config is missing or incomplete");
  }
  if (m.requestedMode !== m.mode) {
    throw new InvalidRunManifestError(
      `requestedMode "${m.requestedMode}" must equal effective mode "${m.mode}" — ` +
        "D36 forbids a silent fallback, so the pair can never diverge",
    );
  }
}

export interface RunManifest {
  runLogSchemaVersion: string;
  runId: string;
  flowId: string;
  planHash: string;
  /** Decider model id (env-configurable; a Phase 7 cost variable). */
  model: string;
  /** EFFECTIVE browser mode — what actually ran (D35). Widened from the 1.1 literal "headed". */
  mode: BrowserMode;
  /**
   * (run-log 1.2, D35) REQUESTED browser mode — what the operator asked for. Optional on the
   * READ type so older "1.0"/"1.1" records parse, but a "1.2" manifest MUST carry it and it
   * MUST equal `mode` (D36 has no silent fallback) — enforced by `assertValidModeMetadata`
   * at the write and read boundaries.
   */
  requestedMode?: BrowserMode;
  /**
   * (run-log 1.2, D36) Typed browser config. Optional on the READ type for older records;
   * REQUIRED and complete on every "1.2" manifest (enforced by `assertValidModeMetadata`).
   */
  browser?: BrowserConfig;
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
  | "navigation"
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
  | { kind: "blocked"; reason: string }
  /**
   * (run-log 1.3, D48) The model chose to revisit a URL it OBSERVED earlier in this run.
   * It names the SOURCE snapshot id only — never a URL string. The deterministic executor
   * reads the trusted, same-origin destination from that snapshot's stored `pageUrl`; the
   * navigation itself is audited separately by a `navigation` event.
   */
  | { kind: "navigate_to_observed_url"; snapshotId: string; rationale: string };

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

/**
 * (run-log 1.3, D48) Audit record for one trusted observed-URL navigation. The destination
 * is NEVER a model-supplied URL: it is the stored `pageUrl` of `sourceSnapshotId` — a
 * snapshot captured EARLIER in THIS run — re-validated same-origin against the configured
 * SUT origin. Emitted on every attempt so a rejection (safety contract) or a failure
 * (transport / redirect-escape) is auditable too, not just success.
 *
 * URL fields are SANITIZED for audit (origin + pathname + query-KEY names only; no fragment,
 * credentials, or query values) — the full internal URL is used to drive the browser but never
 * written here. `*UrlDigest` carries a sha256 of the full URL so resolved/final can be
 * correlated without exposing either.
 */
export interface NavigationEvent extends BaseRunEvent {
  type: "navigation";
  decisionId: string;
  /** The historical snapshot (this run) whose stored pageUrl was the trusted destination. */
  sourceSnapshotId: string;
  /** ISO time the navigation was initiated (captured before the browser navigate call). */
  startedAt: string;
  /**
   * The SANITIZED resolved same-origin destination (origin + pathname + redacted query keys).
   * Empty string on a pre-navigation rejection (no trusted URL was resolved).
   */
  resolvedUrl: string;
  /** sha256 of the full resolved destination URL, for correlation. Absent on a rejection. */
  resolvedUrlDigest?: string;
  status: "executed" | "rejected" | "failed";
  /**
   * The fresh post-navigation snapshot id — present ONLY on `status === "executed"`. A
   * cross-origin (or otherwise invalid) final URL is NEVER persisted/indexed, so a `failed`
   * redirect-escape carries no `resultingSnapshotId`.
   */
  resultingSnapshotId?: string;
  /**
   * The SANITIZED final URL after navigation/redirects (same sanitization as `resolvedUrl`).
   * Present on `executed` (confirmed same-origin before the snapshot was persisted) and on a
   * `failed` redirect-escape (the sanitized foreign URL, for the audit trail).
   */
  finalUrl?: string;
  /** sha256 of the full final URL, for correlation. */
  finalUrlDigest?: string;
  /** Why the navigation was rejected (safety contract) or failed (transport/redirect-escape). */
  detail?: string;
}

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
  | NavigationEvent
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
