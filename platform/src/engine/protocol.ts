/**
 * The Phase 2 execution protocol — the deterministic contract the LLM is wired into
 * at Task 5. Frozen at the Task 3 design gate. NOTHING here calls the model; this is
 * the schema, the validation, and the correction policy the harness enforces.
 *
 * The deterministic outer loop (D13), per step:
 *
 *   beginStep → emit step_start
 *   repeat:
 *     guard.beforeDecision()              // cancel / wall-clock / llm-call / token / cost
 *     capture fresh snapshot S; store S + digest
 *     request ONE decision, tool schema's `ref` enum = S.refs   (steering aid)
 *     guard.recordDecision(usage, cost)
 *     parseDecision(raw)                  // schema-validate
 *       └─ invalid? one INFORMED correction (fresh S + what was wrong), else error-stop
 *     if action:
 *       validateRef(S, decision.ref)      // ref ∈ THIS snapshot; harness-computed
 *         └─ invalid? one INFORMED correction (fresh S + bad ref + available refs), else error-stop
 *       guard.beforeAction()
 *       client.<click|type>(validatedRef) // target sourced ONLY from the ValidatedRef
 *       capture post snapshot; guard.recordProgress(preKey, postKey)  // no-progress backstop
 *     if step_complete: capture step-boundary snapshot; emit step_end; break
 *     if blocked: stop (blocked)
 *   until step_complete / blocked / guard trip
 *
 * `step_complete` means an action happened and a response was observed — NOT that the
 * app behaved correctly. Outcome judgment is Phase 3.
 */

import type { AllowedElementAction } from "../mcp/tools";
import type { ParsedSnapshot, RefRejectReason } from "../mcp/snapshot";

// --- the decision the model returns (D15) -----------------------------------------
//
// `ref` is the MODEL's proposed ref token (a plain string until validateRef checks it
// against the current snapshot). It is the only ref the model ever supplies, and it
// never becomes a `target` until it has been turned into a ValidatedRef.

export type StepDecision =
  | {
      kind: "action";
      action: AllowedElementAction;
      ref: string;
      value?: string;
      rationale: string;
    }
  | { kind: "step_complete"; rationale: string }
  | { kind: "blocked"; reason: string };

// --- the tool the model is constrained to (Anthropic tool-use, wired in Task 5) ----

export const DECISION_TOOL_NAME = "decide_next_step";

export const DECISION_TOOL_DESCRIPTION =
  "Choose exactly ONE next step toward completing the current flow step. Use an " +
  'action (click or type) targeting an element by its ref from the CURRENT snapshot; ' +
  "or step_complete once the requested action has been performed and a response was " +
  "observed; or blocked if the step cannot proceed. Never invent a ref or a selector " +
  "— ref must be one of the refs in the current snapshot.";

/**
 * Base JSON Schema for the decision tool. Conditional requirements (action needs
 * ref+rationale, type needs value, …) are enforced by parseDecision, not the schema —
 * tool-use providers honor `enum`/`type` reliably but not cross-field conditionals.
 */
export const DECISION_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["action", "step_complete", "blocked"],
      description: "Which kind of decision this is.",
    },
    action: {
      type: "string",
      enum: ["click", "type"],
      description: "For kind=action only: the element action to perform.",
    },
    ref: {
      type: "string",
      description:
        "For kind=action only: the eN ref of the target element, taken verbatim " +
        "from the current snapshot.",
    },
    value: {
      type: "string",
      description: "For action=type only: the text to type.",
    },
    rationale: {
      type: "string",
      description: "For kind=action or step_complete: a one-sentence reason.",
    },
    reason: {
      type: "string",
      description: "For kind=blocked only: why the step cannot proceed.",
    },
  },
  required: ["kind"],
} as const;

/**
 * The decision tool schema with the `ref` field constrained to the refs actually in
 * the current snapshot — a steering aid that cuts invalid-ref retries. It NEVER
 * replaces validateRef: the harness check against the snapshot remains authoritative.
 */
export function buildDecisionToolSchema(
  refs: Iterable<string>,
): Record<string, unknown> {
  const refList = [...refs];
  const schema: Record<string, unknown> = JSON.parse(
    JSON.stringify(DECISION_TOOL_SCHEMA),
  );
  if (refList.length > 0) {
    (schema.properties as Record<string, Record<string, unknown>>).ref.enum =
      refList;
  }
  return schema;
}

