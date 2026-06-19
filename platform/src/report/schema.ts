/**
 * The Phase 4 report contract (D26). A `RunReport` is a stable, versioned, machine-readable
 * PROJECTION of three already-frozen artifacts — the run manifest (Phase 2), the parsed
 * FlowPlan (Phase 1), and ONE explicitly selected evaluation record (Phase 3). It is
 * versioned with its OWN `reportSchemaVersion`, independent of those upstream schemas.
 *
 * The report invents NO verdict, score, or comparison. It re-states what the verifier
 * already recorded (every per-criterion verdict, every observation, every harness-computed
 * citation validation) and separates executor metrics from verifier metrics (D31). The
 * deterministic report — everything except the optional, additive `aiSummary` (D26) — must
 * serialize with stable key ordering and be byte-identical across repeated generations: it
 * carries no timestamp of its own and no non-deterministic field.
 */

import type {
  CitationValidation,
  InconclusiveDetail,
  Observation,
  Verdict,
} from "../verify/evaluation";

export const REPORT_SCHEMA_VERSION = "1.0";

/** The optional, additive AI prose section (D26). Task 1 never populates it. */
export interface AiSummary {
  text: string;
  model: string;
  params: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd: number;
  latencyMs: number;
  generatedAt: string;
}

/**
 * One criterion as projected into the report: the verifier's recorded verdict and evidence,
 * joined to the criterion's natural-language text from the FlowPlan (by `criterionId`).
 * Observations and their citation validations are preserved 1:1 exactly as recorded — never
 * re-derived, never truncated; verdicts and the citation booleans are unchanged. Only the
 * human-readable strings (text, reasoning, labels, observed/normalized values, reasons) are
 * secret-masked at the reporting boundary (D29).
 */
export interface ReportCriterion {
  criterionId: string;
  /** 1-based position from the FlowPlan. */
  ordinal: number;
  /** Criterion text joined from the FlowPlan by `criterionId` — verbatim except for deterministic secret redaction. */
  text: string;
  /** Step id this criterion is evaluated after; absent => terminal. From the FlowPlan. */
  after?: string;
  verdict: Verdict;
  /** Present iff `verdict === "INCONCLUSIVE"`. */
  inconclusiveDetail?: InconclusiveDetail;
  reasoning: string;
  observations: Observation[];
  /** 1:1 with `observations` (asserted at build time). */
  citationValidations: CitationValidation[];
  evidence: {
    snapshotIds: string[];
    eventRefs?: { seq: number; type: string }[];
  };
}

/**
 * One timeline row, built from `events.jsonl`. Only the event types relevant to a human
 * reading "what happened" are projected (step boundaries, actions, errors, terminal status).
 * Each field is rendered ONLY when recorded — no missing action value is invented. Step text
 * is joined back from the FlowPlan by `stepId`; an LLM rationale is never used as step text.
 */
export interface ReportTimelineEntry {
  seq: number;
  type: "step_start" | "step_end" | "action" | "error" | "flow_end";
  stepId?: string;
  /** Joined from the FlowPlan by `stepId` (step_start / step_end / action). */
  stepText?: string;
  /** step_start only. */
  ordinal?: number;
  /** action only. */
  action?: string;
  ref?: string;
  status?: string;
  /** action only: joined from the resolved snapshot event by `snapshotId` (recorded, not invented). */
  pageUrl?: string;
  /** action only (run-log 1.1): scrubbed failed-action evidence, when present. */
  failureDetail?: string;
  failureDetailTruncated?: boolean;
  /** error only. */
  code?: string;
  detail?: string;
  /** flow_end only: the terminal execution status (distinct from any verdict). */
  executionStatus?: string;
}

export interface RunReport {
  reportSchemaVersion: "1.0";

  source: {
    runId: string;
    evaluationId: string;
    runLogSchemaVersion: string;
    evaluationRecordSchemaVersion: string;
    flowPlanSchemaVersion: string;
    planHash: string;
  };

  flow: {
    id: string;
    name: string;
    description?: string;
    entry: string;
    viewport: "desktop" | "mobile";
    steps: Array<{
      id: string;
      ordinal: number;
      text: string;
    }>;
    criteria: Array<{
      id: string;
      ordinal: number;
      text: string;
      after?: string;
    }>;
  };

  execution: {
    status: string;
    model?: string;
    actionCount: number;
    errorCount: number;
    retryCount: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd: number;
    latencyMs: number;
  };

  verification: {
    flowVerdict: Verdict;
    model: string;
    params: Record<string, unknown>;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    criteria: ReportCriterion[];
  };

  timeline: ReportTimelineEntry[];

  aiSummary?: AiSummary;
}
