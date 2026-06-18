/**
 * The frozen Phase 3 evaluation-record schema + verdict model (Task 1, D23/D24).
 *
 * This is a SEPARATE, independently versioned artifact from the Phase 2 run log: it
 * carries its OWN `evaluationRecordSchemaVersion`, and it imports NOTHING from
 * `flow-plan` or `run/schema` (decision: the evaluation record must not be coupled to
 * the execution-log shape or the parser's FlowPlan shape — they version on their own
 * cadences). It joins back to those artifacts only by value: `criterionId` into
 * `FlowPlan.criteria`, `runId`/`planHash`/`snapshotId`/`ref` into the run log.
 *
 * What lives here is the CONTRACT only: the verdict space (D11/D23), the
 * `InconclusiveDetail` union with its enumerated code→origin table, the per-criterion
 * and per-record shapes (D24), and the deterministic flow-verdict aggregation rule.
 * The resolver (Task 3), verifier (Task 4), and writer (Task 5) all target this shape.
 * NO LLM call, NO evidence resolution, and NO citation computation live in this file —
 * those are later tasks. This file is pure types + one pure function.
 */

export const EVALUATION_RECORD_SCHEMA_VERSION = "1.0";

/** The three-outcome verdict space (D11). `INCONCLUSIVE` is first-class, not a soft FAIL. */
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** Where an `INCONCLUSIVE / ERROR` originated — the two halves of the platform. */
export type ErrorOrigin = "EXECUTION" | "VERIFICATION";

/**
 * The enumerated INCONCLUSIVE error codes, each bound to its origin — the code→origin
 * table (D23). This single declaration is the source of truth: the `InconclusiveDetail`
 * ERROR variant below derives its code/origin pairing from it (`as const satisfies`),
 * so a code can never be paired with the wrong origin in a typed construction.
 *
 *   EXECUTION    — the run could not yield gradeable evidence (a Phase 2 / infra fact).
 *   VERIFICATION — the verifier step itself could not be trusted (a Phase 3 fact).
 */
export const INCONCLUSIVE_ERROR_CODES = {
  /** The flow terminated before the pinned step ran — no evidence to grade (D21). */
  COULD_NOT_EXECUTE: "EXECUTION",
  /** A step completed but its best-effort `step_boundary` snapshot was not captured (D21). */
  MISSING_BOUNDARY_SNAPSHOT: "EXECUTION",
  /** An MCP/browser transport failure sat in the evidence window — infra, not the app. */
  MCP_TRANSPORT_ERROR: "EXECUTION",
  /** The verifier model returned a response that failed schema validation (D22). */
  VERIFIER_SCHEMA_ERROR: "VERIFICATION",
  /** A verdict rested on a citation the stored evidence does not contain (D14/citation guard). */
  INVALID_CITATION: "VERIFICATION",
} as const satisfies Record<string, ErrorOrigin>;

/** Every enumerated INCONCLUSIVE error code. */
export type InconclusiveErrorCode = keyof typeof INCONCLUSIVE_ERROR_CODES;

/** The origin statically bound to a code, e.g. `OriginOf<"INVALID_CITATION">` is `"VERIFICATION"`. */
export type OriginOf<C extends InconclusiveErrorCode> =
  (typeof INCONCLUSIVE_ERROR_CODES)[C];

/** The ERROR variant, with each code paired to exactly its origin (no mismatched pair is constructible). */
type ErrorDetailByCode = {
  [C in InconclusiveErrorCode]: {
    kind: "ERROR";
    origin: OriginOf<C>;
    code: C;
    explanation: string;
  };
};

export type InconclusiveErrorDetail = ErrorDetailByCode[InconclusiveErrorCode];

/**
 * The frozen `INCONCLUSIVE` detail union (D23). Shape is exactly D23's
 * (`kind` / `origin` / `code` / `explanation`); the only refinement is that `code` is
 * the enumerated set and is type-bound to its `origin` via the table above.
 */
export type InconclusiveDetail =
  | { kind: "AMBIGUOUS_EVIDENCE"; explanation: string }
  | InconclusiveErrorDetail;

/**
 * Construct an `INCONCLUSIVE / ERROR` detail, deriving `origin` from the code→origin
 * table so callers (resolver / verifier / writer) cannot pair a code with a wrong origin.
 */