// --- schema validation of the returned decision -----------------------------------

export type DecisionParse =
  | { ok: true; decision: StepDecision }
  | { ok: false; error: string };

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

/** Validate the raw tool input into a StepDecision, or explain precisely what is wrong. */
export function parseDecision(raw: unknown): DecisionParse {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "decision must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case "action": {
      if (o.action !== "click" && o.action !== "type") {
        return { ok: false, error: 'kind=action requires action to be "click" or "type"' };
      }
      if (!isNonEmptyString(o.ref)) {
        return { ok: false, error: "kind=action requires a non-empty ref" };
      }
      if (!isNonEmptyString(o.rationale)) {
        return { ok: false, error: "kind=action requires a non-empty rationale" };
      }
      if (o.action === "type" && typeof o.value !== "string") {
        return { ok: false, error: "action=type requires a value (the text to type)" };
      }
      return {
        ok: true,
        decision: {
          kind: "action",
          action: o.action,
          ref: o.ref,
          rationale: o.rationale,
          ...(o.action === "type" ? { value: o.value as string } : {}),
        },
      };
    }
    case "step_complete":
      if (!isNonEmptyString(o.rationale)) {
        return { ok: false, error: "kind=step_complete requires a non-empty rationale" };
      }
      return { ok: true, decision: { kind: "step_complete", rationale: o.rationale } };
    case "blocked":
      if (!isNonEmptyString(o.reason)) {
        return { ok: false, error: "kind=blocked requires a non-empty reason" };
      }
      return { ok: true, decision: { kind: "blocked", reason: o.reason } };
    default:
      return {
        ok: false,
        error: 'kind must be "action", "step_complete", or "blocked"',
      };
  }
}

// --- invalid-response / single-correction policy ----------------------------------
//
// At most ONE bounded correction per decision, and it must be INFORMED: the re-ask
// carries a fresh snapshot AND what was wrong. A blind re-roll is hoping for different
// dice; telling the model "ref eX wasn't on the page, pick from these" is the point.

export const MAX_CORRECTIONS_PER_DECISION = 1;

/** Stable error code recorded when a model ref fails snapshot validation. */
export const INVALID_SNAPSHOT_REF = "INVALID_SNAPSHOT_REF";

/** Stable error code recorded when a no-effect action is proposed again (harness backstop). */
export const REPEATED_NO_EFFECT = "REPEATED_NO_EFFECT";

export type DecisionFailure =
  | { kind: "schema"; detail: string }
  | {
      kind: "invalid_ref";
      reason: RefRejectReason;
      detail: string;
      attemptedRef: string;
    }
  | {
      kind: "repeated_no_effect";
      detail: string;
      attemptedRef: string;
    };

/** Short, model-facing description of the available targets in the current snapshot. */
function describeRefs(snapshot: ParsedSnapshot): string {
  if (snapshot.elements.length === 0) return "(no interactive refs in the current snapshot)";
  return snapshot.elements
    .map((e) => `${e.ref} (${e.role}${e.name ? ` "${e.name}"` : ""})`)
    .join(", ");
}

/**
 * Build the informed-correction notice attached to the single re-ask, alongside the
 * fresh snapshot. Names the failure and the legal choices so the retry is meaningful.
 */
export function buildCorrectionNotice(
  failure: DecisionFailure,
  snapshot: ParsedSnapshot,
): string {
  let head: string;
  switch (failure.kind) {
    case "schema":
      head =
        `Your decision was invalid: ${failure.detail}. Return exactly ONE supported ` +
        `decision — an action (click or type) with a non-empty rationale, ` +
        `step_complete with a rationale, or blocked with a reason.`;
      break;
    case "invalid_ref":
      head =
        `Your previous decision used ref "${failure.attemptedRef}", which is not ` +
        `usable: ${failure.detail}. Choose a ref that exists in the current snapshot.`;
      break;
    case "repeated_no_effect":
      head =
        `Your previous action on "${failure.attemptedRef}" had no observable effect ` +
        `and you proposed the identical action again. Do not repeat it — choose a ` +
        `different action, a different element, or a complementary next action that ` +
        `advances the current step.`;
      break;
  }
  return (
    `${head}\nA fresh snapshot of the current page is provided below.\n` +
    `Available refs: ${describeRefs(snapshot)}`
  );
}
