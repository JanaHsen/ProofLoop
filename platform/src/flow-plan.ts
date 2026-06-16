/**
 * FlowPlan — the structured output of the deterministic *.flow.md parser, and the
 * contract Phase 2's executor consumes / Phases 3-4-7 extend.
 *
 * This is a STATIC plan. It carries metadata, an ordered list of step strings, and
 * a list of criterion strings, with all author English preserved VERBATIM and
 * OPAQUE. The parser never interprets the meaning of a step or criterion (D8).
 */

export type Viewport = "desktop" | "mobile";

export interface FlowStep {
  /** Deterministic, positional, flow-namespaced id, e.g. "checkout:S1". */
  id: string;
  /** 1-based position in the Steps list. */
  ordinal: number;
  /** Verbatim plain English — OPAQUE to Phase 1. */
  text: string;
}

export interface FlowCriterion {
  /** Deterministic, positional, flow-namespaced id, e.g. "checkout:C3". */
  id: string;
  /** 1-based position in the Acceptance Criteria list. */
  ordinal: number;
  /** Verbatim plain-English assertion (minus any stripped suffix) — OPAQUE to Phase 1. */
  text: string;
  /** Step id this criterion is evaluated after; absent => terminal (evaluated at flow end). */
  after?: string;
}

export interface FlowPlan {
  /** Version of THIS static plan schema (not the runtime evaluation record). */
  schemaVersion: string;
  /** From filename: "checkout.flow.md" => "checkout". */
  id: string;
  name: string;
  description?: string;
  /** Relative path appended to BASE_URL; default "/". Never absolute, never a path into app/. */
  entry: string;
  /** "desktop" | "mobile"; default "desktop". Phase 1 only records the label. */
  viewport: Viewport;
  tags: string[];
  /** Length >= 1, enforced. */
  steps: FlowStep[];
  /** Length >= 1, enforced (zero criteria is a hard parse error). */
  criteria: FlowCriterion[];
}

/** Current FlowPlan schema version. Positional ids are NOT promised stable across edits. */
export const FLOW_PLAN_SCHEMA_VERSION = "1.0";

/* ---------------------------------------------------------------------------
 * FORWARD CONTRACT — documented here so later phases inherit it cleanly.
 * BUILD NONE OF THIS IN PHASE 1. These are notes, not behavior.
 * ---------------------------------------------------------------------------
 *
 * Verdict space (Phase 3 verifier / Phase 7 harness):
 *   Each criterion resolves to PASS | FAIL | INCONCLUSIVE. ERROR
 *   (could-not-execute / could-not-interact / could-not-inspect) is recorded as a
 *   *reason under* INCONCLUSIVE — kept distinct from ambiguous-evidence, because an
 *   unreliable platform and an indecisive one are different failure modes.
 *   Flow verdict aggregates: all PASS => PASS; any FAIL => FAIL; otherwise INCONCLUSIVE.
 *
 * Action != outcome (Phase 2 executor):
 *   A step is "performed" once its action completes and a response is observed; a
 *   non-favourable response is a completed step, NOT a step failure. Outcome judgment
 *   lives in criteria, never in step execution. The canonical hard case: "the
 *   place-order control is not actionable at mobile" is a behavior FAIL (the control
 *   *should* be actionable — it is at desktop), not an infra ERROR. The verifier
 *   disambiguates ERROR vs FAIL by asking *was the action supposed to be possible*;
 *   Phase 1 only states the outcome criterion.
 *
 * Evidence join (Phases 3/4/7):
 *   Runtime evidence (status, captured figures, screenshots, trace refs) and evaluator
 *   reasoning attach to criteria BY CRITERION ID. Stable ids are the join key — that
 *   is why Phase 1 emits them deterministically.
 *
 * Runtime evaluation record != FlowPlan:
 *   The runtime record (evidence + reasoning + outcomes + its own version) is a
 *   DIFFERENT artifact from FlowPlan. Do not conflate them. FlowPlan.schemaVersion
 *   versions the static input plan only.
 * ------------------------------------------------------------------------- */
