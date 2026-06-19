/**
 * The deterministic report builder (Phase 4 Task 1). It joins one finished run to ONE
 * explicitly selected evaluation record and the current FlowPlan, asserts every D28
 * integrity invariant, and returns a `RunReport` projection. It is PURE and read-only:
 *
 *   - no browser, no verifier, no LLM, no network — a report is offline by construction;
 *   - no new verdict, score, or citation logic — every verdict and citation validation is
 *     re-stated exactly as recorded (D30);
 *   - no implicit evaluation selection — the caller passes `evaluationId`; the builder
 *     never scans for "latest"/highest and never zips parallel arrays to the shorter length.
 *
 * Any join mismatch is a report-integrity error: the build throws and the writer emits
 * neither `report.json` nor `report.html` (D28). The clock is irrelevant here — the
 * deterministic report carries no timestamp of its own, so two builds are byte-identical.
 *
 * SECRET REDACTION AT THE REPORTING BOUNDARY (D29). The authored flow text can itself embed
 * a credential — e.g. a step `Sign in as "alice" with password "password123"`. The run log
 * deliberately stores only a hash of step text for this reason, but the report must DISPLAY
 * the natural-language steps and join step text into the timeline, which would re-expose the
 * literal. So the builder derives the secret mask set ONCE from the original authored flow
 * (the SAME Phase 2 `extractSecretLiterals` rule — values adjacent to a secret keyword) and
 * masks it out of EVERY human-readable string that enters the projection — flow name and
 * description, step and criterion text, timeline step text / event detail / failure detail /
 * page URL, verifier reasoning, observation labels / observed text / normalized values,
 * citation reasons, and any inconclusive explanation — replacing each with the canonical
 * `[REDACTED]` marker. (When Task 2 attaches an `aiSummary`, its `text` must pass through the
 * same mask before it is stored.) Identifiers, refs, snapshot ids, hashes, verdicts, model
 * names, numeric values, and metrics are NOT rewritten unless they literally contain a
 * detected secret. The projected report is therefore a SAFE presentation projection, not a
 * byte-verbatim reproduction. Crucially, the `planHash` is computed from the UNTOUCHED parsed
 * plan BEFORE any masking, so integrity/D24 are unaffected.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FlowPlan } from "../flow-plan";
import { parseFlowFile } from "../parser";
import { readEvents, readManifest } from "../run/audit";
import { extractSecretLiterals, redactValuesInText } from "../run/redaction";
import { computePlanHash } from "../run/schema";
import type {
  ActionEvent,
  ErrorEvent,
  FlowEndEvent,
  RunEvent,
  SnapshotEvent,
  StepStartEvent,
} from "../run/schema";
import {
  EVALUATION_RECORD_SCHEMA_VERSION,
  type CitationValidation,
  type EvaluationRecord,
  type InconclusiveDetail,
  type Observation,
} from "../verify/evaluation";
import {
  REPORT_SCHEMA_VERSION,
  type ReportCriterion,
  type ReportTimelineEntry,
  type RunReport,
} from "./schema";

/** Thrown when a required input artifact is absent (run.json, the selected evaluation, …). */
export class ReportArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportArtifactNotFoundError";
  }
}

/**
 * Thrown when a D28 join invariant is violated (id mismatch, plan-hash mismatch, a missing
 * or duplicated criterion, an observation/citation length mismatch, an out-of-set citation).
 * A report that joins an evaluation to the wrong run or a stale flow can look convincing
 * while being false — so any mismatch fails loud and nothing is written.
 */
export class ReportIntegrityError extends Error {
  constructor(message: string) {
    super(`report integrity error: ${message}`);
    this.name = "ReportIntegrityError";
  }
}

