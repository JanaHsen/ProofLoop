import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { ParsedSnapshot, parseSnapshot } from "../src/mcp/snapshot";
import type { ValidatedRef } from "../src/mcp/snapshot";
import type { ToolResult } from "../src/mcp/client";
import { BrowserActuator, runFlow } from "../src/engine/loop";
import type { Decider, DecisionContext, DeciderResult } from "../src/engine/decider";
import { DEFAULT_GUARDS, GuardConfig } from "../src/engine/guards";
import { readEvents, readManifest, verifyAuditChain } from "../src/run/audit";
import type { RunEvent } from "../src/run/schema";

const NOW = () => new Date("2026-06-18T00:00:00.000Z");
const USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function plan() {
  return parseFlow(
    "---\nname: T\nentry: /login\n---\n\n## Steps\n1. Sign in as alice.\n\n## Acceptance Criteria\n- ok.\n",
    "login",
  );
}

function loginSnap(): ParsedSnapshot {
  return parseSnapshot(
    '- generic [ref=e1]:\n  - textbox "Username" [ref=e5]\n  - textbox "Password" [ref=e7]\n  - button "Sign in" [ref=e8]',
    "### Page\n- Page URL: http://x/login\n- Page Title: Login",
  );
}
function snapWithPw(): ParsedSnapshot {
  return parseSnapshot(
    '- generic [ref=e1]:\n  - textbox "Password" [ref=e7]: password123\n  - button "Sign in" [ref=e8]',
    "",
  );
}
function changingSnap(n: number): ParsedSnapshot {
  return parseSnapshot(`- generic [ref=e1]:\n  - button "Sign in" [ref=e8]\n  - text: tick ${n}`, "");
}
function qtySnap(): ParsedSnapshot {
  return parseSnapshot(
    '- generic [ref=e1]:\n  - spinbutton "Qty" [ref=e34]\n  - button "Add to Cart" [ref=e35]',
    "### Page\n- Page URL: http://x/products",
  );
}

class MockDecider implements Decider {
  readonly seen: DecisionContext[] = [];
  constructor(private readonly script: (ctx: DecisionContext, call: number) => unknown) {}
  private calls = 0;
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    this.seen.push(ctx);
    const rawDecision = this.script(ctx, this.calls++);
    return { rawDecision, usage: { ...USAGE }, latencyMs: 5, model: "claude-sonnet-4-6" };
  }
}

class MockActuator implements BrowserActuator {
  readonly clicks: { ref: string; element: string }[] = [];
  readonly types: { ref: string; element: string; text: string }[] = [];
  private i = 0;
  constructor(private readonly snaps: (i: number) => ParsedSnapshot) {}
  async launch() {}
  async navigate() {}
  async snapshot() {
    return this.snaps(this.i++);
  }
  async clickRef(ref: ValidatedRef, element: string): Promise<ToolResult> {
    this.clicks.push({ ref, element });
    return { text: "ok", isError: false };
  }
  async typeRef(ref: ValidatedRef, element: string, text: string): Promise<ToolResult> {
    this.types.push({ ref, element, text });
    return { text: "ok", isError: false };
  }
  async close() {}
}

interface Outcome {
  manifest: ReturnType<typeof readManifest>;
  events: RunEvent[];
  runDir: string;
}

