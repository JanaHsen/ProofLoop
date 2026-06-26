/**
 * (D48) Offline proof that trusted observed-URL navigation closes the G4 checkout:C3 gap.
 *
 * Drives the REAL, UNCHANGED checkout flow through runFlow with a mock decider + an
 * order-page mock actuator. The revisit step (S4) selects the order page's OWN observed
 * snapshot and navigates to its stored URL — so S4 COMPLETES instead of becoming blocked.
 * Because S4 completes, the existing deterministic evidence resolver hands checkout:C3 the
 * "pinned" ≤-checkpoint window, which already includes every step boundary up to S4 — i.e.
 * BOTH the order-placement boundary (S3) and the post-revisit boundary (S4). No resolver
 * change is required; the non-completing window is never touched. No live model/browser/SUT.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { ParsedSnapshot, parseSnapshot, ValidatedRef } from "../src/mcp/snapshot";
import type { ToolResult } from "../src/mcp/client";
import { browserConfigFor } from "../src/mcp/client";
import { BrowserActuator, runFlow } from "../src/engine/loop";
import type { Decider, DecisionContext, DeciderResult, ObservedPage } from "../src/engine/decider";
import { readEvents } from "../src/run/audit";
import { resolveEvidence } from "../src/verify/resolver";
import type { RunEvent, NavigationEvent } from "../src/run/schema";

const NOW = () => new Date("2026-06-25T00:00:00.000Z");
const ORIGIN = "http://localhost:3000";
const ORDER_URL = `${ORIGIN}/order/O-00001`;
const MODE_META = {
  mode: "headless" as const,
  requestedMode: "headless" as const,
  browser: browserConfigFor("desktop"),
};
const USAGE = { input_tokens: 60, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const CHECKOUT_FLOW = path.join(__dirname, "..", "..", "fixtures", "flows", "checkout.flow.md");

/** The order-confirmation page as a real accessibility snapshot, at the order's own URL. */
function orderPage(): ParsedSnapshot {
  return parseSnapshot(
    [
      "- generic [ref=e1]:",
      '  - heading "Order placed" [ref=e13]',
      '  - paragraph [ref=e14]:',
      "    - text: Thank you. Your order",
      '    - strong [ref=e15]: O-00001',
      "    - text: has been recorded.",
      '  - row "Total $58.97" [ref=e41]:',
      '    - cell "Total" [ref=e42]',
      '    - cell "$58.97" [ref=e44]',
    ].join("\n"),
    `### Page\n- Page URL: ${ORDER_URL}\n- Page Title: Order O-00001`,
  );
}

class OrderPageActuator implements BrowserActuator {
  readonly navigations: string[] = [];
  async launch() {}
  async navigate(url: string) {
    this.navigations.push(url);
  }
  async snapshot() {
    return orderPage();
  }
  async clickRef(_ref: ValidatedRef): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async typeRef(): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async close() {}
}

/**
 * S1–S3: the order page is already shown, so each step is complete on first look. S4: revisit
 * the order's own page by selecting its OBSERVED snapshot, then complete once it has loaded.
 */
class CheckoutDecider implements Decider {
  private navigated = false;
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    let inner: unknown;
    if (ctx.step.ordinal < 4) {
      inner = { kind: "step_complete", rationale: "the order page is already shown" };
    } else if (!this.navigated) {
      this.navigated = true;
      const order = (ctx.observedPages ?? []).find((p: ObservedPage) => p.displayPath === "/order/O-00001");
      assert.ok(order, "the order page must be offered as an observed revisit target on S4");
      inner = { kind: "navigate_to_observed_url", snapshotId: order!.snapshotId, rationale: "revisit the order's own page" };
    } else {
      inner = { kind: "step_complete", rationale: "the order is retrievable on a fresh visit" };
    }
    return { rawDecision: { decision: inner }, usage: { ...USAGE }, latencyMs: 4, model: "claude-sonnet-4-6" };
  }
}