export function errorDetail<C extends InconclusiveErrorCode>(
  code: C,
  explanation: string,
): ErrorDetailByCode[C] {
  // Sound by construction: `origin` is read from the table, so it always matches `code`.
  // The cast is only to satisfy TS's generic mapped-type indexing; the runtime binding
  // is asserted for every code in evaluation.test.ts.
  return {
    kind: "ERROR",
    origin: INCONCLUSIVE_ERROR_CODES[code],
    code,
    explanation,
  } as ErrorDetailByCode[C];
}

/** One thing the verifier claims to have read from the evidence (D22/D24). */
export interface Observation {
  /** The verifier's own name for it, e.g. "Tax" — free text, not validated. */
  label: string;
  /** VERBATIM text read from the cited snapshot at the cited ref (the containment-check target). */
  observedText: string;
  /** Which provided snapshot it was read from. */
  snapshotId: string;
  /** Element ref within that snapshot. */
  ref: string;
  /** OPTIONAL interpreted value (e.g. "0.00") — recorded, NOT structurally validated (D21 forbids meaning-work here). */
  normalizedValue?: string;
}

/**
 * Harness-computed citation check, one per observation (mirrors D14: the harness checks
 * what the verifier claims to have read; it never trusts the claim). Computed by the
 * writer/verifier harness in Task 4 — never accepted from the model.
 */
export interface CitationValidation {
  /** The cited snapshot was in the evidence set handed to the verifier for this criterion. */
  snapshotProvided: boolean;
  /** Recomputed blob digest === the snapshot event's `snapshotDigest`. */
  digestMatches: boolean;
  /** The ref exists in that snapshot's `refs[]`. */
  refPresent: boolean;
  /** `observedText` is contained in the accessible name at that ref. */
  observedTextPresent: boolean;
  /** Conjunction of the above. */
  valid: boolean;
  reason?: string;
}

export interface CriterionEvaluation {
  /** Join key into `FlowPlan.criteria`. */
  criterionId: string;
  verdict: Verdict;
  /** Present iff `verdict === "INCONCLUSIVE"`. */
  inconclusiveDetail?: InconclusiveDetail;
  observations: Observation[];
  /** 1:1 with `observations`, harness-computed. */
  citationValidations: CitationValidation[];
  /** Verifier's justification (scrubbed of run-scoped secrets before writing). */
  reasoning: string;
  /** Exactly what the resolver provided — self-contained so the record is auditable on its own. */
  evidence: {
    snapshotIds: string[];
    eventRefs?: { seq: number; type: string }[];
  };
}

export interface EvaluationTotals {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface EvaluationRecord {
  evaluationRecordSchemaVersion: string;
  /** Harness-assigned ordered pass index, e.g. "eval-001" — never a UUID/timestamp (D24). */
  evaluationId: string;
  runId: string;
  flowId: string;
  /** Asserted === `manifest.planHash` before evaluating (D24): the graded criteria are the executed ones. */
  planHash: string;
  /** Exact verifier model id (separately configurable from the decider; D22). */
  verifierModel: string;
  /** Temperature etc. — recorded verbatim for Phase 8 reliability analysis. */
  verifierParams: Record<string, unknown>;
  /** Reuse the Phase 2 versioned pricing so cost recomputes from raw usage (Phase 7 invariant). */
  pricingConfigId: string;
  startedAt: string;
  finishedAt: string;
  flowVerdict: Verdict;
  criteria: CriterionEvaluation[];
  totals: EvaluationTotals;
}

/**
 * Deterministic flow-verdict aggregation (D23):
 *   any FAIL              ⇒ FAIL  (the regression guard wins, even over INCONCLUSIVE)
 *   else all PASS (≥1)    ⇒ PASS
 *   else                  ⇒ INCONCLUSIVE  (any INCONCLUSIVE-without-FAIL, or no criteria)
 *
 * The empty-set case returns INCONCLUSIVE on purpose: an empty criteria set cannot
 * justify a PASS, and a vacuous PASS would be exactly the false-pass this phase exists
 * to prevent. In practice the parser requires ≥1 criterion (D8), so this is a guard.
 */
export function aggregateVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.length > 0 && verdicts.every((v) => v === "PASS")) return "PASS";
  return "INCONCLUSIVE";
}
