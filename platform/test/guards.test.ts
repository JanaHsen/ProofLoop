import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GUARDS,
  GuardConfig,
  GuardTracker,
  normalizeForProgress,
  progressKey,
} from "../src/engine/guards";

function cfg(over: Partial<GuardConfig> = {}): GuardConfig {
  return { ...DEFAULT_GUARDS, ...over };
}

const NO_USAGE = { promptTokens: 0, completionTokens: 0 };

test("guard trips: max actions per step", () => {
  const g = new GuardTracker(cfg({ maxActionsPerStep: 2 }));
  g.beginFlow();
  g.beginStep();
  assert.equal(g.beforeAction(), null);
  g.recordAction();
  g.recordAction();
  assert.equal(g.beforeAction()?.reason, "MAX_ACTIONS_PER_STEP");
});

test("guard trips: max actions per flow across steps", () => {
  const g = new GuardTracker(cfg({ maxActionsPerStep: 100, maxActionsPerFlow: 3 }));
  g.beginFlow();
  g.beginStep();
  g.recordAction();
  g.recordAction();
  g.beginStep(); // new step does not reset the flow counter
  g.recordAction();
  assert.equal(g.beforeAction()?.reason, "MAX_ACTIONS_PER_FLOW");
});

test("guard trips: max LLM calls per step and per flow", () => {
  const perStep = new GuardTracker(cfg({ maxLlmCallsPerStep: 2 }));
  perStep.beginFlow();
  perStep.beginStep();
  perStep.recordDecision(NO_USAGE, 0);
  perStep.recordDecision(NO_USAGE, 0);
  assert.equal(perStep.beforeDecision()?.reason, "MAX_LLM_CALLS_PER_STEP");

  const perFlow = new GuardTracker(cfg({ maxLlmCallsPerStep: 100, maxLlmCallsPerFlow: 2 }));
  perFlow.beginFlow();
  perFlow.beginStep();
  perFlow.recordDecision(NO_USAGE, 0);
  perFlow.beginStep();
  perFlow.recordDecision(NO_USAGE, 0);
  assert.equal(perFlow.beforeDecision()?.reason, "MAX_LLM_CALLS_PER_FLOW");
});

test("guard trips: wall clock (deterministic fake clock)", () => {
  let t = 1000;
  const g = new GuardTracker(cfg({ wallClockMsPerFlow: 5000 }), () => t);
  g.beginFlow(); // flowStart = 1000
  g.beginStep();
  assert.equal(g.beforeDecision(), null);
  t = 6500; // elapsed 5500 > 5000
  assert.equal(g.beforeDecision()?.reason, "WALL_CLOCK");
});

test("guard trips: token and cost ceilings", () => {
  const tok = new GuardTracker(cfg({ promptTokenCeilingPerFlow: 100, completionTokenCeilingPerFlow: 100 }));
  tok.beginFlow();
  tok.beginStep();
  tok.recordDecision({ promptTokens: 150, completionTokens: 0 }, 0);
  assert.equal(tok.beforeDecision()?.reason, "PROMPT_TOKENS");

  const comp = new GuardTracker(cfg({ promptTokenCeilingPerFlow: 1e9, completionTokenCeilingPerFlow: 50 }));
  comp.beginFlow();
  comp.beginStep();
  comp.recordDecision({ promptTokens: 0, completionTokens: 80 }, 0);
  assert.equal(comp.beforeDecision()?.reason, "COMPLETION_TOKENS");

  const cost = new GuardTracker(cfg({ costCeilingUsdPerFlow: 0.5 }));
  cost.beginFlow();
  cost.beginStep();
  cost.recordDecision(NO_USAGE, 0.75);
  assert.equal(cost.beforeDecision()?.reason, "COST");
});

test("guard trips: no-progress after K unchanged actions", () => {
  const g = new GuardTracker(cfg({ maxNoProgressActions: 3 }));
  g.beginFlow();
  g.beginStep();
  assert.equal(g.recordProgress("k", "k"), null); // 1
  assert.equal(g.recordProgress("k", "k"), null); // 2
  assert.equal(g.recordProgress("k", "k")?.reason, "NO_PROGRESS"); // 3
});

test("no-progress: a state change resets the streak (add-twice is not a false trip)", () => {
  const g = new GuardTracker(cfg({ maxNoProgressActions: 2 }));
  g.beginFlow();
  g.beginStep();
  // first add: cart 0 -> 1, page changes => progress, streak stays 0
  assert.equal(g.recordProgress("cart0", "cart1"), null);
  // second add of the same item: cart 1 -> 2, page changes again => still progress
  assert.equal(g.recordProgress("cart1", "cart2"), null);
  // only genuinely stuck (unchanged) actions accumulate
  assert.equal(g.recordProgress("cart2", "cart2"), null); // streak 1
  assert.equal(g.recordProgress("cart2", "cart2")?.reason, "NO_PROGRESS"); // streak 2
});

test("guard trips: cancellation before decision and action", () => {
  const g = new GuardTracker(cfg());
  g.beginFlow();
  g.beginStep();
  g.cancel();
  assert.equal(g.beforeDecision()?.reason, "CANCELLED");
  assert.equal(g.beforeAction()?.reason, "CANCELLED");
});

test("progressKey ignores volatile bits (refs/active/cursor), not content", () => {
  const a = '- generic [active] [ref=e1]:\n  - button "Add" [ref=e8] [cursor=pointer]';
  const b = '- generic [ref=e7]:\n  - button "Add" [ref=e3]'; // renumbered refs, no focus/cursor
  assert.equal(progressKey(a), progressKey(b));
  const changed = '- generic [ref=e1]:\n  - button "Remove" [ref=e8]';
  assert.notEqual(progressKey(a), progressKey(changed));
  // normalization strips the volatile tokens it claims to
  assert.ok(!/\[ref=|\[active\]|\[cursor=/.test(normalizeForProgress(a)));
});

test("totals accumulate for the manifest", () => {
  const g = new GuardTracker(cfg());
  g.beginFlow();
  g.beginStep();
  g.recordDecision({ promptTokens: 10, completionTokens: 2 }, 0.01);
  g.recordAction();
  assert.deepEqual(g.totals(), {
    actions: 1,
    llmCalls: 1,
    promptTokens: 10,
    completionTokens: 2,
    costUsd: 0.01,
  });
});
