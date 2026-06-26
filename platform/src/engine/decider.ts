/**
 * The decider (Task 5) — the ONE non-deterministic component. It wraps the Anthropic
 * Messages API as a schema-constrained, one-action-at-a-time decider (D13/D15). It
 * returns a single raw StepDecision via tool-use; the harness (loop.ts) validates the
 * ref → ValidatedRef → dispatch. The model NEVER touches MCP, never sees the `target`
 * param, and never receives PROOFLOOP_BUGS, secrets, or any ground truth — its prompt
 * is built only from the current step text, the live snapshot, and prior in-step
 * attempts.
 *
 * @anthropic-ai/sdk is CommonJS, so a static import is safe under the ts-node runner.
 * loop.ts imports only the TYPES from this module (erased), so the mocked loop tests
 * never load the SDK or need an API key.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { FlowStep } from "../flow-plan";
import type { ParsedSnapshot } from "../mcp/snapshot";
import type { RawUsage } from "../run/pricing";
import {
  DECISION_TOOL_DESCRIPTION,
  DECISION_TOOL_NAME,
  DECISION_TOOL_STRICT,
  DecisionFailure,
  buildCorrectionNotice,
  buildDecisionToolSchema,
} from "./protocol";
import { observedDisplayPath } from "./navigation";

export interface AttemptSummary {
  action: "click" | "type";
  ref: string;
  role?: string;
  name?: string;
  /** Typed value (masked if sensitive); absent for clicks. */
  value?: string;
  /** Did the page change after this action? Resolved at the next snapshot. */
  observableEffect?: boolean;
}

/**
 * (D48) A distinct page the run has ALREADY observed, offered to the model as a trusted revisit
 * target. The model selects `snapshotId` (never a URL). `displayPath` is a SANITIZED descriptor
 * (pathname + redacted query-key names; no origin, credentials, query values, or fragment) — the
 * full internal URL is deliberately kept out of the prompt.
 */
export interface ObservedPage {
  snapshotId: string;
  displayPath: string;
  pageTitle?: string;
}

export interface DecisionContext {
  step: FlowStep;
  snapshot: ParsedSnapshot;
  /** Bounded summary of actions already attempted in THIS step. */
  attemptsInStep: AttemptSummary[];
  /** Harness-computed fact: the page changed since the last action this step. */
  pageChangedSinceAction?: boolean;
  /** Present only on the single informed correction re-ask. */
  correction?: DecisionFailure;
  /**
   * (D48) Distinct same-origin pages observed earlier in this run, each addressable by its
   * snapshot id for navigate_to_observed_url. Bounded; absent/empty ⇒ no trusted revisit
   * target exists, so the model must not attempt one.
   */
  observedPages?: ObservedPage[];
}

export interface DeciderResult {
  /** The raw tool input — validated by the harness, never trusted as-is. */
  rawDecision: unknown;
  /** Raw API usage, stored verbatim by the spine. */
  usage: RawUsage;
  latencyMs: number;
  model: string;
}

export interface Decider {
  decide(ctx: DecisionContext): Promise<DeciderResult>;
}

export const SYSTEM_PROMPT = [
  "You drive a real web browser to carry out ONE step of a test flow at a time.",
  "You are given the current step in plain English, the current page, the interactive",
  "elements from a FRESH accessibility snapshot (each with a stable ref like e5), and a",
  "summary of what you have already attempted in this step. Call the decide_next_step",
  "tool with exactly one of:",
  '  - action "click": click the element with the given ref.',
  '  - action "type": type the given value into the element with the given ref.',
  "  - step_complete: the step's requested action has been performed and the page",
  "    responded. A changed or navigated page — or the control you used no longer being",
  "    present because the action took effect — IS that response. This means an action",
  "    happened and a response was observed; it does NOT mean the result was correct. Do",
  "    not judge correctness — that is not your job.",
  "  - navigate_to_observed_url: revisit, as a FRESH visit, a page you ALREADY observed",
  "    earlier in this run. You name that page's snapshot id (from the observed-pages list",
  "    below) — you do NOT supply a URL; the harness reads the trusted same-origin URL from",
  "    that snapshot. Use this only when the step requires revisiting a created resource (for",
  "    example an order's own page) and no link on the current page provides that route. Only",
  "    ever name a snapshot id that appears in the observed-pages list; never invent one, and",
  "    never supply a URL. If no observed page provides the route, return blocked rather than",
  "    guess.",
  "  - blocked: a last resort; see the rule below.",
  "Before returning blocked, check both the current snapshot and the attempted-action",
  "history. If the requested action has already been performed, or the current page shows",
  "that the step is already satisfied, return step_complete. A step may already be",
  "complete at the beginning of a decision without requiring another action. Return",
  "blocked only when the step is not complete and no available permitted action can make",
  "further progress.",
  "Identify the step's main action verb and prefer an interactive control whose accessible",
  "name and role directly perform that action. Inputs such as textboxes, spinbuttons, and",
  "selectors may configure the action, but they do not usually complete it by themselves.",
  "Configure an auxiliary input at most once when needed, then activate the relevant",
  "primary control. If repeated interaction with one element is not advancing the step,",
  "reconsider the element's role and choose a different kind of control.",
  "A step is not restricted to the current page. If performing it requires a different",
  "page, navigate there (for example by clicking a link) — navigating is progress, not a",
  "reason to block.",
  "Rules: the ref MUST be one of the refs in the current snapshot — never invent a ref,",
  "a CSS selector, or an element that is not listed. Choose elements by their role and",
  "accessible name (intent), not by position. Do one atomic action per call; you receive",
  "a fresh snapshot after each.",
].join("\n");

