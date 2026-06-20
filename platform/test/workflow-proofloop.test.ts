/**
 * Phase 6 Task 4 — STATIC checks on .github/workflows/proofloop.yml.
 *
 * These prove YAML structure, the workflow-level timeout (§6), step ordering, and the static
 * environment-partition rules (§8). They do NOT (and cannot) prove the GitHub-runner integration
 * seams — process lifecycle, repo-root resolution on the runner, real install/health behavior —
 * which are explicitly verified at the live-CI human gate (§8/§9).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

const WORKFLOW_PATH = path.resolve(__dirname, "..", "..", ".github", "workflows", "proofloop.yml");
const RAW = fs.readFileSync(WORKFLOW_PATH, "utf8");
// js-yaml v4 keeps `on` as a string key (no YAML-1.1 boolean coercion), but guard anyway.
const DOC = yaml.load(RAW) as any;
const ON = DOC.on !== undefined ? DOC.on : DOC[true as unknown as string];
const MAIN = DOC.jobs.proofloop;

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}
const STEPS: Step[] = MAIN.steps;

function step(nameFragment: string): Step {
  const s = STEPS.find((st) => (st.name ?? "").toLowerCase().includes(nameFragment.toLowerCase()));
  assert.ok(s, `expected a step whose name contains "${nameFragment}"`);
  return s!;
}
function idx(nameFragment: string): number {
  return STEPS.findIndex((st) => (st.name ?? "").toLowerCase().includes(nameFragment.toLowerCase()));
}

// ── triggers / permissions / concurrency ───────────────────────────────────────────────────

test("triggers: workflow_dispatch ONLY — no pull_request (Task 5 adds it)", () => {
  assert.ok(ON.workflow_dispatch !== undefined, "workflow_dispatch present");
  assert.ok(ON.pull_request === undefined, "pull_request must NOT be wired in Task 4");
});

test("pull_request_target is forbidden anywhere in the workflow", () => {
  assert.ok(!RAW.includes("pull_request_target"), "pull_request_target must never appear");
});

test("permissions are minimal: contents read, pull-requests write", () => {
  assert.equal(DOC.permissions.contents, "read");
  assert.equal(DOC.permissions["pull-requests"], "write");
});

test("concurrency cancels in progress and groups by PR/ref", () => {
  assert.equal(DOC.concurrency["cancel-in-progress"], true);
  assert.match(String(DOC.concurrency.group), /github\.ref|pull_request\.number/);
});

// ── §6: workflow-level timeout ──────────────────────────────────────────────────────────────

test("§6: the authorized main job has a bounded timeout between 20 and 30 minutes", () => {
  const t = MAIN["timeout-minutes"];
  assert.equal(typeof t, "number", "timeout-minutes must be a number");
  assert.ok(t >= 20 && t <= 30, `timeout-minutes must be in [20,30], got ${t}`);
});

// ── fork guard (D45) ────────────────────────────────────────────────────────────────────────

test("fork guard: authorize job gates the main job; fork-notice covers the unauthorized case", () => {
  assert.ok(DOC.jobs.authorize, "authorize job present");
  assert.ok((MAIN.needs ?? []).includes("authorize"), "main job needs authorize");
  assert.match(String(MAIN.if), /authorized == 'true'/);
  assert.match(String(DOC.jobs["fork-notice"].if), /authorized != 'true'/);
});

// ── step ordering ───────────────────────────────────────────────────────────────────────────

test("step ordering: checkout → setup → installs → playwright → preflight → boot → loop → aggregate → enforce", () => {
  assert.equal(idx("Checkout"), 0, "checkout is first");
  assert.ok(idx("Setup Node") < idx("Install app"), "setup before installs");
  assert.ok(idx("Install app") < idx("Install platform"));
  assert.ok(idx("Install platform") < idx("Install Chromium"));
  assert.ok(idx("Install Chromium") < idx("Preflight"), "browser installed before preflight");
  assert.ok(idx("Preflight") < idx("Boot SUT"), "preflight fails fast BEFORE the SUT boots / any spend");
  assert.ok(idx("Boot SUT") < idx("Wait for SUT health"));
  assert.ok(idx("Wait for SUT health") < idx("Run flows"));
  assert.ok(idx("Run flows") < idx("Aggregate"));
  assert.ok(idx("Aggregate") < idx("Enforce verdict"));
  // Enforcement is the final step.
  assert.equal(idx("Enforce verdict"), STEPS.length - 1, "enforcement is last");
});

test("installs and browser use working-directory (not a global cd)", () => {
  assert.equal(step("Install app")["working-directory"], "app");
  assert.equal(step("Install platform")["working-directory"], "platform");
  assert.equal(step("Install Chromium")["working-directory"], "platform");
});

// ── §8: static environment partition (D41) ──────────────────────────────────────────────────

test("§8: SUT boot receives PROOFLOOP_BUGS + APP_PORT and NOT the API key", () => {
  const boot = step("Boot SUT");
  assert.ok(boot.env && "PROOFLOOP_BUGS" in boot.env, "SUT gets PROOFLOOP_BUGS");
  assert.ok("APP_PORT" in boot.env!, "SUT gets APP_PORT");
  assert.ok(!("ANTHROPIC_API_KEY" in boot.env!), "SUT must NOT receive the API key");
  assert.ok(!("BASE_URL" in boot.env!), "SUT must NOT receive BASE_URL");
});

test("§8: tester steps receive the API key + model config and NOT bug/secret vars", () => {
  for (const name of ["Preflight", "Run flows"]) {
    const s = step(name);
    assert.ok(s.env && "ANTHROPIC_API_KEY" in s.env, `${name}: tester gets the API key`);
    assert.ok("PROOFLOOP_VERIFIER_MODEL" in s.env!, `${name}: tester gets verifier model`);
    assert.ok("BASE_URL" in s.env!, `${name}: tester gets BASE_URL`);
    assert.ok(!("PROOFLOOP_BUGS" in s.env!), `${name}: tester must NOT see PROOFLOOP_BUGS`);
    assert.ok(!("SESSION_SECRET" in s.env!), `${name}: tester must NOT see SESSION_SECRET`);
    assert.ok(!("PROOFLOOP_DEBUG_TOKEN" in s.env!), `${name}: tester must NOT see the debug token`);
  }
});

test("§8: SESSION_SECRET is generated ephemerally and never exported job-wide", () => {
  // It must not be promoted to $GITHUB_ENV (which all later steps would inherit).
  for (const line of RAW.split("\n")) {
    if (line.includes("SESSION_SECRET")) {
      assert.ok(!line.includes("GITHUB_ENV"), `SESSION_SECRET must not reach $GITHUB_ENV: ${line.trim()}`);
    }
  }
  // No job-wide env block leaking partitioned vars.
  assert.ok(MAIN.env === undefined, "the main job must not declare a job-wide env block");
});

test("PROOFLOOP_DEBUG_TOKEN is never passed anywhere", () => {
  assert.ok(!RAW.includes("PROOFLOOP_DEBUG_TOKEN: "), "debug token must never be set in the workflow");
});

// ── aggregation + enforcement wiring (§9) ───────────────────────────────────────────────────

test("aggregate step is fault-tolerant and pins the repo root explicitly", () => {
  const agg = step("Aggregate");
  assert.equal(agg["continue-on-error"], true, "a loud report:ci failure must not abort before upload");
  assert.match(String(agg.run), /--repo-root "\$GITHUB_WORKSPACE"/, "repo root pinned to $GITHUB_WORKSPACE (§10)");
});

test("§9: a missing/invalid summary.json yields a harness fallback, not a trusted summary", () => {
  const publish = step("Publish summary");
  assert.match(String(publish.run), /aggregation failed/i, "harness fallback message present");
  assert.match(String(publish.run), /No verdict was inferred/i);
});

test("final enforcement reads ONLY summary.json's allPass (never Markdown)", () => {
  const enforce = step("Enforce verdict");
  assert.match(String(enforce.run), /summary\.json/);
  assert.match(String(enforce.run), /allPass/);
  assert.ok(!String(enforce.run).includes("summary.md"), "enforcement must not parse Markdown");
  assert.match(String(enforce.if), /always\(\)/);
});

test("artifacts upload even on failure (if: always) — runs bundle + summary/logs bundle", () => {
  const runsUpload = step("Upload run artifacts");
  const summaryUpload = step("Upload CI summary");
  assert.match(String(runsUpload.if), /always\(\)/);
  assert.match(String(summaryUpload.if), /always\(\)/);
  assert.match(String((runsUpload.with as any).path), /platform\/runs/);
});

test("sticky comment is PR-only (inert under dispatch)", () => {
  const comment = step("Upsert sticky PR comment");
  assert.match(String(comment.if), /github\.event_name == 'pull_request'/);
});

test("teardown runs always and targets the SUT process group", () => {
  const teardown = step("Teardown SUT");
  assert.match(String(teardown.if), /always\(\)/);
  assert.match(String(teardown.run), /-\$\{SUT_PID\}|-"?\$\{?SUT_PID\}?"?/, "kills the negative PID (process group)");
});