/** Thrown when the selected evaluation declares an unsupported record schema version. */
export class UnsupportedEvaluationSchemaError extends Error {
  constructor(public readonly version: unknown) {
    super(
      `unsupported evaluationRecordSchemaVersion ${JSON.stringify(version)} ` +
        `(supported: ${EVALUATION_RECORD_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedEvaluationSchemaError";
  }
}

export interface BuildReportOptions {
  /** The finished run's directory, `platform/runs/<runId>`. Read-only. */
  runDir: string;
  /** The EXPLICIT evaluation id to project, e.g. `eval-001`. Never inferred. */
  evaluationId: string;
  /** Directory holding `<flowId>.flow.md` (the repo's `fixtures/flows`). */
  flowsDir: string;
}

function readEvaluation(runDir: string, evaluationId: string): EvaluationRecord {
  const evalDir = path.join(runDir, "evaluations", evaluationId);
  const evalPath = path.join(evalDir, "evaluation.json");
  if (!fs.existsSync(evalDir) || !fs.existsSync(evalPath)) {
    throw new ReportArtifactNotFoundError(
      `selected evaluation ${evaluationId} not found at ${evalPath}`,
    );
  }
  const record = JSON.parse(fs.readFileSync(evalPath, "utf8")) as EvaluationRecord;
  if (record.evaluationRecordSchemaVersion !== EVALUATION_RECORD_SCHEMA_VERSION) {
    throw new UnsupportedEvaluationSchemaError(record.evaluationRecordSchemaVersion);
  }
  return record;
}

/**
 * Assert the D28 invariants. Order matters only for clarity; any single failure throws.
 * The FlowPlan criteria and the evaluation criteria must be a bijection by id (each plan
 * criterion present exactly once, no extra/duplicate evaluation criterion), every criterion
 * pairs observations 1:1 with citation validations, and every cited snapshot id is in that
 * criterion's recorded evidence set.
 */
function assertIntegrity(
  runId: string,
  manifestPlanHash: string,
  reparsedPlanHash: string,
  plan: FlowPlan,
  evaluation: EvaluationRecord,
): void {
  // ----- run ↔ evaluation identity joins -----
  if (evaluation.runId !== runId) {
    throw new ReportIntegrityError(
      `evaluation.runId (${evaluation.runId}) !== run.runId (${runId})`,
    );
  }
  if (evaluation.flowId !== plan.id) {
    throw new ReportIntegrityError(
      `evaluation.flowId (${evaluation.flowId}) !== run/flow id (${plan.id})`,
    );
  }
  if (evaluation.planHash !== manifestPlanHash) {
    throw new ReportIntegrityError(
      `evaluation.planHash (${evaluation.planHash}) !== run.planHash (${manifestPlanHash})`,
    );
  }
  // ----- the criteria graded are the criteria currently parsed (D24) -----
  if (reparsedPlanHash !== manifestPlanHash) {
    throw new ReportIntegrityError(
      `the current flow re-parses to ${reparsedPlanHash} but the run was executed against ` +
        `${manifestPlanHash}; the flow file has changed since the run. Grading or reporting ` +
        `the current criteria against stale evidence is forbidden (D24/D28).`,
    );
  }

  // ----- criterion-set bijection: each plan criterion present exactly once -----
  const planIds = plan.criteria.map((c) => c.id);
  const planIdSet = new Set(planIds);
  const seen = new Set<string>();
  for (const c of evaluation.criteria) {
    if (!planIdSet.has(c.criterionId)) {
      throw new ReportIntegrityError(
        `evaluation criterion ${c.criterionId} does not exist in the FlowPlan`,
      );
    }
    if (seen.has(c.criterionId)) {
      throw new ReportIntegrityError(
        `evaluation criterion ${c.criterionId} appears more than once`,
      );
    }
    seen.add(c.criterionId);
  }
  for (const id of planIds) {
    if (!seen.has(id)) {
      throw new ReportIntegrityError(
        `FlowPlan criterion ${id} is missing from the evaluation (no criterion may be silently omitted)`,
      );
    }
  }

  // ----- per-criterion evidence shape -----
  for (const c of evaluation.criteria) {
    if (c.observations.length !== c.citationValidations.length) {
      throw new ReportIntegrityError(
        `criterion ${c.criterionId}: observations.length (${c.observations.length}) !== ` +
          `citationValidations.length (${c.citationValidations.length}) — never zip to the shorter length`,
      );
    }
    const evidenceSet = new Set(c.evidence?.snapshotIds ?? []);
    for (const obs of c.observations) {
      if (!evidenceSet.has(obs.snapshotId)) {
        throw new ReportIntegrityError(
          `criterion ${c.criterionId}: observation cites snapshot ${obs.snapshotId} which is ` +
            `not in that criterion's recorded evidence set`,
        );
      }
    }
  }
}

/** A deterministic secret-literal masker bound to one run's authored-text mask set. */
type Redactor = (text: string) => string;

/** Mask the human-readable strings of an observation; identifiers (snapshotId/ref) are left intact. */
function redactObservation(o: Observation, redact: Redactor): Observation {
  return {
    label: redact(o.label),
    observedText: redact(o.observedText),
    snapshotId: o.snapshotId,
    ref: o.ref,
    ...(o.normalizedValue !== undefined ? { normalizedValue: redact(o.normalizedValue) } : {}),
  };
}

