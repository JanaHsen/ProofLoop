/**
 * The evaluation-record writer (Phase 3 Task 5, D23/D24). It is the deterministic
 * orchestrator that turns a finished run into one frozen `EvaluationRecord`:
 *
 *   1. Load the run manifest (`readManifest`).
 *   2. Re-parse the flow from `fixtures/flows/<flowId>.flow.md` and recompute its
 *      `planHash`, then ASSERT it equals `manifest.planHash` — fail loud otherwise. This
 *      is the D24 guarantee that the criteria being graded are exactly the ones executed;
 *      a flow edited after the run must never be silently graded against stale evidence.
 *   3. Resolve each criterion's evidence window deterministically (`resolveEvidence`).
 *      A short-circuited criterion (no gradeable evidence) becomes INCONCLUSIVE carrying
 *      the resolver's own ERROR detail — with NO verifier call (and so no spend).
 *   4. Verify every other criterion through the injected `Verifier` (live or mocked).
 *   5. Aggregate the flow verdict (D23 `aggregateVerdict`) and sum the verifier-call
 *      totals (tokens / cost / latency) from raw usage + the versioned pricing config.
 *   6. Write `<runDir>/evaluations/<evaluationId>/evaluation.json` under an ORDERED,
 *      single-writer `evaluationId` (`eval-NNN`) derived from what is already on disk —
 *      never a UUID/timestamp, never overwriting a prior pass.
 *
 * The writer is the only place the verifier (the one non-deterministic component) is
 * invoked; everything else here is pure structure. The `Verifier` is injected so tests
 * drive it with mocked responses and incur zero live spend. The clock is injected for the
 * same reason — `startedAt`/`finishedAt` are the only non-deterministic values, and tests
 * pin them. No randomness anywhere.
 *
 * Black-box boundary: the writer reads only the run's own frozen artifacts and the flow
 * file. It never reads app/ source, the bug ledger, PROOFLOOP_BUGS, or the debug token.
 * The evidence it hands the verifier was already secret-masked at capture (Phase 2), so
 * recorded observations and reasoning inherit that masking.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parseFlowFile } from "../parser";
import { readManifest } from "../run/audit";
import {
  computeCostUsd,
  loadPricing,
  ratesFor,
  usageTotals,
  type PricingConfig,
} from "../run/pricing";
import { computePlanHash } from "../run/schema";
import {
  aggregateVerdict,
  EVALUATION_RECORD_SCHEMA_VERSION,
  type CriterionEvaluation,
  type EvaluationRecord,
  type EvaluationTotals,
} from "./evaluation";
import { resolveEvidence } from "./resolver";
import type { Verifier, VerifierResult } from "./verifier";

/** Thrown when the re-parsed flow's planHash does not match the run manifest's (D24). */
export class PlanHashMismatchError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `planHash mismatch for run ${runId}: the flow re-parses to ${actual} but the run was ` +
        `executed against ${expected}. The flow file has changed since the run; grading the ` +
        `current criteria against stale evidence is forbidden (D24). Re-run the flow, or ` +
        `verify against the exact flow that produced this run.`,
    );
    this.name = "PlanHashMismatchError";
  }
}

export interface WriteEvaluationOptions {
  /** The finished run's directory, `platform/runs/<runId>`. Read-only except for the new evaluation. */
  runDir: string;
  /** Directory holding `<flowId>.flow.md` (the repo's `fixtures/flows`). The writer derives the file. */
  flowsDir: string;
  /** The verifier to invoke per criterion — injected so tests mock it (zero live spend). */
  verifier: Verifier;
  /** Verifier model id recorded verbatim into the record (the configured `requireVerifierModel`). */
  verifierModel: string;
  /** Verifier call params recorded verbatim for Phase 8 reliability analysis (`VERIFIER_PARAMS`). */
  verifierParams: Record<string, unknown>;
  /** Pricing config id for cost recompute; defaults to the run manifest's. Must price `verifierModel`. */
  pricingConfigId?: string;
  /** Clock seam: `startedAt`/`finishedAt` source. Defaults to wall-clock ISO; tests pin it. */
  clock?: () => string;
}

export interface WriteEvaluationResult {
  record: EvaluationRecord;
  evaluationId: string;
  evaluationDir: string;
  evaluationPath: string;
}

/**
 * Next ordered evaluation id (`eval-001`, `eval-002`, …) for a run: one past the highest
 * `eval-NNN` already written under `<runDir>/evaluations/`. Deterministic single-writer
 * counter — no randomness, no timestamps — so repeated passes accumulate without collision.
 */