async function execute(
  decider: Decider,
  actuator: BrowserActuator,
  over: { guards?: Partial<GuardConfig>; signal?: AbortSignal } = {},
): Promise<{ out: Outcome; cleanup: () => void }> {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-loop-"));
  const cleanup = () => fs.rmSync(runsRoot, { recursive: true, force: true });
  try {
    const manifest = await runFlow({
      plan: plan(),
      baseUrl: "http://x",
      runId: "r",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      decider,
      actuator,
      guards: over.guards ? { ...DEFAULT_GUARDS, ...over.guards } : undefined,
      ...(over.signal ? { signal: over.signal } : {}),
      now: NOW,
    });
    const { events } = readEvents(path.join(runsRoot, "r", "events.jsonl"));
    return { out: { manifest, events, runDir: path.join(runsRoot, "r") }, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const types = (events: RunEvent[], t: string) => events.filter((e) => e.type === t);

test("happy path: click → step_complete completes and the audit chain verifies", async () => {
  const decider = new MockDecider((_c, call) =>
    call === 0
      ? { kind: "action", action: "click", ref: "e8", rationale: "submit" }
      : { kind: "step_complete", rationale: "submitted" },
  );
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    assert.equal(out.manifest.model, "claude-sonnet-4-6");
    assert.deepEqual(actuator.clicks.map((c) => c.ref), ["e8"]);
    assert.equal(types(out.events, "step_end").length, 1);
    const snapKinds = types(out.events, "snapshot").map((e) => (e as { kind: string }).kind);
    assert.ok(snapKinds.includes("pre_action") && snapKinds.includes("step_boundary") && snapKinds.includes("terminal"));
    assert.equal(verifyAuditChain(out.runDir).ok, true);
  } finally {
    cleanup();
  }
});

test("redaction: typed password value is redacted in events AND stored snapshots, but typed for real", async () => {
  const decider = new MockDecider((_c, call) =>
    call === 0
      ? { kind: "action", action: "type", ref: "e7", value: "password123", rationale: 'typing "password123" now' }
      : { kind: "step_complete", rationale: "entered password123 successfully" },
  );
  // first snapshot has no value (field empty); after typing, the value shows up
  const actuator = new MockActuator((i) => (i === 0 ? loginSnap() : snapWithPw()));
  const { out, cleanup } = await execute(decider, actuator);
  try {
    // the real value reaches the browser
    assert.deepEqual(actuator.types.map((t) => t.text), ["password123"]);
    // but the logged decision + action values are redacted
    const decision = (types(out.events, "llm_decision")[0] as { decision: { value?: unknown; rationale: string } }).decision;
    assert.deepEqual(decision.value, { value: "[REDACTED]", valueLength: 11, sensitive: true });
    const action = types(out.events, "action")[0] as { value?: unknown };
    assert.deepEqual(action.value, { value: "[REDACTED]", valueLength: 11, sensitive: true });
    // the model's rationale must NOT leak the secret in clear text
    for (const ev of types(out.events, "llm_decision") as { decision: { rationale?: string } }[]) {
      assert.ok(!(ev.decision.rationale ?? "").includes("password123"), "rationale must be scrubbed");
    }
    assert.ok(decision.rationale.includes("[REDACTED]"));
    // snapshots stored AFTER the value is known are scrubbed on disk
    const after = types(out.events, "snapshot").filter((e, idx) => idx > 0) as { path: string }[];
    for (const ev of after) {
      const blob = fs.readFileSync(path.join(out.runDir, ev.path), "utf8");
      assert.ok(!blob.includes("password123"), "stored snapshot must not contain the secret");
      assert.ok(blob.includes("[REDACTED]"));
    }
  } finally {
    cleanup();
  }
});

test("guard: no-progress trips when the page never changes", async () => {
  // alternate refs so the repeat-backstop (identical action) doesn't preempt — this
  // exercises no-progress on DIFFERENT no-effect actions
  const decider = new MockDecider((_c, call) => ({ kind: "action", action: "click", ref: call % 2 === 0 ? "e5" : "e8", rationale: "x" }));
  const actuator = new MockActuator(() => loginSnap()); // identical every time
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "guard_tripped");
    assert.equal((types(out.events, "guard_tripped")[0] as { reason: string }).reason, "NO_PROGRESS");
  } finally {
    cleanup();
  }
});

test("guard: max actions/step trips (page changes each time, so not no-progress)", async () => {
  const decider = new MockDecider(() => ({ kind: "action", action: "click", ref: "e8", rationale: "x" }));
  const actuator = new MockActuator((i) => changingSnap(i));
  const { out, cleanup } = await execute(decider, actuator, { guards: { maxActionsPerStep: 2 } });
  try {
    assert.equal(out.manifest.executionStatus, "guard_tripped");
    assert.equal((types(out.events, "guard_tripped")[0] as { reason: string }).reason, "MAX_ACTIONS_PER_STEP");
    assert.equal(out.manifest.totals.actionCount, 2);
  } finally {
    cleanup();
  }
});

