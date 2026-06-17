/**
 * Bounded guard contract (Task 3 freeze) — what stands between a demo and a bill.
 * Deterministic counters/limits around the one non-deterministic component (the LLM).
 * The guards are RUNAWAY BACKSTOPS, not behavior judges: a legitimately dead control
 * on a buggy app is Phase 3's FAIL to issue, never a guard's job to "catch".
 */

import { createHash } from "node:crypto";

export interface GuardConfig {
  maxActionsPerStep: number;
  maxActionsPerFlow: number;
  maxLlmCallsPerStep: number;
  maxLlmCallsPerFlow: number;
  wallClockMsPerFlow: number;
  /** Consecutive no-progress actions (post-action progress key unchanged) before tripping. */
  maxNoProgressActions: number;
  /** PROVISIONAL — reconciled at Task 4 (pricing) + Task 5 (model). See note below. */
  promptTokenCeilingPerFlow: number;
  /** PROVISIONAL. */
  completionTokenCeilingPerFlow: number;
  /** PROVISIONAL — kept generous so the Phase 2 gate flows cannot false-trip on cost. */
  costCeilingUsdPerFlow: number;
  /** True while the token/cost ceilings are provisional (not yet reconciled). */
  ceilingsProvisional: boolean;
}

/**
 * Starting values (tunable, not sacred). The action/LLM-call/wall-clock backstops are
 * sized so the login + add-to-cart gate flows have ample headroom. The token and cost
 * ceilings are PROVISIONAL: at a Sonnet-class input price, 400k prompt tokens is
 * already ~$1.20 — above any tight cost ceiling — and snapshots are re-sent every
 * call, so prompt tokens accumulate fast. The cost ceiling is therefore kept generous
 * ($5) so neither gate flow false-trips; cost and token ceilings get reconciled to one
 * real budget once the Task 5 model and Task 4 pricing are fixed.
 */
export const DEFAULT_GUARDS: GuardConfig = {
  maxActionsPerStep: 8,
  maxActionsPerFlow: 40,
  maxLlmCallsPerStep: 12,
  maxLlmCallsPerFlow: 60,
  wallClockMsPerFlow: 300_000,
  maxNoProgressActions: 3,
  promptTokenCeilingPerFlow: 400_000,
  completionTokenCeilingPerFlow: 40_000,
  costCeilingUsdPerFlow: 5.0,
  ceilingsProvisional: true,
};

export type GuardTripReason =
  | "MAX_ACTIONS_PER_STEP"
  | "MAX_ACTIONS_PER_FLOW"
  | "MAX_LLM_CALLS_PER_STEP"
  | "MAX_LLM_CALLS_PER_FLOW"
  | "WALL_CLOCK"
  | "NO_PROGRESS"
  | "PROMPT_TOKENS"
  | "COMPLETION_TOKENS"
  | "COST"
  | "CANCELLED";

export interface GuardTrip {
  reason: GuardTripReason;
  detail: string;
}

// --- no-progress key: a STRUCTURAL fingerprint, distinct from the audit digest ----
//
// The audit-chain digest (snapshot.ts) hashes the raw YAML EXACTLY — integrity must be
// bit-for-bit. The no-progress key instead hashes a NORMALIZED snapshot with volatile
// bits removed, so the guard fires on genuine "nothing changed" rather than being
// defeated by per-snapshot churn:
//   - [ref=eN]   ref numbering is reassigned per snapshot
//   - [active]   focus state
//   - [cursor=…] cursor hints
// If an app embeds per-request volatile content the snapshot still exposes (a rendered
// token, a clock), keys will differ every call and this guard silently degrades to the
// action / LLM-call / wall-clock backstops — still safe, just weaker. That is acceptable
// for a runaway backstop; it is never the thing asserting app behavior.

export function normalizeForProgress(yaml: string): string {
  return yaml
    .replace(/\s*\[ref=e\d+\]/g, "")
    .replace(/\s*\[active\]/g, "")
    .replace(/\s*\[cursor=[^\]]*\]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .trim();
}