export function nextEvaluationId(evaluationsDir: string): string {
  let max = 0;
  if (fs.existsSync(evaluationsDir)) {
    for (const entry of fs.readdirSync(evaluationsDir)) {
      const m = /^eval-(\d+)$/.exec(entry);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `eval-${String(max + 1).padStart(3, "0")}`;
}

/** Build a short-circuited criterion evaluation: INCONCLUSIVE carrying the resolver's ERROR detail. */
function shortCircuitEvaluation(
  criterionId: string,
  detail: NonNullable<ReturnType<typeof resolveEvidence>[number]["shortCircuit"]>,
): CriterionEvaluation {
  return {
    criterionId,
    verdict: "INCONCLUSIVE",
    inconclusiveDetail: detail,
    observations: [],
    citationValidations: [],
    // No verifier ran, so there is no model reasoning to record; the cause is in `detail`.
    reasoning: "",
    evidence: { snapshotIds: [] },
  };
}

/** Sum the verifier-call totals (tokens / cost / latency) from raw usage + versioned pricing. */
function sumTotals(results: VerifierResult[], pricing: PricingConfig): EvaluationTotals {
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let latencyMs = 0;
  for (const r of results) {
    const t = usageTotals(r.usage);
    promptTokens += t.promptTokens;
    completionTokens += t.completionTokens;
    // Price each call by the model it actually used; ratesFor throws loud if unpriced.
    costUsd += computeCostUsd(r.usage, ratesFor(pricing, r.model));
    latencyMs += r.latencyMs;
  }
  return { promptTokens, completionTokens, costUsd, latencyMs };
}

/**
 * Evaluate one finished run and write its evaluation record. Returns the record plus the
 * path it was written to. Throws `PlanHashMismatchError` if the flow changed since the run.
 */
export async function writeEvaluation(
  opts: WriteEvaluationOptions,
): Promise<WriteEvaluationResult> {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const startedAt = clock();

  const manifest = readManifest(opts.runDir);

  // Re-parse the flow deterministically and pin it to the executed plan (D24).
  const plan = parseFlowFile(
    path.join(opts.flowsDir, `${manifest.flowId}.flow.md`),
  );
  const recomputed = computePlanHash(plan);
  if (recomputed !== manifest.planHash) {
    throw new PlanHashMismatchError(manifest.runId, manifest.planHash, recomputed);
  }

  const pricingConfigId = opts.pricingConfigId ?? manifest.pricingConfigId;
  const pricing = loadPricing(pricingConfigId);
  // Fail loud NOW if the verifier model is unpriced — before any (live) verifier call.
  ratesFor(pricing, opts.verifierModel);

  const resolved = resolveEvidence(plan, opts.runDir);

  const criteria: CriterionEvaluation[] = [];
  const verifierResults: VerifierResult[] = [];
  for (const rc of resolved) {
    if (rc.shortCircuit) {
      criteria.push(shortCircuitEvaluation(rc.criterionId, rc.shortCircuit));
      continue;
    }
    // The resolver guarantees exactly one of shortCircuit / evidence is set.
    const window = rc.evidence!;
    const criterion = plan.criteria.find((c) => c.id === rc.criterionId)!;
    const result = await opts.verifier.verify({
      criterionId: rc.criterionId,
      criterionText: criterion.text,
      window,
    });
    verifierResults.push(result);
    criteria.push(result.evaluation);
  }

  const flowVerdict = aggregateVerdict(criteria.map((c) => c.verdict));
  const totals = sumTotals(verifierResults, pricing);
  const finishedAt = clock();

  const evaluationsDir = path.join(opts.runDir, "evaluations");
  const evaluationId = nextEvaluationId(evaluationsDir);
  const evaluationDir = path.join(evaluationsDir, evaluationId);
  // Never overwrite a prior pass — the ordered counter should already guarantee this.
  if (fs.existsSync(evaluationDir)) {
    throw new Error(
      `evaluation directory ${evaluationDir} already exists; refusing to overwrite a prior pass`,
    );
  }

  const record: EvaluationRecord = {
    evaluationRecordSchemaVersion: EVALUATION_RECORD_SCHEMA_VERSION,
    evaluationId,
    runId: manifest.runId,
    flowId: manifest.flowId,
    planHash: manifest.planHash,
    verifierModel: opts.verifierModel,
    verifierParams: opts.verifierParams,
    pricingConfigId,
    startedAt,
    finishedAt,
    flowVerdict,
    criteria,
    totals,
  };

  fs.mkdirSync(evaluationDir, { recursive: true });
  const evaluationPath = path.join(evaluationDir, "evaluation.json");
  fs.writeFileSync(evaluationPath, JSON.stringify(record, null, 2) + "\n", "utf8");

  return { record, evaluationId, evaluationDir, evaluationPath };
}
