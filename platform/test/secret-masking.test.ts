import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { ParsedSnapshot, parseSnapshot, digestSnapshot } from "../src/mcp/snapshot";
import type { ValidatedRef } from "../src/mcp/snapshot";
import type { ToolResult } from "../src/mcp/client";
import { BrowserActuator, runFlow } from "../src/engine/loop";
import type { Decider, DecisionContext, DeciderResult } from "../src/engine/decider";
import { SYSTEM_PROMPT } from "../src/engine/decider";
import { extractSecretLiterals } from "../src/run/redaction";
import { readEvents, readManifest, verifyAuditChain } from "../src/run/audit";
import type { RunEvent, StoredSnapshot } from "../src/run/schema";

const NOW = () => new Date("2026-06-18T00:00:00.000Z");
const USAGE = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

class MockDecider implements Decider {
  readonly seen: DecisionContext[] = [];
  constructor(private readonly script: (ctx: DecisionContext, call: number) => unknown) {}
  private n = 0;
  async decide(ctx: DecisionContext): Promise<DeciderResult> {
    this.seen.push(ctx);
    // Mirror the real decider: the tool input is wrapped under `decision`.
    const inner = this.script(ctx, this.n++);
    const rawDecision = inner === undefined ? undefined : { decision: inner };
    return { rawDecision, usage: { ...USAGE }, latencyMs: 5, model: "claude-sonnet-4-6" };
  }
}
class MockActuator implements BrowserActuator {
  readonly types: { ref: string; text: string }[] = [];
  private i = 0;
  constructor(private readonly snaps: (i: number) => ParsedSnapshot) {}
  async launch() {}
  async navigate() {}
  async snapshot() {
    return this.snaps(this.i++);
  }
  async clickRef(): Promise<ToolResult> {
    return { text: "ok", isError: false };
  }
  async typeRef(ref: ValidatedRef, _el: string, text: string): Promise<ToolResult> {
    this.types.push({ ref, text });
    return { text: "ok", isError: false };
  }
  async close() {}
}

// A login-like flow whose step text carries the secret literal.
function pwPlan() {
  return parseFlow(
    '---\nname: T\nentry: /login\n---\n\n## Steps\n1. Enter the username "alice" and the password "password123".\n\n## Acceptance Criteria\n- ok.\n',
    "login",
  );
}
// A snapshot that exposes the secret two ways (typed field value + a page credential
// hint) plus ordinary visible data (username, a product name, an amount).
function richSnap(): ParsedSnapshot {
  return parseSnapshot(
    [
      "- generic [ref=e1]:",
      '  - textbox "Username" [ref=e5]: alice',
      '  - textbox "Password" [ref=e7]: password123',
      '  - button "Sign in" [ref=e8]',
      "  - code [ref=e18]: alice / password123",
      "  - text: Desk Lamp $19.99",
    ].join("\n"),
    "### Page\n- Page URL: http://x/login\n- Page Title: Login",
  );
}

function runMasking() {
  const decider = new MockDecider((_c, call) =>
    call === 0
      ? { kind: "action", action: "type", ref: "e5", value: "alice", rationale: "type username alice" }
      : call === 1
        ? { kind: "action", action: "type", ref: "e7", value: "password123", rationale: 'type the password "password123"' }
        : { kind: "step_complete", rationale: "filled alice and password123 into the fields" },
  );
  const actuator = new MockActuator(() => richSnap());
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-mask-"));
  return { decider, actuator, runsRoot };
}