test("guard: max LLM calls/step trips", async () => {
  const decider = new MockDecider(() => ({ kind: "action", action: "click", ref: "e8", rationale: "x" }));
  const actuator = new MockActuator((i) => changingSnap(i));
  const { out, cleanup } = await execute(decider, actuator, { guards: { maxLlmCallsPerStep: 2 } });
  try {
    assert.equal(out.manifest.executionStatus, "guard_tripped");
    assert.equal((types(out.events, "guard_tripped")[0] as { reason: string }).reason, "MAX_LLM_CALLS_PER_STEP");
  } finally {
    cleanup();
  }
});

test("invalid ref: one informed correction, then execution error", async () => {
  const decider = new MockDecider(() => ({ kind: "action", action: "click", ref: "e999", rationale: "x" }));
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "error");
    assert.equal(types(out.events, "action").filter((e) => (e as { status: string }).status === "rejected").length, 2);
    assert.equal(types(out.events, "error").filter((e) => (e as { code: string }).code === "INVALID_SNAPSHOT_REF").length, 2);
    assert.equal(types(out.events, "retry").length, 1);
  } finally {
    cleanup();
  }
});

test("invalid ref then valid ref: correction recovers and completes", async () => {
  const decider = new MockDecider((_c, call) =>
    call === 0
      ? { kind: "action", action: "click", ref: "e999", rationale: "wrong" }
      : call === 1
        ? { kind: "action", action: "click", ref: "e8", rationale: "right" }
        : { kind: "step_complete", rationale: "done" },
  );
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    const acts = types(out.events, "action") as { status: string; ref: string }[];
    assert.deepEqual(acts.map((a) => `${a.status}:${a.ref}`), ["rejected:e999", "executed:e8"]);
    const corrected = types(out.events, "llm_decision").filter((e) => (e as { correction?: boolean }).correction);
    assert.equal(corrected.length, 1);
  } finally {
    cleanup();
  }
});

test("schema-invalid: one correction then error; tokens still accounted in totals", async () => {
  const decider = new MockDecider(() => ({})); // no kind
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "error");
    assert.equal(types(out.events, "error").filter((e) => (e as { code: string }).code === "SCHEMA_INVALID").length, 2);
    assert.equal(types(out.events, "llm_decision").length, 0);
    // tokens accrued via addTotals even with no llm_decision events (2 decider calls)
    assert.equal(out.manifest.totals.promptTokens, 200);
  } finally {
    cleanup();
  }
});

test("blocked decision stops with executionStatus blocked", async () => {
  const decider = new MockDecider(() => ({ kind: "blocked", reason: "no sign-in control" }));
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "blocked");
  } finally {
    cleanup();
  }
});

test("cancellation: an aborted signal stops with executionStatus cancelled", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const decider = new MockDecider(() => ({ kind: "action", action: "click", ref: "e8", rationale: "x" }));
  const actuator = new MockActuator(() => loginSnap());
  const { out, cleanup } = await execute(decider, actuator, { signal: ctrl.signal });
  try {
    assert.equal(out.manifest.executionStatus, "cancelled");
    assert.equal((types(out.events, "guard_tripped")[0] as { reason: string }).reason, "CANCELLED");
  } finally {
    cleanup();
  }
});

test("backstop: a repeated no-effect action is rejected before MCP (executed once), then redirects", async () => {
  // type e34 "2" (executes), type e34 "2" again with no page change (must be rejected), then complete
  const decider = new MockDecider((_c, call) =>
    call === 0
      ? { kind: "action", action: "type", ref: "e34", value: "2", rationale: "set qty" }
      : call === 1
        ? { kind: "action", action: "type", ref: "e34", value: "2", rationale: "set qty again" }
        : { kind: "step_complete", rationale: "done" },
  );
  const actuator = new MockActuator(() => qtySnap()); // identical snapshot every time => no effect
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    // the no-effect action was EXECUTED exactly once; the repeat never reached MCP
    assert.equal(actuator.types.filter((t) => t.ref === "e34").length, 1);
    assert.equal(types(out.events, "error").filter((e) => (e as { code: string }).code === "REPEATED_NO_EFFECT").length, 1);
    assert.ok(types(out.events, "retry").length >= 1);
  } finally {
    cleanup();
  }
});