export function progressKey(yaml: string): string {
  return "sha256:" + createHash("sha256").update(normalizeForProgress(yaml), "utf8").digest("hex");
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Tracks guard state for one flow run. The loop (Task 5) calls beforeDecision/
 * recordDecision/beforeAction/recordAction/recordProgress at the points named in the
 * protocol loop; each check returns a GuardTrip or null. `now` is injectable so the
 * wall-clock guard is deterministically testable.
 */
export class GuardTracker {
  private readonly cfg: GuardConfig;
  private readonly now: () => number;

  private flowStartMs = 0;
  private flowActions = 0;
  private flowLlmCalls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private costUsd = 0;
  private cancelled = false;

  private stepActions = 0;
  private stepLlmCalls = 0;
  private noProgressStreak = 0;

  constructor(cfg: GuardConfig = DEFAULT_GUARDS, now: () => number = () => Date.now()) {
    this.cfg = cfg;
    this.now = now;
  }

  beginFlow(): void {
    this.flowStartMs = this.now();
    this.flowActions = 0;
    this.flowLlmCalls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.costUsd = 0;
    this.cancelled = false;
  }

  beginStep(): void {
    this.stepActions = 0;
    this.stepLlmCalls = 0;
    this.noProgressStreak = 0;
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** Checked before each LLM decision request. */
  beforeDecision(): GuardTrip | null {
    if (this.cancelled) return { reason: "CANCELLED", detail: "run cancelled" };
    const elapsed = this.now() - this.flowStartMs;
    if (elapsed > this.cfg.wallClockMsPerFlow) {
      return { reason: "WALL_CLOCK", detail: `${elapsed}ms > ${this.cfg.wallClockMsPerFlow}ms` };
    }
    if (this.stepLlmCalls >= this.cfg.maxLlmCallsPerStep) {
      return { reason: "MAX_LLM_CALLS_PER_STEP", detail: `${this.stepLlmCalls} >= ${this.cfg.maxLlmCallsPerStep}` };
    }
    if (this.flowLlmCalls >= this.cfg.maxLlmCallsPerFlow) {
      return { reason: "MAX_LLM_CALLS_PER_FLOW", detail: `${this.flowLlmCalls} >= ${this.cfg.maxLlmCallsPerFlow}` };
    }
    if (this.promptTokens >= this.cfg.promptTokenCeilingPerFlow) {
      return { reason: "PROMPT_TOKENS", detail: `${this.promptTokens} >= ${this.cfg.promptTokenCeilingPerFlow}` };
    }
    if (this.completionTokens >= this.cfg.completionTokenCeilingPerFlow) {
      return { reason: "COMPLETION_TOKENS", detail: `${this.completionTokens} >= ${this.cfg.completionTokenCeilingPerFlow}` };
    }
    if (this.costUsd >= this.cfg.costCeilingUsdPerFlow) {
      return { reason: "COST", detail: `$${this.costUsd.toFixed(4)} >= $${this.cfg.costCeilingUsdPerFlow}` };
    }
    return null;
  }

  recordDecision(usage: TokenUsage, costUsd: number): void {
    this.stepLlmCalls += 1;
    this.flowLlmCalls += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.costUsd += costUsd;
  }

  /** Checked before dispatching a validated action. */
  beforeAction(): GuardTrip | null {
    if (this.cancelled) return { reason: "CANCELLED", detail: "run cancelled" };
    if (this.stepActions >= this.cfg.maxActionsPerStep) {
      return { reason: "MAX_ACTIONS_PER_STEP", detail: `${this.stepActions} >= ${this.cfg.maxActionsPerStep}` };
    }
    if (this.flowActions >= this.cfg.maxActionsPerFlow) {
      return { reason: "MAX_ACTIONS_PER_FLOW", detail: `${this.flowActions} >= ${this.cfg.maxActionsPerFlow}` };
    }
    return null;
  }

  recordAction(): void {
    this.stepActions += 1;
    this.flowActions += 1;
  }

  /**
   * Compare the page state before and after an executed action. Equal progress keys
   * mean the action changed nothing observable; K consecutive such actions trip. A
   * change (e.g. cart qty 1→2 on a legitimate repeated add) resets the streak — so
   * "add the same item twice" never false-trips.
   */
  recordProgress(preKey: string, postKey: string): GuardTrip | null {
    if (preKey === postKey) this.noProgressStreak += 1;
    else this.noProgressStreak = 0;
    if (this.noProgressStreak >= this.cfg.maxNoProgressActions) {
      return {
        reason: "NO_PROGRESS",
        detail: `${this.noProgressStreak} consecutive actions changed nothing`,
      };
    }
    return null;
  }

  /** Snapshot of accumulated totals (for the run manifest in Task 4/5). */
  totals(): {
    actions: number;
    llmCalls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } {
    return {
      actions: this.flowActions,
      llmCalls: this.flowLlmCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      costUsd: this.costUsd,
    };
  }
}
