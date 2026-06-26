/**
 * (D48) Bounded observed-URL navigation — replays the three live regression shapes and the
 * guard-behaviour invariants. The first valid navigation (incl. a same-page fresh visit) is
 * allowed; an immediate no-effect REPEAT is rejected before the browser (guard B); a same-
 * document RELOAD that would discard a just-observed element-action response is rejected before
 * the browser (guard C); a state-changing navigation is never falsely rejected. No live model,
 * browser, SUT, or network.
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
import { readEvents, readManifest } from "../src/run/audit";
import type { RunEvent, NavigationEvent } from "../src/run/schema";

const ORIGIN = "http://localhost:3000";
const NOW = () => new Date("2026-06-26T16:00:00.000Z");
const MODE_META = { mode: "headless" as const, requestedMode: "headless" as const, browser: browserConfigFor("desktop") };
const USAGE = { input_tokens: 40, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// ── pages ─────────────────────────────────────────────────────────────────────────────
const loginPage = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Log in" [ref=e2]\n  - button "Log in" [ref=e3]', `### Page\n- Page URL: ${ORIGIN}/login\n- Page Title: Log in`);
const homePage = () => parseSnapshot('- generic [ref=e1]:\n  - navigation [ref=e4]:\n    - link "Products" [ref=e5]:\n      - /url: /products\n  - heading "Home" [ref=e6]', `### Page\n- Page URL: ${ORIGIN}/\n- Page Title: Home`);
const productsPage = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Products" [ref=e2]\n  - link "Notebook" [ref=e4]', `### Page\n- Page URL: ${ORIGIN}/products\n- Page Title: Products`);
const emptyForm = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Submit a request" [ref=e2]\n  - textbox "Amount" [ref=e3]\n  - button "Submit" [ref=e4]', `### Page\n- Page URL: ${ORIGIN}/form\n- Page Title: Form`);
const rejectionForm = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Submit a request" [ref=e2]\n  - textbox "Amount" [ref=e3]: "-5"\n  - generic [ref=e5]: Amount must be a positive whole number.\n  - button "Submit" [ref=e4]', `### Page\n- Page URL: ${ORIGIN}/form\n- Page Title: Form`);
const pageA = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Page A" [ref=e2]\n  - link "Go B" [ref=e3]', `### Page\n- Page URL: ${ORIGIN}/a\n- Page Title: A`);
const pageB = () => parseSnapshot('- generic [ref=e1]:\n  - heading "Page B" [ref=e2]', `### Page\n- Page URL: ${ORIGIN}/b\n- Page Title: B`);

// ── a callback-driven site actuator ────────────────────────────────────────────────────
interface SiteOpts {
  start: string;
  page: (url: string) => ParsedSnapshot;
  onNavigate?: (url: string) => string;
  onClick?: (ref: string, url: string) => string;
}
class SiteActuator implements BrowserActuator {
  readonly navigations: string[] = [];
  readonly clicks: string[] = [];
  currentUrl: string;
  constructor(private readonly o: SiteOpts) {
    this.currentUrl = o.start;
  }
  async launch() {}
  async navigate(url: string) {
    this.navigations.push(url);
    this.currentUrl = this.o.onNavigate ? this.o.onNavigate(url) : url;
  }
  async snapshot() {
    return this.o.page(this.currentUrl);
  }
  async clickRef(ref: ValidatedRef): Promise<ToolResult> {
    this.clicks.push(ref);
    if (this.o.onClick) this.currentUrl = this.o.onClick(ref, this.currentUrl);
    return { text: "ok", isError: false };
  }
  async typeRef(): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async close() {}
}

/** A /form whose submit shows a validation response and whose reload resets to an empty form. */
class FormActuator implements BrowserActuator {
  readonly navigations: string[] = [];
  submitted = false;
  async launch() {}
  async navigate(u: string) {
    this.navigations.push(u);
    this.submitted = false; // a reload discards the response
  }
  async snapshot() {
    return this.submitted ? rejectionForm() : emptyForm();
  }
  async clickRef(_ref: ValidatedRef): Promise<ToolResult> {
    this.submitted = true; // submit triggers the validation rejection
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
    return { rawDecision: inner === undefined ? undefined : { decision: inner }, usage: { ...USAGE }, latencyMs: 2, model: "claude-sonnet-4-6" };
  }
}

