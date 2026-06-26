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
  | { kind: "blocked"; reason: string }
  /**
   * (D48) Revisit a URL OBSERVED earlier in this run, as a fresh document navigation. The
   * model names the SOURCE snapshot id only — it never supplies a URL. The harness reads the
   * trusted, same-origin destination from that snapshot's stored `pageUrl` and re-validates
   * it before navigating. Used when the flow must revisit a created resource (e.g. an order's
   * own page) and no page link provides the route.
   */
  | { kind: "navigate_to_observed_url"; snapshotId: string; rationale: string };

// --- the tool the model is constrained to (Anthropic tool-use, wired in Task 5) ----

export const DECISION_TOOL_NAME = "decide_next_step";

export const DECISION_TOOL_DESCRIPTION =
  "Choose exactly ONE next step toward completing the current flow step. Use an " +
  'action (click or type) targeting an element by its ref from the CURRENT snapshot; ' +
  "or navigate_to_observed_url to revisit, as a fresh visit, a page you ALREADY observed " +
  "earlier in this run (you name that page's snapshot id — never a URL); or step_complete " +
  "once the requested action has been performed and a response was observed; or blocked if " +
  "the step cannot proceed. Never invent a ref, a selector, a URL, or a snapshot id.";

/**
 * Whether the decision tool is registered as a strict tool. With strict tools the
 * provider enforces the schema — including the nested `decision` discriminated union
 * below — so a malformed variant is rejected at the provider before it ever returns.
 * This is an early-rejection/steering aid; parseDecision remains the authoritative gate.
 */
export const DECISION_TOOL_STRICT = true;

/**
 * Base JSON Schema for the decision tool.
 *
 * The Anthropic API rejects `oneOf`/`allOf`/`anyOf` at the TOP LEVEL of an
 * input_schema (HTTP 400). So the top level is an ordinary object with a single
 * required `decision` property, and the discriminated union lives one level down as
 * `decision.anyOf`. Each branch is complete: a `const` discriminator, every field it
 * needs in `required`, and `additionalProperties:false`. Combined with strict tool
 * use this lets the provider reject malformed variants up front — but parseDecision
 * still re-validates every field; the harness never trusts the provider's enforcement.
 */
export const DECISION_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      anyOf: [
        {
          // click
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "action" },
            action: { const: "click" },
            ref: {
              type: "string",
              description:
                "The eN ref of the element to click, taken verbatim from the " +
                "current snapshot.",
            },
            rationale: {
              type: "string",
              description: "A one-sentence reason for this click.",
            },
          },
          required: ["kind", "action", "ref", "rationale"],
        },
        {
          // type
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "action" },
            action: { const: "type" },
            ref: {
              type: "string",
              description:
                "The eN ref of the field to type into, taken verbatim from the " +
                "current snapshot.",
            },
            value: {
              type: "string",
              description: "The text to type into the field.",
            },
            rationale: {
              type: "string",
              description: "A one-sentence reason for typing this value here.",
            },
          },
          required: ["kind", "action", "ref", "value", "rationale"],
        },
        {
          // step_complete
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "step_complete" },
            rationale: {
              type: "string",
              description:
                "A one-sentence reason the requested action is done and a " +
                "response was observed.",
            },
          },
          required: ["kind", "rationale"],
        },
        {
          // blocked
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "blocked" },
            reason: {
              type: "string",
              description: "Why the step cannot proceed.",
            },
          },
          required: ["kind", "reason"],
        },
        {
          // navigate_to_observed_url (D48) — there is deliberately NO `url` field: the
          // destination is read by the harness from the named snapshot's stored pageUrl,
          // and additionalProperties:false rejects any model-supplied URL outright.
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "navigate_to_observed_url" },
            snapshotId: {
              type: "string",
              description:
                "The snapshot id (e.g. snapshot-016) of a page you OBSERVED earlier in " +
                "this run whose URL you want to revisit as a fresh visit. You do NOT supply " +
                "a URL — the harness reads the trusted, same-origin URL from that snapshot. " +
                "Use only an id listed in the observed-pages section; never invent one.",
            },
            rationale: {
              type: "string",
              description: "A one-sentence reason for revisiting that observed page.",
            },
          },
          required: ["kind", "snapshotId", "rationale"],
        },
      ],
    },
  },
  required: ["decision"],
} as const;

/** Shape of the mutable deep clone produced for per-call ref steering. */
type MutableDecisionSchema = {
  properties: {
    decision: {
      anyOf: Array<{ properties: { ref?: { enum?: string[] } } }>;
    };
  };
};

