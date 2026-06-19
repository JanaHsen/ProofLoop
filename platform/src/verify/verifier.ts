/**
 * The live per-criterion OUTCOME verifier (Phase 3 Task 4, D14/D22/D23). It is the ONE
 * non-deterministic component of Phase 3 — it wraps the Anthropic Messages API as a
 * schema-forced, single-tool-call judge of one acceptance criterion against one resolved
 * evidence window. Everything that decides the persisted verdict is the DETERMINISTIC
 * `finalizeCriterion` below; the model only ever proposes a raw `record_verdict` payload.
 *
 * Trust boundary (D14): the harness never trusts the model's claim. It re-validates every
 * citation (see ./citation) against the stored evidence, enforces exactly-one tool call,
 * and applies the FROZEN downgrade policy. Every ERROR-origin `InconclusiveDetail`
 * (INVALID_CITATION, VERIFIER_SCHEMA_ERROR, …) is HARNESS-assigned via `errorDetail`; the
 * model may only ever emit `AMBIGUOUS_EVIDENCE`.
 *
 * Preservation (gate requirement): EVERY observation the model cited is kept in the record,
 * valid or not, alongside its 1:1 `CitationValidation`. A failed citation is never silently
 * discarded — it is the raw material Phase 8 reliability work measures.
 *
 * @anthropic-ai/sdk is CommonJS, so a static import is safe under the ts-node runner. The
 * mocked verifier tests inject `create` instead of an `apiKey`, so they neither construct
 * the SDK client nor need a key, and incur zero live spend.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { RawUsage } from "../run/pricing";
import {
  validateEventObservation,
  validateSnapshotObservation,
} from "./citation";
import {
  errorDetail,
  type CitationValidation,
  type CriterionEvaluation,
  type InconclusiveDetail,
  type Observation,
  type Verdict,
} from "./evaluation";
import {
  buildVerifierInput,
  VERDICT_TOOL_DESCRIPTION,
  VERDICT_TOOL_NAME,
  VERDICT_TOOL_SCHEMA,
} from "./prompt";
import type { EvidenceWindow } from "./resolver";

/** Max output tokens for the single forced tool call — headroom for the verdict payload. */
export const VERIFIER_MAX_TOKENS = 2048;

/**
 * The verifier call parameters, recorded VERBATIM into `EvaluationRecord.verifierParams`
 * for Phase 8 reliability analysis. This is the lowest-variance supported config validated
 * at the Task 4 model-selection gate: the single tool call is forced with parallel tool use
 * disabled; sampling params (temperature/top_p/top_k) are REMOVED on the 4.6+ models (they
 * 400 if sent); extended thinking is off (a forced tool call precludes it); effort default.
 */
export const VERIFIER_PARAMS: Record<string, unknown> = {
  max_tokens: VERIFIER_MAX_TOKENS,
  tool_choice: VERDICT_TOOL_NAME,
  disable_parallel_tool_use: true,
  sampling: "none",
  thinking: "off",
};

/** One criterion to verify: its id, its VERBATIM text, and its resolved evidence window. */
export interface VerifierCriterionInput {
  criterionId: string;
  criterionText: string;
  window: EvidenceWindow;
}

export interface VerifierResult {
  /** The finalized, harness-validated per-criterion evaluation (the frozen record shape). */
  evaluation: CriterionEvaluation;
  /** Raw API usage, verbatim — the writer recomputes cost from it + the pricing config. */
  usage: RawUsage;
  latencyMs: number;
  model: string;
  /** record_verdict tool calls the model emitted (exactly-one enforced in finalize). */
  toolCallCount: number;
  /** The model's RAW verdict before any downgrade — for the gate report / reliability work. */
  rawVerdict: string;
  /** The model's RAW inconclusiveDetail.kind, if any (always AMBIGUOUS_EVIDENCE when valid). */
  rawDetailKind?: string;
}

export interface Verifier {
  verify(input: VerifierCriterionInput): Promise<VerifierResult>;
}

interface VerdictDecision {
  verdict: Verdict;
  inconclusiveDetail?: InconclusiveDetail;
}