export function buildUserMessage(ctx: DecisionContext): string {
  const lines: string[] = [];
  lines.push(`Step to perform: ${ctx.step.text}`);
  lines.push("");
  // (D48) The current page URL is sanitized to the SAME model-facing form as the observed-page
  // list — pathname + query-KEY names only; no origin, query values, fragment, or credentials —
  // so a secret in a navigated-to URL is never echoed back into the prompt.
  lines.push(
    `Current page: ${ctx.snapshot.pageTitle ?? "(untitled)"} (${ctx.snapshot.pageUrl ? observedDisplayPath(ctx.snapshot.pageUrl) : "unknown path"})`,
  );
  lines.push("");
  lines.push('Available elements (ref: role "name"):');
  for (const e of ctx.snapshot.elements) {
    lines.push(`  ${e.ref}: ${e.role}${e.name ? ` "${e.name}"` : ""}`);
  }
  lines.push("");
  if (ctx.attemptsInStep.length) {
    lines.push("Actions already attempted in this step (most recent last):");
    for (const a of ctx.attemptsInStep) {
      const parts = [`action=${a.action}`, `ref=${a.ref}`, `role=${a.role ?? "?"}`];
      if (a.name) parts.push(`name="${a.name}"`);
      if (a.value !== undefined) parts.push(`value=${a.value}`);
      if (a.observableEffect !== undefined) parts.push(`observableEffect=${a.observableEffect}`);
      lines.push(`  - ${parts.join(" ")}`);
    }
  } else {
    lines.push("No actions attempted yet in this step.");
  }
  if (ctx.observedPages && ctx.observedPages.length) {
    lines.push("");
    lines.push(
      "Observed pages you may revisit with navigate_to_observed_url (name the snapshot id, not a URL):",
    );
    for (const p of ctx.observedPages) {
      lines.push(`  ${p.snapshotId}: ${p.displayPath}${p.pageTitle ? ` (${p.pageTitle})` : ""}`);
    }
  }
  if (ctx.pageChangedSinceAction) {
    lines.push("");
    lines.push("Note: the page changed since your last action.");
  }
  if (ctx.correction) {
    lines.push("");
    lines.push(buildCorrectionNotice(ctx.correction, ctx.snapshot));
  }
  return lines.join("\n");
}

export interface AnthropicDeciderOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export class AnthropicDecider implements Decider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicDeciderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    // Headroom for bounded adaptive thinking + the single tool call.
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    const tools = [
      {
        name: DECISION_TOOL_NAME,
        description: DECISION_TOOL_DESCRIPTION,
        // ref enum steers the model to the current snapshot's refs (validation in
        // the harness stays authoritative).
        input_schema: buildDecisionToolSchema(ctx.snapshot.refs),
        // Strict tool use: the provider enforces the nested `decision` discriminated
        // union (const discriminators + complete required + additionalProperties:false),
        // rejecting malformed variants up front. parseDecision still re-validates.
        strict: DECISION_TOOL_STRICT,
      },
    ];
    const t0 = Date.now();
    // Bounded thinking (adaptive + low effort) so the model can reason about
    // multi-step sub-tasks; tool_choice "auto" (not forced) so thinking is allowed,
    // with parallel tool use disabled so it returns exactly one decision call. The
    // harness still requires a schema-valid decision (no tool call => schema error =>
    // one bounded correction). All ref-validation and guards are unchanged.
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tools: tools as Anthropic.Tool[],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: buildUserMessage(ctx) }],
    });
    const latencyMs = Date.now() - t0;
    const block = resp.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === DECISION_TOOL_NAME,
    );
    return {
      rawDecision: block?.input,
      usage: { ...(resp.usage as unknown as RawUsage) },
      latencyMs,
      model: this.model,
    };
  }
}