/** Mask the only free-text field of a citation check (`reason`); booleans are structural. */
function redactCitation(v: CitationValidation, redact: Redactor): CitationValidation {
  return {
    snapshotProvided: v.snapshotProvided,
    digestMatches: v.digestMatches,
    refPresent: v.refPresent,
    observedTextPresent: v.observedTextPresent,
    valid: v.valid,
    ...(v.reason !== undefined ? { reason: redact(v.reason) } : {}),
  };
}

/**
 * Mask the `explanation` of an INCONCLUSIVE detail; `kind`/`code`/`origin` are enums kept as-is.
 * Spread (not field-by-field rebuild) so the locked code→origin pairing is preserved verbatim.
 */
function redactInconclusive(d: InconclusiveDetail, redact: Redactor): InconclusiveDetail {
  return { ...d, explanation: redact(d.explanation) };
}

/**
 * Project the evaluation's criteria, joining each to its FlowPlan text by id. EVERY
 * human-readable string is run through the same authored-flow secret mask at the reporting
 * boundary (D29) — criterion text, verifier reasoning, observation labels / observed text /
 * normalized values, citation reasons, and any inconclusive explanation. Verdicts, refs,
 * snapshot ids, and the citation booleans are preserved exactly as recorded (D30).
 */
function buildCriteria(
  plan: FlowPlan,
  evaluation: EvaluationRecord,
  redact: Redactor,
): ReportCriterion[] {
  const planById = new Map(plan.criteria.map((c) => [c.id, c]));
  return evaluation.criteria.map((c) => {
    const planCriterion = planById.get(c.criterionId)!; // bijection asserted in assertIntegrity
    const out: ReportCriterion = {
      criterionId: c.criterionId,
      ordinal: planCriterion.ordinal,
      text: redact(planCriterion.text),
      verdict: c.verdict,
      reasoning: redact(c.reasoning),
      observations: c.observations.map((o) => redactObservation(o, redact)),
      citationValidations: c.citationValidations.map((v) => redactCitation(v, redact)),
      evidence: {
        snapshotIds: c.evidence?.snapshotIds ?? [],
        ...(c.evidence?.eventRefs !== undefined
          ? { eventRefs: c.evidence.eventRefs }
          : {}),
      },
    };
    if (planCriterion.after !== undefined) out.after = planCriterion.after;
    if (c.inconclusiveDetail !== undefined) {
      out.inconclusiveDetail = redactInconclusive(c.inconclusiveDetail, redact);
    }
    return out;
  });
}

/**
 * Build the human-readable timeline from `events.jsonl`. Step text is joined from the
 * FlowPlan by `stepId`; an action's page URL is joined from its resolved snapshot event by
 * `snapshotId` (recorded, not invented). Only step boundaries, actions, errors, and the
 * terminal flow status are projected.
 */
function buildTimeline(
  events: RunEvent[],
  plan: FlowPlan,
  redact: Redactor,
): ReportTimelineEntry[] {
  // Mask step text once at the join source so every timeline use inherits the redaction.
  const stepTextById = new Map(plan.steps.map((s) => [s.id, redact(s.text)]));
  const pageUrlBySnapshot = new Map<string, string>();
  for (const e of events) {
    if (e.type === "snapshot") {
      const s = e as SnapshotEvent;
      if (s.pageUrl !== undefined) pageUrlBySnapshot.set(s.snapshotId, s.pageUrl);
    }
  }

  const timeline: ReportTimelineEntry[] = [];
  for (const e of events) {
    switch (e.type) {
      case "step_start": {
        const s = e as StepStartEvent;
        timeline.push({
          seq: s.seq,
          type: "step_start",
          stepId: s.stepId,
          stepText: stepTextById.get(s.stepId),
          ordinal: s.ordinal,
        });
        break;
      }
      case "step_end": {
        timeline.push({
          seq: e.seq,
          type: "step_end",
          stepId: e.stepId,
          stepText: e.stepId ? stepTextById.get(e.stepId) : undefined,
        });
        break;
      }
      case "action": {
        const a = e as ActionEvent;
        const entry: ReportTimelineEntry = {
          seq: a.seq,
          type: "action",
          action: a.action,
          ref: a.ref,
          status: a.status,
        };
        if (a.stepId !== undefined) {
          entry.stepId = a.stepId;
          entry.stepText = stepTextById.get(a.stepId); // already masked at the map source
        }
        const pageUrl = pageUrlBySnapshot.get(a.snapshotId);
        if (pageUrl !== undefined) entry.pageUrl = redact(pageUrl);
        // failureDetail was scrubbed of run-scoped secrets at capture; mask again defensively.
        if (a.failureDetail !== undefined) entry.failureDetail = redact(a.failureDetail);
        if (a.failureDetailTruncated !== undefined) {
          entry.failureDetailTruncated = a.failureDetailTruncated;
        }
        timeline.push(entry);
        break;
      }
      case "error": {
        const err = e as ErrorEvent;
        timeline.push({
          seq: err.seq,
          type: "error",
          stepId: err.stepId,
          code: err.code, // stable enum code (e.g. INVALID_SNAPSHOT_REF) — an identifier
          detail: redact(err.detail),
        });
        break;
      }
      case "flow_end": {
        const f = e as FlowEndEvent;
        timeline.push({
          seq: f.seq,
          type: "flow_end",
          executionStatus: f.executionStatus,
        });
        break;
      }
      default:
        break; // snapshot / llm_decision / retry / screenshot / guard / continuity are not timeline rows
    }
  }
  return timeline;
}