interface ObservationCounts {
  snapValid: number;
  evValid: number;
  total: number;
  anyInvalid: boolean;
}

/**
 * The FROZEN deterministic downgrade policy (Task 4 gate). Decides the persisted verdict
 * from the model's raw payload + the harness-computed citation validity. ERROR-origin
 * details are all harness-assigned via `errorDetail`; the only model-sourced detail that
 * survives is a well-formed `AMBIGUOUS_EVIDENCE`.
 */
function decideVerdict(
  raw: any,
  toolCallCount: number,
  window: EvidenceWindow,
  counts: ObservationCounts,
): VerdictDecision {
  const { snapValid, evValid, total, anyInvalid } = counts;

  // Exactly one record_verdict call is required; zero or many ⇒ schema error.
  if (toolCallCount !== 1) {
    return {
      verdict: "INCONCLUSIVE",
      inconclusiveDetail: errorDetail(
        "VERIFIER_SCHEMA_ERROR",
        `expected exactly one ${VERDICT_TOOL_NAME} tool call, got ${toolCallCount}`,
      ),
    };
  }

  const v = raw?.verdict;

  if (v === "PASS" || v === "FAIL") {
    if (raw?.inconclusiveDetail) {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "VERIFIER_SCHEMA_ERROR",
          `${v} must not carry an inconclusiveDetail`,
        ),
      };
    }
    if (total === 0) {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "INVALID_CITATION",
          `${v} rests on zero observations; a verdict must cite ≥1 supporting reading`,
        ),
      };
    }
    if (anyInvalid) {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "INVALID_CITATION",
          `${v} relies on a citation the stored evidence does not contain`,
        ),
      };
    }
    if (window.windowKind === "non_completing" && v === "FAIL" && (snapValid < 1 || evValid < 1)) {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "INVALID_CITATION",
          `a non-completing-step FAIL requires ≥1 valid snapshot AND ≥1 valid event observation ` +
            `(got snapValid=${snapValid}, evValid=${evValid}); the decisive failure may not live only in reasoning`,
        ),
      };
    }
    return { verdict: v };
  }

  if (v === "INCONCLUSIVE") {
    // A detail-less (or wrong-kind) INCONCLUSIVE is a schema error — STRICT. The harness
    // NEVER invents a missing AMBIGUOUS_EVIDENCE detail.
    if (raw?.inconclusiveDetail?.kind !== "AMBIGUOUS_EVIDENCE") {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "VERIFIER_SCHEMA_ERROR",
          "INCONCLUSIVE must carry inconclusiveDetail.kind = AMBIGUOUS_EVIDENCE",
        ),
      };
    }
    // Relabel to INVALID_CITATION ONLY when there are observations and ALL are invalid:
    // a wholly unsubstantiated reading is the verifier's fault, not the evidence's.
    if (total >= 1 && snapValid + evValid === 0) {
      return {
        verdict: "INCONCLUSIVE",
        inconclusiveDetail: errorDetail(
          "INVALID_CITATION",
          "INCONCLUSIVE rests only on citations the stored evidence does not contain",
        ),
      };
    }
    return {
      verdict: "INCONCLUSIVE",
      inconclusiveDetail: {
        kind: "AMBIGUOUS_EVIDENCE",
        explanation: String(raw.inconclusiveDetail.explanation ?? ""),
      },
    };
  }

  return {
    verdict: "INCONCLUSIVE",
    inconclusiveDetail: errorDetail(
      "VERIFIER_SCHEMA_ERROR",
      `unrecognized verdict ${JSON.stringify(v)}`,
    ),
  };
}

/**
 * Pure, deterministic core: turn the model's raw `record_verdict` payload (+ how many tool
 * calls it made) into a finalized `CriterionEvaluation` against the evidence window. No
 * model call, no clock, no randomness — independently re-verifiable and unit-testable.
 */