test("backstop: insisting on the same no-effect action after correction stops with error", async () => {
  const decider = new MockDecider(() => ({ kind: "action", action: "type", ref: "e34", value: "2", rationale: "set qty" }));
  const actuator = new MockActuator(() => qtySnap());
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "error");
    assert.equal(actuator.types.filter((t) => t.ref === "e34").length, 1); // executed once only
    assert.ok(types(out.events, "error").filter((e) => (e as { code: string }).code === "REPEATED_NO_EFFECT").length >= 1);
  } finally {
    cleanup();
  }
});

test("recognition: after an effective action, the next decision is given observableEffect=true", async () => {
  // click changes the page; the harness must surface "it worked" so the model can complete
  const decider = new MockDecider((_c, call) =>
    call === 0 ? { kind: "action", action: "click", ref: "e8", rationale: "do it" } : { kind: "step_complete", rationale: "done" },
  );
  const actuator = new MockActuator((i) =>
    parseSnapshot(`- generic [ref=e1]:\n  - button "Go" [ref=e8]\n  - text: state ${i}`, "### Page\n- Page URL: http://x/p"),
  );
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    const completing = decider.seen[1]; // the step_complete decision's context
    assert.equal(completing.pageChangedSinceAction, true);
    assert.equal(completing.attemptsInStep.at(-1)?.observableEffect, true);
  } finally {
    cleanup();
  }
});

test("recognition: an already-satisfied step completes without an unnecessary action", async () => {
  // 2-step plan; step 2's goal is already met on arrival (like being on /cart already),
  // so the model returns step_complete immediately and the loop performs no action
  const plan2 = parseFlow(
    "---\nname: T\nentry: /x\n---\n\n## Steps\n1. Click go.\n2. Confirm the result.\n\n## Acceptance Criteria\n- ok.\n",
    "t",
  );
  const decider = new MockDecider((ctx, call) =>
    ctx.step.ordinal === 1
      ? call === 0
        ? { kind: "action", action: "click", ref: "e8", rationale: "go" }
        : { kind: "step_complete", rationale: "clicked" }
      : { kind: "step_complete", rationale: "already satisfied" },
  );
  const actuator = new MockActuator((i) => parseSnapshot(`- generic [ref=e1]:\n  - button "Go" [ref=e8]\n  - text: s ${i}`, ""));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-loop-"));
  try {
    const manifest = await runFlow({
      plan: plan2,
      baseUrl: "http://x",
      runId: "r",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      decider,
      actuator,
      now: NOW,
    });
    assert.equal(manifest.executionStatus, "completed");
    const { events } = readEvents(path.join(runsRoot, "r", "events.jsonl"));
    const step2Actions = events.filter((e) => e.type === "action" && (e as { stepId?: string }).stepId === "t:S2");
    assert.equal(step2Actions.length, 0); // step 2 completed with NO unnecessary action
    assert.equal(events.filter((e) => e.type === "step_end").length, 2);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("legitimate repeat is allowed: same control, but the page changes each time", async () => {
  // clicking "Add to Cart" twice — each click changes the page (cart count) => not a no-effect repeat
  const decider = new MockDecider((_c, call) =>
    call < 2 ? { kind: "action", action: "click", ref: "e35", rationale: "add to cart" } : { kind: "step_complete", rationale: "added twice" },
  );
  const actuator = new MockActuator((i) =>
    parseSnapshot(`- generic [ref=e1]:\n  - button "Add to Cart" [ref=e35]\n  - text: cart ${i}`, ""),
  );
  const { out, cleanup } = await execute(decider, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    // both clicks executed — the backstop did NOT block the legitimate repeat
    assert.equal((out.events.filter((e) => e.type === "action" && (e as { ref: string }).ref === "e35" && (e as { status: string }).status === "executed")).length, 2);
    assert.equal(types(out.events, "error").length, 0);
  } finally {
    cleanup();
  }
});
