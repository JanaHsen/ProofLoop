/**
 * (D48) Executor-loop tests for trusted observed-URL navigation. Drives the real runFlow
 * with a mock decider + a page-state mock actuator: a navigate_to_observed_url decision
 * resolves to the STORED page URL of a snapshot observed earlier in the run, navigates
 * through the actuator, captures a fresh post-navigation snapshot, audits it, and lets the
 * step complete. No live model, browser, SUT, or network.
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
import { readEvents, readManifest, verifyAuditChain } from "../src/run/audit";
import type { RunEvent, NavigationEvent } from "../src/run/schema";

const NOW = () => new Date("2026-06-25T00:00:00.000Z");
const ORIGIN = "http://localhost:3000";
const MODE_META = {
  mode: "headless" as const,
  requestedMode: "headless" as const,
  browser: browserConfigFor("desktop"),
};
const USAGE = { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** A 2-step revisit plan: observe page A, then revisit it as a fresh visit. */
function navPlan() {
  return parseFlow(
    "---\nname: Nav\nentry: /a\n---\n\n## Steps\n1. Look at page A.\n2. Revisit page A as a fresh visit.\n\n## Acceptance Criteria\n- the page is shown. (after step 2)\n",
    "nav",
  );
}

/** A snapshot for `url`, with a couple of refs and that url as the page URL. */
function pageAt(url: string, title = "Page"): ParsedSnapshot {
  return parseSnapshot(
    '- generic [ref=e1]:\n  - heading "Page" [ref=e2]\n  - button "Do" [ref=e3]',
    `### Page\n- Page URL: ${url}\n- Page Title: ${title}`,
  );
}

interface PageActuatorOpts {
  /** Map a navigated-to URL (with its 1-based navigate count) onto the URL the browser ends up on. */
  onNavigate?: (url: string, count: number) => string;
  /** Throw on the navigate() call with this 1-based count (1 = entry, 2 = first revisit). */
  throwOnNavCount?: number;
}

class PageActuator implements BrowserActuator {
  readonly navigations: string[] = [];
  readonly clicks: string[] = [];
  private currentUrl = `${ORIGIN}/a`;
  constructor(private readonly o: PageActuatorOpts = {}) {}
  async launch() {}
  async navigate(url: string) {
    this.navigations.push(url);
    const count = this.navigations.length;
    if (this.o.throwOnNavCount === count) throw new Error("nav transport boom");
    this.currentUrl = this.o.onNavigate ? this.o.onNavigate(url, count) : url;
  }
  async snapshot() {
    return pageAt(this.currentUrl);
  }
  async clickRef(ref: ValidatedRef): Promise<ToolResult> {
    this.clicks.push(ref);
    return { text: "ok", isError: false };
  }
  async typeRef(): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async close() {}
}

class MockDecider implements Decider {
  readonly seen: DecisionContext[] = [];
  private calls = 0;
  constructor(private readonly script: (ctx: DecisionContext, call: number) => unknown) {}
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    this.seen.push(ctx);
    const inner = this.script(ctx, this.calls++);
    const rawDecision = inner === undefined ? undefined : { decision: inner };
    return { rawDecision, usage: { ...USAGE }, latencyMs: 3, model: "claude-sonnet-4-6" };
  }
}

interface Outcome {
  manifest: ReturnType<typeof readManifest>;
  events: RunEvent[];
  runDir: string;
  actuator: PageActuator;
  decider: MockDecider;
}