export function finalizeCriterion(
  input: VerifierCriterionInput,
  raw: any,
  toolCallCount: number,
): CriterionEvaluation {
  const { criterionId, window } = input;

  const snapObsRaw: any[] = Array.isArray(raw?.observations) ? raw.observations : [];
  const evObsRaw: any[] = Array.isArray(raw?.eventObservations) ? raw.eventObservations : [];

  // Preserve EVERY snapshot observation the model emitted, valid or not — the failed
  // citation must remain in the record (never silently discarded), 1:1 with its validation.
  const observations: Observation[] = snapObsRaw.map((o) => ({
    label: String(o?.label ?? ""),
    observedText: String(o?.observedText ?? ""),
    snapshotId: String(o?.snapshotId ?? ""),
    ref: String(o?.ref ?? ""),
    ...(o?.normalizedValue !== undefined ? { normalizedValue: String(o.normalizedValue) } : {}),
  }));
  const citationValidations: CitationValidation[] = snapObsRaw.map((o) =>
    validateSnapshotObservation(o, window),
  );
  // Event-observation validity drives the verdict but is NOT a first-class field in the
  // frozen v1.0 record (events are summarized via evidence.eventRefs).
  const eventValidations = evObsRaw.map((o) => validateEventObservation(o, window));

  const counts: ObservationCounts = {
    snapValid: citationValidations.filter((vd) => vd.valid).length,
    evValid: eventValidations.filter((vd) => vd.valid).length,
    total: snapObsRaw.length + evObsRaw.length,
    anyInvalid:
      citationValidations.some((vd) => !vd.valid) || eventValidations.some((vd) => !vd.valid),
  };

  const { verdict, inconclusiveDetail } = decideVerdict(raw, toolCallCount, window, counts);

  const eventRefs = window.events.map((e) => ({ seq: e.seq, type: e.type }));
  return {
    criterionId,
    verdict,
    ...(inconclusiveDetail ? { inconclusiveDetail } : {}),
    observations,
    citationValidations,
    reasoning: String(raw?.reasoning ?? ""),
    evidence: {
      snapshotIds: window.snapshots.map((s) => s.snapshotId),
      ...(eventRefs.length > 0 ? { eventRefs } : {}),
    },
  };
}

type MessageCreateFn = (
  req: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface AnthropicVerifierOptions {
  /** Required for live calls; omit only when injecting `create` (mocked tests). */
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /** Test seam: inject a `messages.create` implementation — no SDK client, no key, no spend. */
  create?: MessageCreateFn;
}

export class AnthropicVerifier implements Verifier {
  private readonly create: MessageCreateFn;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicVerifierOptions) {
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? VERIFIER_MAX_TOKENS;
    if (opts.create) {
      this.create = opts.create;
    } else {
      if (!opts.apiKey) {
        throw new Error("AnthropicVerifier requires an apiKey (or an injected create)");
      }
      const client = new Anthropic({ apiKey: opts.apiKey });
      this.create = (req) => client.messages.create(req);
    }
  }

  async verify(input: VerifierCriterionInput): Promise<VerifierResult> {
    const assembled = buildVerifierInput(input.criterionText, input.window);
    const t0 = Date.now();
    const resp = await this.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: assembled.system,
      tools: [
        {
          name: VERDICT_TOOL_NAME,
          description: VERDICT_TOOL_DESCRIPTION,
          input_schema: VERDICT_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      // Force exactly the one tool, no parallel calls — lowest-variance config from the gate.
      tool_choice: { type: "tool", name: VERDICT_TOOL_NAME, disable_parallel_tool_use: true },
      messages: [{ role: "user", content: assembled.user }],
    });
    const latencyMs = Date.now() - t0;

    const toolBlocks = (resp.content || []).filter(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === VERDICT_TOOL_NAME,
    );
    const raw: any = toolBlocks[0]?.input;
    const evaluation = finalizeCriterion(input, raw, toolBlocks.length);

    return {
      evaluation,
      usage: { ...(resp.usage as unknown as RawUsage) },
      latencyMs,
      model: this.model,
      toolCallCount: toolBlocks.length,
      rawVerdict: typeof raw?.verdict === "string" ? raw.verdict : "(none)",
      ...(typeof raw?.inconclusiveDetail?.kind === "string"
        ? { rawDetailKind: raw.inconclusiveDetail.kind }
        : {}),
    };
  }
}