async function execMasking() {
  const { decider, actuator, runsRoot } = runMasking();
  const manifest = await runFlow({
    plan: pwPlan(),
    baseUrl: "http://x",
    runId: "r",
    runsRoot,
    model: "claude-sonnet-4-6",
    pricingConfigId: "anthropic-2026-06",
    decider,
    actuator,
    now: NOW,
  });
  const runDir = path.join(runsRoot, "r");
  return { manifest, runDir, events: readEvents(path.join(runDir, "events.jsonl")).events, cleanup: () => fs.rmSync(runsRoot, { recursive: true, force: true }) };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// --- seed extractor ---------------------------------------------------------------

test("extractSecretLiterals seeds only secret-adjacent values, not ordinary ones", () => {
  const got = extractSecretLiterals([
    'Enter the username "alice" and the password "password123".',
    'Add the "Desk Lamp" to the cart; the total is "$19.99".',
    'Use the API token "tok_abc" and the secret "s3cr3t".',
  ]);
  assert.ok(got.includes("password123"));
  assert.ok(got.includes("tok_abc"));
  assert.ok(got.includes("s3cr3t"));
  assert.ok(!got.includes("alice"));
  assert.ok(!got.includes("Desk Lamp"));
  assert.ok(!got.includes("$19.99"));
});

// --- test 1: the secret literal is in NO file under the run directory --------------

test("1) password123 appears in no file under the completed run directory", async () => {
  const r = await execMasking();
  try {
    assert.equal(r.manifest.executionStatus, "completed");
    const offenders: string[] = [];
    for (const f of walk(r.runDir)) {
      if (fs.readFileSync(f, "utf8").includes("password123")) offenders.push(path.relative(r.runDir, f));
    }
    assert.deepEqual(offenders, [], `secret leaked into: ${offenders.join(", ")}`);
  } finally {
    r.cleanup();
  }
});

// --- test 2: ordinary values stay visible (no over-redaction) ----------------------

test("2) alice, product names, and amounts stay visible", async () => {
  const r = await execMasking();
  try {
    const blobs = walk(r.runDir).filter((f) => f.includes(path.sep + "snapshots" + path.sep));
    const corpus = blobs.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    assert.ok(corpus.includes("alice"), "username alice must stay visible");
    assert.ok(corpus.includes("Desk Lamp"), "product name must stay visible");
    assert.ok(corpus.includes("$19.99"), "amount must stay visible");
    // and the non-sensitive typed value (alice) is logged in the clear
    const typed = r.events.find((e) => e.type === "action" && (e as { ref: string }).ref === "e5") as { value?: unknown };
    assert.equal(typed.value, "alice");
  } finally {
    r.cleanup();
  }
});

// --- test 3 + 4: digests recompute and the audit chain still verifies -------------

test("3+4) stored snapshot digests recompute and verifyAuditChain passes after masking", async () => {
  const r = await execMasking();
  try {
    for (const f of walk(r.runDir).filter((p) => p.endsWith(".json") && p.includes("snapshots"))) {
      const blob = JSON.parse(fs.readFileSync(f, "utf8")) as StoredSnapshot;
      assert.equal(digestSnapshot(blob.yaml), blob.digest, `digest mismatch in ${f}`);
    }
    const report = verifyAuditChain(r.runDir);
    assert.equal(report.ok, true);
    assert.ok(report.checked >= 2);
  } finally {
    r.cleanup();
  }
});

// --- test 5: values, rationales, and blocked reasons stay redacted -----------------

test("5) password value + rationale are redacted; blocked reason is scrubbed", async () => {
  const r = await execMasking();
  try {
    const pwDecision = r.events.find(
      (e) => e.type === "llm_decision" && (e as { decision: { ref?: string } }).decision.ref === "e7",
    ) as { decision: { value?: unknown; rationale: string } };
    assert.deepEqual(pwDecision.decision.value, { value: "[REDACTED]", valueLength: 11, sensitive: true });
    for (const e of r.events) {
      if (e.type === "llm_decision") {
        const d = (e as { decision: { rationale?: string; reason?: string } }).decision;
        assert.ok(!(d.rationale ?? "").includes("password123"));
        assert.ok(!(d.reason ?? "").includes("password123"));
      }
    }
    r.cleanup();
  } catch (e) {
    r.cleanup();
    throw e;
  }

  // a blocked reason that echoes the secret is also scrubbed
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-mask-"));
  try {
    const decider = new MockDecider(() => ({ kind: "blocked", reason: "cannot proceed with password123 visible" }));
    await runFlow({
      plan: pwPlan(),
      baseUrl: "http://x",
      runId: "b",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      decider,
      actuator: new MockActuator(() => richSnap()),
      now: NOW,
    });
    const evs = readEvents(path.join(runsRoot, "b", "events.jsonl")).events;
    const blocked = evs.find((e) => e.type === "llm_decision" && (e as { decision: { kind: string } }).decision.kind === "blocked") as { decision: { reason: string } };
    assert.ok(!blocked.decision.reason.includes("password123"));
    assert.ok(blocked.decision.reason.includes("[REDACTED]"));
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

// --- test 6: page-change completion is generic, not login-specific -----------------

test("6) page-change completion is generic (mock non-login flow; prompt has no login cues)", async () => {
  // the prompt teaches a general principle, with no hardcoded login cues
  for (const cue of ["Log out", "/products", "sign-in", "Log in", "login"]) {
    assert.ok(!SYSTEM_PROMPT.toLowerCase().includes(cue.toLowerCase()), `prompt must not hardcode "${cue}"`);
  }

  // behavior: a NON-login "Save" step completes once the page changes after the action
  const plan = parseFlow("---\nname: T\nentry: /doc\n---\n\n## Steps\n1. Save the document.\n\n## Acceptance Criteria\n- ok.\n", "doc");
  const before = parseSnapshot('- generic [ref=e1]:\n  - button "Save" [ref=e8]', "### Page\n- Page URL: http://x/doc");
  const after = parseSnapshot('- generic [ref=e1]:\n  - text: Saved at 12:00', "### Page\n- Page URL: http://x/doc");
  const decider = new MockDecider((ctx, call) =>
    call === 0 ? { kind: "action", action: "click", ref: "e8", rationale: "click Save" } : { kind: "step_complete", rationale: "the page changed after saving" },
  );
  const actuator = new MockActuator((i) => (i === 0 ? before : after));
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-generic-"));
  try {
    const manifest = await runFlow({
      plan,
      baseUrl: "http://x",
      runId: "g",
      runsRoot,
      model: "claude-sonnet-4-6",
      pricingConfigId: "anthropic-2026-06",
      decider,
      actuator,
      now: NOW,
    });
    assert.equal(manifest.executionStatus, "completed");
    // the harness fed the bare factual signal on the completing decision
    assert.equal(decider.seen[1].pageChangedSinceAction, true);
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});