async function execute(
  script: (ctx: DecisionContext, call: number) => unknown,
  actuator: PageActuator,
): Promise<{ out: Outcome; cleanup: () => void }> {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-nav-loop-"));
  const cleanup = () => fs.rmSync(runsRoot, { recursive: true, force: true });
  const decider = new MockDecider(script);
  try {
    const manifest = await runFlow({
      plan: navPlan(),
      baseUrl: ORIGIN,
      runId: "nav-run",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      ...MODE_META,
      decider,
      actuator,
      now: NOW,
    });
    const { events } = readEvents(path.join(runsRoot, "nav-run", "events.jsonl"));
    return { out: { manifest, events, runDir: path.join(runsRoot, "nav-run"), actuator, decider }, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const navEvents = (events: RunEvent[]): NavigationEvent[] =>
  events.filter((e): e is NavigationEvent => e.type === "navigation");
const errsByCode = (events: RunEvent[], code: string) =>
  events.filter((e): e is RunEvent & { type: "error"; code: string } => e.type === "error" && (e as any).code === code);
const stepEnds = (events: RunEvent[]) => events.filter((e) => e.type === "step_end");

/** Step 1 → step_complete; step 2 → navigate to the observed page-A snapshot, then complete. */
function revisitScript(extraOnNav?: Record<string, unknown>) {
  let navigated = false;
  return (ctx: DecisionContext): unknown => {
    if (ctx.step.ordinal === 1) return { kind: "step_complete", rationale: "page A is shown" };
    if (!navigated) {
      navigated = true;
      const target = (ctx.observedPages ?? []).find((p: ObservedPage) => p.pageUrl.endsWith("/a"));
      return { kind: "navigate_to_observed_url", snapshotId: target!.snapshotId, rationale: "revisit page A", ...extraOnNav };
    }
    return { kind: "step_complete", rationale: "revisited page A" };
  };
}

test("POSITIVE: navigate_to_observed_url resolves the stored URL, navigates, captures a post-nav snapshot, and the step completes", async () => {
  const actuator = new PageActuator();
  const { out, cleanup } = await execute(revisitScript(), actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    // both steps completed (not blocked)
    assert.equal(stepEnds(out.events).length, 2);
    // exactly one executed navigation, with full audit evidence
    const navs = navEvents(out.events);
    assert.equal(navs.length, 1);
    const nav = navs[0];
    assert.equal(nav.status, "executed");
    assert.equal(nav.resolvedUrl, `${ORIGIN}/a`);
    assert.equal(nav.finalUrl, `${ORIGIN}/a`);
    assert.ok(nav.sourceSnapshotId.startsWith("snapshot-"));
    assert.ok(nav.resultingSnapshotId && nav.resultingSnapshotId.startsWith("snapshot-"));
    // the actuator was driven to the entry page AND re-navigated to the trusted URL
    assert.ok(out.actuator.navigations.includes(`${ORIGIN}/a`));
    // the decision was offered observed pages including page A
    const step2 = out.decider.seen.find((c) => c.step.ordinal === 2 && c.observedPages);
    assert.ok(step2?.observedPages?.some((p) => p.pageUrl === `${ORIGIN}/a`));
    // audit chain (element actions) still verifies — navigation events don't break it
    assert.equal(verifyAuditChain(out.runDir).ok, true);
  } finally {
    cleanup();
  }
});

test("PROOF arbitrary URLs are impossible: a url smuggled onto the decision is ignored; only the stored URL is navigated", async () => {
  const actuator = new PageActuator();
  // The model also supplies url:evil — parseDecision strips it; resolution uses the stored URL.
  const { out, cleanup } = await execute(revisitScript({ url: "http://evil.example/pwn" }), actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    // every navigation target is on the SUT origin; the invented URL never reached the browser
    for (const u of out.actuator.navigations) {
      assert.ok(u.startsWith(ORIGIN), `navigation target escaped origin: ${u}`);
    }
    assert.ok(!out.actuator.navigations.some((u) => u.includes("evil.example")));
    assert.equal(navEvents(out.events)[0].resolvedUrl, `${ORIGIN}/a`);
  } finally {
    cleanup();
  }
});

test("NEGATIVE: a fabricated snapshot id is rejected, audited, and gets ONE informed correction", async () => {
  const actuator = new PageActuator();
  let phase = 0;
  const script = (ctx: DecisionContext): unknown => {
    if (ctx.step.ordinal === 1) return { kind: "step_complete", rationale: "shown" };
    phase += 1;
    if (phase === 1) return { kind: "navigate_to_observed_url", snapshotId: "snapshot-999", rationale: "revisit (bad id)" };
    return { kind: "step_complete", rationale: "give up navigating, page is fine" };
  };
  const { out, cleanup } = await execute(script, actuator);
  try {
    // a rejected navigation was recorded, plus a NAV_REJECTED error and a retry; no browser nav happened for it
    const navs = navEvents(out.events);
    assert.equal(navs.length, 1);
    assert.equal(navs[0].status, "rejected");
    assert.equal(navs[0].resolvedUrl, "");
    assert.equal(errsByCode(out.events, "NAV_REJECTED").length, 1);
    assert.equal(out.events.filter((e) => e.type === "retry").length, 1);
    // the correction let the step finish normally
    assert.equal(out.manifest.executionStatus, "completed");
    // only the entry navigation ever reached the actuator (the rejected one did not)
    assert.deepEqual(out.actuator.navigations, [`${ORIGIN}/a`]);
  } finally {
    cleanup();
  }
});

test("NEGATIVE: a redirect that escapes the SUT origin fails the run (NAVIGATION_CROSS_ORIGIN), never proceeds", async () => {
  // The entry navigation (count 1) stays same-origin; only the revisit (count 2) lands the
  // browser on a foreign origin, simulating a redirect escape after a same-origin request.
  const actuator = new PageActuator({ onNavigate: (url, count) => (count >= 2 ? "http://evil.example/landing" : url) });
  const { out, cleanup } = await execute(revisitScript(), actuator);
  try {
    assert.equal(out.manifest.executionStatus, "error");
    assert.equal(errsByCode(out.events, "NAVIGATION_CROSS_ORIGIN").length, 1);
    const nav = navEvents(out.events)[0];
    assert.equal(nav.status, "failed");
    assert.equal(nav.finalUrl, "http://evil.example/landing");
  } finally {
    cleanup();
  }
});

test("NEGATIVE: a revisit navigation transport failure ends the run safely (NAVIGATION_FAILED)", async () => {
  // Entry navigation (count 1) succeeds; the revisit navigation (count 2) throws.
  const actuator = new PageActuator({ throwOnNavCount: 2 });
  const { out, cleanup } = await execute(revisitScript(), actuator);
  try {
    assert.equal(out.manifest.executionStatus, "error");
    assert.equal(errsByCode(out.events, "NAVIGATION_FAILED").length, 1);
    assert.equal(navEvents(out.events)[0].status, "failed");
  } finally {
    cleanup();
  }
});

test("UNCHANGED: click → step_complete still works with the navigation branch present", async () => {
  const actuator = new PageActuator();
  const script = (ctx: DecisionContext, call: number): unknown => {
    if (ctx.step.ordinal === 1) {
      return call === 0
        ? { kind: "action", action: "click", ref: "e3", rationale: "click Do" }
        : { kind: "step_complete", rationale: "clicked" };
    }
    return { kind: "step_complete", rationale: "done" };
  };
  const { out, cleanup } = await execute(script, actuator);
  try {
    assert.equal(out.manifest.executionStatus, "completed");
    assert.deepEqual(out.actuator.clicks, ["e3"]);
    assert.equal(navEvents(out.events).length, 0);
    assert.equal(verifyAuditChain(out.runDir).ok, true);
  } finally {
    cleanup();
  }
});