/**
 * The decision tool schema with the `ref` field constrained to the refs actually in
 * the current snapshot — a steering aid that cuts invalid-ref retries. The enum is
 * injected into the click and type branches (the only branches with a `ref`). It
 * NEVER replaces validateRef: the harness check against the snapshot remains
 * authoritative.
 */
export function buildDecisionToolSchema(
  refs: Iterable<string>,
): Record<string, unknown> {
  const refList = [...refs];
  const schema: MutableDecisionSchema = JSON.parse(
    JSON.stringify(DECISION_TOOL_SCHEMA),
  );
  if (refList.length > 0) {
    for (const branch of schema.properties.decision.anyOf) {
      if (branch.properties.ref) {
        branch.properties.ref.enum = refList;
      }
    }
  }
  return schema as unknown as Record<string, unknown>;
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
  // The tool input wraps the chosen variant under a single `decision` property (the
  // provider-enforced discriminated union). Unwrap it, then apply the authoritative
  // per-field validation below — the harness never trusts the provider's enforcement.
  const inner = (raw as Record<string, unknown>).decision;
  if (typeof inner !== "object" || inner === null) {
    return {
      ok: false,
      error: "tool input must wrap the chosen variant under a `decision` property",
    };
  }
  const o = inner as Record<string, unknown>;
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
    case "navigate_to_observed_url": {
      // The model names a snapshot id ONLY. A destination is NEVER taken from model free text:
      // an UNKNOWN property (especially `url`) is rejected here as schema-invalid — not silently
      // stripped — so the harness never depends on the provider's strict-tool enforcement alone.
      if (!isNonEmptyString(o.snapshotId)) {
        return { ok: false, error: "kind=navigate_to_observed_url requires a non-empty snapshotId" };
      }
      if (!isNonEmptyString(o.rationale)) {
        return { ok: false, error: "kind=navigate_to_observed_url requires a non-empty rationale" };
      }
      const allowed = new Set(["kind", "snapshotId", "rationale"]);
      const extra = Object.keys(o).filter((k) => !allowed.has(k));
      if (extra.length > 0) {
        return {
          ok: false,
          error:
            `kind=navigate_to_observed_url does not accept ` +
            `${extra.map((k) => JSON.stringify(k)).join(", ")} — the destination is read from the ` +
            `named snapshot, never supplied by the model (a \`url\` is never accepted)`,
        };
      }
      return {
        ok: true,
        decision: { kind: "navigate_to_observed_url", snapshotId: o.snapshotId, rationale: o.rationale },
      };
    }
    default:
      return {
        ok: false,
        error: 'kind must be "action", "step_complete", "blocked", or "navigate_to_observed_url"',
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

/** Stable error code recorded when a navigate_to_observed_url fails the trusted-destination contract (D48). */
export const NAV_REJECTED = "NAV_REJECTED";

/** Stable error code: a repeated observed-URL navigation that produced no observable page change (D48). */
export const NAV_NO_EFFECT = "NAV_NO_EFFECT";

/** Stable error code: an observed-URL navigation that would reload the current page and discard a just-observed action response (D48). */
export const NAV_WOULD_RESET = "NAV_WOULD_RESET";

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
    }
  | {
      kind: "nav_rejected";
      detail: string;
      attemptedSnapshotId: string;
    }
  | {
      /** A repeated/destructive observed-URL navigation rejected BEFORE the browser (D48). */
      kind: "nav_no_progress";
      detail: string;
      attemptedSnapshotId: string;
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
    case "nav_rejected":
      head =
        `Your navigate_to_observed_url named snapshot "${failure.attemptedSnapshotId}", ` +
        `which is not a usable trusted destination: ${failure.detail}. You may only revisit ` +
        `a same-origin page you already observed in this run — choose a snapshot id listed in ` +
        `the observed-pages section, or return blocked if none provides the route. Never ` +
        `supply a URL or invent a snapshot id.`;
      break;
    case "nav_no_progress":
      head =
        `Your navigate_to_observed_url to snapshot "${failure.attemptedSnapshotId}" was not ` +
        `performed: ${failure.detail}. Do NOT navigate there again. If the page already shows ` +
        `the outcome this step requires, return step_complete; otherwise choose a different ` +
        `action (click or type) that advances the step, or return blocked.`;
      break;
  }
  return (
    `${head}\nA fresh snapshot of the current page is provided below.\n` +
    `Available refs: ${describeRefs(snapshot)}`
  );
}