/**
 * Build the deterministic `RunReport` for one explicitly selected evaluation. Throws
 * `ReportArtifactNotFoundError` / `UnsupportedEvaluationSchemaError` / `ReportIntegrityError`
 * before producing any output if an input is missing or a D28 join is violated.
 */
export function buildReport(opts: BuildReportOptions): RunReport {
  const manifest = readManifest(opts.runDir);
  const evaluation = readEvaluation(opts.runDir, opts.evaluationId);

  const plan = parseFlowFile(path.join(opts.flowsDir, `${manifest.flowId}.flow.md`));
  // planHash is computed from the UNTOUCHED parsed plan, before any presentation masking.
  const reparsedPlanHash = computePlanHash(plan);

  assertIntegrity(manifest.runId, manifest.planHash, reparsedPlanHash, plan, evaluation);

  const { events } = readEvents(path.join(opts.runDir, "events.jsonl"));

  // Build the run-scoped secret mask set from the ORIGINAL authored flow text (same Phase 2
  // rule: only values adjacent to a secret keyword), then mask it out of authored-text fields
  // as they enter the projection. A flow with no secrets yields an empty set => a no-op.
  const secretLiterals = extractSecretLiterals([
    plan.name,
    plan.description ?? "",
    ...plan.steps.map((s) => s.text),
    ...plan.criteria.map((c) => c.text),
  ]);
  const redact: Redactor = (text) => redactValuesInText(text, secretLiterals);

  const report: RunReport = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    source: {
      runId: manifest.runId,
      evaluationId: evaluation.evaluationId,
      runLogSchemaVersion: manifest.runLogSchemaVersion,
      evaluationRecordSchemaVersion: evaluation.evaluationRecordSchemaVersion,
      flowPlanSchemaVersion: plan.schemaVersion,
      planHash: manifest.planHash,
    },
    flow: {
      id: plan.id,
      name: redact(plan.name),
      ...(plan.description !== undefined ? { description: redact(plan.description) } : {}),
      entry: plan.entry,
      viewport: plan.viewport,
      steps: plan.steps.map((s) => ({ id: s.id, ordinal: s.ordinal, text: redact(s.text) })),
      criteria: plan.criteria.map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        text: redact(c.text),
        ...(c.after !== undefined ? { after: c.after } : {}),
      })),
    },
    execution: {
      status: manifest.executionStatus,
      ...(manifest.model !== undefined ? { model: manifest.model } : {}),
      actionCount: manifest.totals.actionCount,
      errorCount: manifest.totals.errorCount,
      retryCount: manifest.totals.retryCount,
      inputTokens: manifest.totals.promptTokens,
      outputTokens: manifest.totals.completionTokens,
      costUsd: manifest.totals.costUsd,
      latencyMs: manifest.totals.latencyMs,
    },
    verification: {
      flowVerdict: evaluation.flowVerdict,
      model: evaluation.verifierModel,
      params: evaluation.verifierParams,
      inputTokens: evaluation.totals.promptTokens,
      outputTokens: evaluation.totals.completionTokens,
      costUsd: evaluation.totals.costUsd,
      latencyMs: evaluation.totals.latencyMs,
      criteria: buildCriteria(plan, evaluation, redact),
    },
    timeline: buildTimeline(events, plan, redact),
  };

  return report;
}