test("checkout:C3 — observed-URL revisit completes S4 and the resolver hands C3 BOTH placement and revisit evidence", async () => {
  const planText = fs.readFileSync(CHECKOUT_FLOW, "utf8");
  const plan = parseFlow(planText, "checkout");

  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-checkout-revisit-"));
  const runId = "checkout-revisit-run";
  try {
    const actuator = new OrderPageActuator();
    const manifest = await runFlow({
      plan,
      baseUrl: ORIGIN,
      runId,
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      ...MODE_META,
      decider: new CheckoutDecider(),
      actuator,
      now: NOW,
    });

    const runDir = path.join(runsRoot, runId);
    const { events } = readEvents(path.join(runDir, "events.jsonl"));

    // 1–4. S4 completed (not blocked); a real navigation to the stored order URL occurred,
    //      and a fresh post-navigation snapshot was captured.
    assert.equal(manifest.executionStatus, "completed");
    const s4End = events.find((e) => e.type === "step_end" && e.stepId === "checkout:S4");
    assert.ok(s4End, "S4 must complete, not block");
    const nav = events.find((e): e is NavigationEvent => e.type === "navigation");
    assert.ok(nav && nav.status === "executed", "a trusted navigation must have executed");
    assert.equal(nav!.resolvedUrl, ORDER_URL);
    assert.equal(nav!.finalUrl, ORDER_URL);
    assert.ok(nav!.resultingSnapshotId, "post-navigation snapshot id must be recorded");
    // the navigation's source is a genuine earlier order-page snapshot from THIS run
    const sourceSnap = events.find(
      (e): e is RunEvent & { type: "snapshot"; snapshotId: string; pageUrl?: string } =>
        e.type === "snapshot" && (e as any).snapshotId === nav!.sourceSnapshotId,
    );
    assert.ok(sourceSnap && sourceSnap.pageUrl === ORDER_URL);

    // 5–6. checkout:C3 now resolves to a COMPLETING (pinned) window containing BOTH the
    //      order-placement boundary (S3) and the post-revisit boundary (S4) — the two states
    //      the equality-over-revisit criterion must compare.
    const resolved = resolveEvidence(plan, runDir);
    const c3 = resolved.find((r) => r.criterionId === "checkout:C3");
    assert.ok(c3, "checkout:C3 must resolve");
    assert.ok(c3!.evidence, "C3 must have an evidence window, not a short-circuit");
    assert.equal(c3!.evidence!.windowKind, "pinned");

    const boundaryStepIds = c3!.evidence!.snapshots.map((s) => s.stepId);
    assert.ok(boundaryStepIds.includes("checkout:S3"), "placement boundary (S3) must be in C3's window");
    assert.ok(boundaryStepIds.includes("checkout:S4"), "revisit boundary (S4) must be in C3's window");
    const orderBoundaries = c3!.evidence!.snapshots.filter((s) => s.pageUrl === ORDER_URL);
    assert.ok(orderBoundaries.length >= 2, "both order-page states must be available to compare");

    // No short-circuit / non-completing path was used; the fix is the COMPLETING step, not a
    // broadened window.
    assert.equal(c3!.shortCircuit, undefined);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

/**
 * (D48 bounded navigation) Replays the live checkout:S4 loop: the model proposes the SAME
 * order-page revisit twice. The first executes; the second is a no-effect repeat and is rejected
 * before the browser; the correction lets S4 step_complete instead of looping to MAX_ACTIONS.
 */
class CheckoutLoopDecider implements Decider {
  private s4 = 0;
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    let inner: unknown;
    if (ctx.step.ordinal < 4) {
      inner = { kind: "step_complete", rationale: "the order page is already shown" };
    } else {
      this.s4 += 1;
      const order = (ctx.observedPages ?? []).find((p: ObservedPage) => p.displayPath === "/order/O-00001");
      inner =
        this.s4 <= 2 && order
          ? { kind: "navigate_to_observed_url", snapshotId: order.snapshotId, rationale: "revisit the order" }
          : { kind: "step_complete", rationale: "the order is still retrievable" };
    }
    return { rawDecision: { decision: inner }, usage: { ...USAGE }, latencyMs: 4, model: "claude-sonnet-4-6" };
  }
}

test("checkout:C3 (bounded) — a repeated S4 revisit is rejected before the browser, S4 still completes, and C3 gets the pinned S3+S4 window (not just a terminal snapshot)", async () => {
  const plan = parseFlow(fs.readFileSync(CHECKOUT_FLOW, "utf8"), "checkout");
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-checkout-bounded-"));
  const runId = "checkout-bounded-run";
  try {
    const manifest = await runFlow({
      plan, baseUrl: ORIGIN, runId, runsRoot, model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06", ...MODE_META, decider: new CheckoutLoopDecider(), actuator: new OrderPageActuator(), now: NOW,
    });
    const runDir = path.join(runsRoot, runId);
    const { events } = readEvents(path.join(runDir, "events.jsonl"));

    // S4 completes (no MAX_ACTIONS_PER_STEP trip); the first revisit executed, the repeat rejected.
    assert.equal(manifest.executionStatus, "completed");
    assert.ok(events.find((e) => e.type === "step_end" && e.stepId === "checkout:S4"), "S4 emits step_end");
    const ns = events.filter((e): e is NavigationEvent => e.type === "navigation");
    assert.equal(ns.filter((n) => n.status === "executed").length, 1, "only the first revisit executes");
    assert.equal(ns.filter((n) => n.status === "rejected").length, 1, "the no-effect repeat is rejected");
    assert.equal(events.filter((e) => e.type === "error" && (e as any).code === "NAV_NO_EFFECT").length, 1);
    assert.ok(!events.some((e) => e.type === "guard_tripped"), "no MAX_ACTIONS_PER_STEP loop");

    // C3 gets the pinned two-boundary window — NOT a single terminal snapshot.
    const c3 = resolveEvidence(plan, runDir).find((r) => r.criterionId === "checkout:C3")!;
    assert.equal(c3.evidence?.windowKind, "pinned");
    const stepIds = c3.evidence!.snapshots.map((s) => s.stepId);
    assert.ok(stepIds.includes("checkout:S3") && stepIds.includes("checkout:S4"), "C3 has both S3 and S4 boundaries");
    assert.ok(c3.evidence!.snapshots.length >= 2, "C3 no longer relies on only a terminal snapshot");
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});