interface Out<A> {
  manifest: ReturnType<typeof readManifest>;
  events: RunEvent[];
  runDir: string;
  actuator: A;
}
async function run<A extends BrowserActuator & { navigations: string[] }>(
  planText: string,
  flowId: string,
  _entry: string,
  decider: Decider,
  actuator: A,
): Promise<{ out: Out<A>; cleanup: () => void }> {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-bnav-"));
  const cleanup = () => fs.rmSync(runsRoot, { recursive: true, force: true });
  try {
    const manifest = await runFlow({
      plan: parseFlow(planText, flowId),
      baseUrl: ORIGIN,
      runId: "r",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      ...MODE_META,
      decider,
      actuator,
      now: NOW,
    });
    const { events } = readEvents(path.join(runsRoot, "r", "events.jsonl"));
    return { out: { manifest, events, runDir: path.join(runsRoot, "r"), actuator }, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const navs = (e: RunEvent[]) => e.filter((x): x is NavigationEvent => x.type === "navigation");
const errs = (e: RunEvent[], code: string) => e.filter((x) => x.type === "error" && (x as any).code === code);
const terminalSnap = (e: RunEvent[]) => e.filter((x): x is RunEvent & { type: "snapshot"; kind: string; pageUrl?: string } => x.type === "snapshot" && (x as any).kind === "terminal").pop();
const find = (ctx: DecisionContext, p: string) => (ctx.observedPages ?? []).find((o: ObservedPage) => o.displayPath === p);

// ── LOGIN shape: navigate to /login redirects to unchanged Home; repeat rejected ───────
test("LOGIN replay: first /login navigation executes (redirect→Home), the identical repeat is rejected before the browser, budget survives, correction reaches Products", () => {
  return (async () => {
    let signedIn = false;
    const actuator = new SiteActuator({
      start: `${ORIGIN}/login`,
      page: (u) => (u === `${ORIGIN}/products` ? productsPage() : u === `${ORIGIN}/` ? homePage() : loginPage()),
      onNavigate: (u) => (signedIn && u.endsWith("/login") ? `${ORIGIN}/` : u),
      onClick: (_ref, u) => {
        if (u === `${ORIGIN}/login`) { signedIn = true; return `${ORIGIN}/`; }
        if (u === `${ORIGIN}/`) return `${ORIGIN}/products`; // Products link
        return u;
      },
    });
    let s2 = 0;
    const decider = new MockDecider((ctx) => {
      if (ctx.step.ordinal === 1) {
        return ctx.snapshot.pageUrl?.endsWith("/login")
          ? { kind: "action", action: "click", ref: "e3", rationale: "submit login" }
          : { kind: "step_complete", rationale: "signed in" };
      }
      // S2 "go to the product list" — replay the buggy /login loop, then recover after correction
      s2 += 1;
      const login = find(ctx, "/login");
      if (s2 <= 2 && login) return { kind: "navigate_to_observed_url", snapshotId: login.snapshotId, rationale: "go to login" };
      if (ctx.snapshot.pageUrl === `${ORIGIN}/`) return { kind: "action", action: "click", ref: "e5", rationale: "click Products" };
      return { kind: "step_complete", rationale: "product list reached" };
    });
    const { out, cleanup } = await run(
      "---\nname: L\nentry: /login\n---\n\n## Steps\n1. Sign in.\n2. Go to the product list.\n\n## Acceptance Criteria\n- the product list loads.\n",
      "login",
      "/login",
      decider,
      actuator,
    );
    try {
      assert.equal(out.manifest.executionStatus, "completed", "budget not exhausted; no guard trip");
      const ns = navs(out.events);
      assert.equal(ns.filter((n) => n.status === "executed").length, 1, "only the FIRST /login navigation executes");
      assert.equal(errs(out.events, "NAV_NO_EFFECT").length, 1, "the repeat is rejected as no-effect");
      assert.equal(ns.filter((n) => n.status === "rejected").length, 1);
      // the rejected repeat never reached the browser (no second /login navigate after entry+first)
      assert.equal(out.actuator.navigations.filter((u) => u.endsWith("/login")).length, 2, "entry + one executed /login only");
      // the correction let the flow reach the product list
      assert.equal(terminalSnap(out.events)?.pageUrl, `${ORIGIN}/products`);
    } finally {
      cleanup();
    }
  })();
});

// ── FORM shape: same-document reload after a submission is rejected, response preserved ─
test("FORM replay: after the -5 submission shows a validation response, a /form reload is rejected before the browser and the rejection is preserved at the step boundary", () => {
  return (async () => {
    const actuator = new FormActuator();
    let phase = 0;
    const decider = new MockDecider((ctx) => {
      phase += 1;
      if (phase === 1) return { kind: "action", action: "type", ref: "e3", value: "-5", rationale: "amount -5" };
      if (phase === 2) return { kind: "action", action: "click", ref: "e4", rationale: "submit" };
      if (phase === 3) {
        const form = find(ctx, "/form");
        return { kind: "navigate_to_observed_url", snapshotId: form!.snapshotId, rationale: "reset the form" };
      }
      return { kind: "step_complete", rationale: "validation response observed" };
    });
    const { out, cleanup } = await run(
      "---\nname: F\nentry: /form\n---\n\n## Steps\n1. Submit an amount of -5.\n\n## Acceptance Criteria\n- the negative amount is rejected.\n",
      "form",
      "/form",
      decider,
      actuator,
    );
    try {
      assert.equal(out.manifest.executionStatus, "completed");
      assert.equal(errs(out.events, "NAV_WOULD_RESET").length, 1, "the same-document reload is rejected");
      assert.equal(navs(out.events).filter((n) => n.status === "executed").length, 0, "no navigation reached the browser");
      assert.equal(out.actuator.navigations.length, 1, "only the entry navigation occurred (no reset reload)");
      assert.equal(actuator.submitted, true, "the submission response was NOT reset");
      // the step-boundary snapshot preserves the rejection (not an empty form)
      const boundary = out.events.find((e): e is RunEvent & { type: "snapshot"; kind: string; path: string } => e.type === "snapshot" && (e as any).kind === "step_boundary");
      const blob = JSON.parse(fs.readFileSync(path.join(out.runDir, (boundary as any).path), "utf8"));
      assert.match(blob.yaml, /positive whole number/, "the rejection evidence is in the boundary snapshot");
    } finally {
      cleanup();
    }
  })();
});

// ── GUARD behaviour ─────────────────────────────────────────────────────────────────────
test("GUARD: a state-changing navigation is not falsely rejected; different destinations are not treated as a repeat", () => {
  return (async () => {
    // Step 1: click "Go B" → /b is observed. Then navigate /a (state change A) and /b (state change B): both execute.
    const actuator = new SiteActuator({
      start: `${ORIGIN}/a`,
      page: (u) => (u === `${ORIGIN}/b` ? pageB() : pageA()),
      onClick: (_r, _u) => `${ORIGIN}/b`,
    });
    let s1 = 0;
    const decider = new MockDecider((ctx) => {
      s1 += 1;
      if (s1 === 1) return { kind: "action", action: "click", ref: "e3", rationale: "go to B (observe it)" };
      if (s1 === 2) { const a = find(ctx, "/a"); return { kind: "navigate_to_observed_url", snapshotId: a!.snapshotId, rationale: "back to A" }; }
      if (s1 === 3) { const b = find(ctx, "/b"); return { kind: "navigate_to_observed_url", snapshotId: b!.snapshotId, rationale: "to B" }; }
      return { kind: "step_complete", rationale: "done" };
    });
    const { out, cleanup } = await run(
      "---\nname: G\nentry: /a\n---\n\n## Steps\n1. Move around.\n\n## Acceptance Criteria\n- ok.\n",
      "g",
      "/a",
      decider,
      actuator,
    );
    try {
      assert.equal(out.manifest.executionStatus, "completed");
      assert.equal(navs(out.events).filter((n) => n.status === "executed").length, 2, "both distinct, state-changing navigations execute");
      assert.equal(errs(out.events, "NAV_NO_EFFECT").length, 0, "neither is falsely rejected as a repeat");
      assert.equal(errs(out.events, "NAV_WOULD_RESET").length, 0);
    } finally {
      cleanup();
    }
  })();
});

test("GUARD: one same-page fresh visit with no preceding action response is allowed", () => {
  return (async () => {
    const actuator = new SiteActuator({ start: `${ORIGIN}/a`, page: () => pageA() });
    let n = 0;
    const decider = new MockDecider((ctx) => {
      n += 1;
      if (n === 1) { const a = find(ctx, "/a"); return { kind: "navigate_to_observed_url", snapshotId: a!.snapshotId, rationale: "fresh visit of current page" }; }
      return { kind: "step_complete", rationale: "revisited" };
    });
    const { out, cleanup } = await run(
      "---\nname: V\nentry: /a\n---\n\n## Steps\n1. Revisit this page.\n\n## Acceptance Criteria\n- ok.\n",
      "v",
      "/a",
      decider,
      actuator,
    );
    try {
      assert.equal(out.manifest.executionStatus, "completed");
      assert.equal(navs(out.events).filter((n) => n.status === "executed").length, 1, "the first same-page visit executes");
      assert.equal(errs(out.events, "NAV_WOULD_RESET").length, 0, "no preceding action response, so guard C does not fire");
    } finally {
      cleanup();
    }
  })();
});

test("GUARD: a repeatedly proposed no-effect navigation stops under the one-correction limit (no infinite loop)", () => {
  return (async () => {
    const actuator = new SiteActuator({ start: `${ORIGIN}/a`, page: () => pageA() }); // navigating /a is always a no-op reload
    const decider = new MockDecider((ctx) => {
      const a = find(ctx, "/a");
      return { kind: "navigate_to_observed_url", snapshotId: a!.snapshotId, rationale: "navigate again" }; // ALWAYS the same no-effect nav
    });
    const { out, cleanup } = await run(
      "---\nname: S\nentry: /a\n---\n\n## Steps\n1. Loop.\n\n## Acceptance Criteria\n- ok.\n",
      "s",
      "/a",
      decider,
      actuator,
    );
    try {
      // first executes; repeat rejected (correction); identical repeat again → stop safely
      assert.equal(out.manifest.executionStatus, "error", "the repeated no-effect proposal stops, not loops");
      assert.equal(navs(out.events).filter((n) => n.status === "executed").length, 1);
      assert.ok(errs(out.events, "NAV_NO_EFFECT").length >= 1);
      // the bounded-guard's REJECTED events carry no URL at all; its error details are URL-free
      for (const n of navs(out.events).filter((x) => x.status === "rejected")) {
        assert.equal(n.resolvedUrl, "");
        assert.equal(n.finalUrl, undefined);
      }
      for (const e of errs(out.events, "NAV_NO_EFFECT")) {
        assert.ok(!/https?:\/\/|[?#@]/.test((e as any).detail), "no raw URL/query/fragment/credentials in the no-effect detail");
      }
      // the only URL the EXECUTED navigation records is the sanitized origin+path (no query/fragment)
      const exec = navs(out.events).find((n) => n.status === "executed")!;
      assert.equal(exec.resolvedUrl, `${ORIGIN}/a`);
      assert.ok(!/[?#@]/.test(exec.resolvedUrl) && exec.finalUrl !== undefined && !/[?#@]/.test(exec.finalUrl));
    } finally {
      cleanup();
    }
  })();
});
