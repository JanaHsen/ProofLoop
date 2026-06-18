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
  DecisionFailure,
  buildCorrectionNotice,
  buildDecisionToolSchema,
} from "./protocol";

export interface AttemptSummary {
  action: "click" | "type";
  ref: string;
  role?: string;
  name?: string;
  ok: boolean;
}

export interface DecisionContext {
  step: FlowStep;
  snapshot: ParsedSnapshot;
  /** Bounded summary of actions already attempted in THIS step. */
  attemptsInStep: AttemptSummary[];
  /** Present only on the single informed correction re-ask. */
  correction?: DecisionFailure;
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

const SYSTEM_PROMPT = [
  "You drive a real web browser to carry out ONE step of a test flow at a time.",
  "You are given the current step in plain English, the current page, and the",
  "interactive elements from a FRESH accessibility snapshot (each with a stable ref",
  "like e5). Call the decide_next_step tool with exactly one of:",
  '  - action "click": click the element with the given ref.',
  '  - action "type": type the given value into the element with the given ref.',
  "  - step_complete: the step's requested action has been performed and the page",
  "    responded. This means an action happened and a response was observed — it does",
  "    NOT mean the result was correct. Do not judge correctness.",
  "  - blocked: the step genuinely cannot proceed (no suitable element exists).",
  "Rules: the ref MUST be one of the refs in the current snapshot — never invent a ref,",
  "a CSS selector, or an element that is not listed. Choose elements by their role and",
  "accessible name (intent), not by position. Do one atomic action per call; you receive",
  "a fresh snapshot after each.",
].join("\n");

function buildUserMessage(ctx: DecisionContext): string {
  const lines: string[] = [];
  lines.push(`Step to perform: ${ctx.step.text}`);
  lines.push("");
  lines.push(
    `Current page: ${ctx.snapshot.pageTitle ?? "(untitled)"} (${ctx.snapshot.pageUrl ?? "unknown URL"})`,
  );
  lines.push("");
  lines.push('Available elements (ref: role "name"):');
  for (const e of ctx.snapshot.elements) {
    lines.push(`  ${e.ref}: ${e.role}${e.name ? ` "${e.name}"` : ""}`);
  }
  lines.push("");
  if (ctx.attemptsInStep.length) {
    lines.push("Actions already attempted in this step:");
    for (const a of ctx.attemptsInStep) {
      lines.push(
        `  ${a.action} ${a.ref}${a.name ? ` ("${a.name}")` : ""} -> ${a.ok ? "ok" : "error"}`,
      );
    }
  } else {
    lines.push("No actions attempted yet in this step.");
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
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    const tools = [
      {
        name: DECISION_TOOL_NAME,
        description: DECISION_TOOL_DESCRIPTION,
        // ref enum steers the model to the current snapshot's refs (validation in
        // the harness stays authoritative).
        input_schema: buildDecisionToolSchema(ctx.snapshot.refs),
      },
    ];
    const t0 = Date.now();
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      tools: tools as Anthropic.Tool[],
      tool_choice: { type: "tool", name: DECISION_TOOL_NAME },
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
