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

/** Every step across EVERY job (authorize, fork-notice, proofloop) — for exhaustive sweeps. */
function allSteps(): Step[] {
  const out: Step[] = [];
  for (const jobName of Object.keys(DOC.jobs)) {
    for (const s of (DOC.jobs[jobName].steps ?? []) as Step[]) out.push(s);
  }
  return out;
}

/** The executable surface of a step: its env (keys + values), run body, and `with` block. */
function executableSurface(s: Step): string {
  return JSON.stringify({ env: s.env ?? {}, run: s.run ?? "", with: s.with ?? {} });
}

// ── triggers / permissions / concurrency ───────────────────────────────────────────────────

test("triggers: workflow_dispatch + pull_request are wired (Task 5)", () => {
  assert.ok(ON.workflow_dispatch !== undefined, "workflow_dispatch present");
  assert.ok(ON.pull_request !== undefined, "pull_request present (Task 5)");
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

// ── §1: Node 24 runtime contract ────────────────────────────────────────────────────────────

/** The single locked runtime. The workflow must pin exactly this — not 20.x, not omitted. */
const REQUIRED_NODE_VERSION = "24";

/** Locate the REAL actions/setup-node step by its `uses`, never by name/position. */
function setupNodeStep(): Step {
  const matches = STEPS.filter(
    (st) => typeof st.uses === "string" && st.uses.startsWith("actions/setup-node"),
  );
  assert.equal(matches.length, 1, "there must be exactly one actions/setup-node step");
  return matches[0];
}

/** The exact-match acceptance predicate, isolated so the mutation test can hammer it. */
function acceptsNodeVersion(v: unknown): boolean {
  return v === REQUIRED_NODE_VERSION;
}

test("§1: the actions/setup-node step pins Node exactly to \"24\" (read from the real step)", () => {
  const v = (setupNodeStep().with ?? {})["node-version"];
  assert.equal(v, REQUIRED_NODE_VERSION, `node-version must be exactly "${REQUIRED_NODE_VERSION}", got ${JSON.stringify(v)}`);
  assert.ok(acceptsNodeVersion(v), "the located setup-node step satisfies the Node 24 contract");
});

test("§1 mutation: the Node assertion rejects 20, 20.18.1, omission, and the wrong type", () => {
  // If the workflow regressed to any of these, the assertion above would fail.
  assert.ok(!acceptsNodeVersion("20"), 'must reject "20"');
  assert.ok(!acceptsNodeVersion("20.18.1"), 'must reject "20.18.1"');
  assert.ok(!acceptsNodeVersion(undefined), "must reject an omitted node-version");
  assert.ok(!acceptsNodeVersion(20), "must reject numeric 20 (only the string \"24\" is valid)");
  assert.ok(!acceptsNodeVersion("24.1.0"), 'must reject a drifted patch like "24.1.0" (contract pins "24")');
  assert.ok(acceptsNodeVersion("24"), 'accepts exactly "24"');
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

// ════════════════════════════════════════════════════════════════════════════════════════════
// Task 4 contract coverage gaps — close the PARTIAL/MISSING items to genuine 21/21 static cover.
// Every assertion below inspects PARSED fields (not raw substrings) except where a raw-file
// guard is explicitly secondary.
// ════════════════════════════════════════════════════════════════════════════════════════════

// req 1 — workflow YAML parses
test("req1: the workflow parses to an object exposing jobs.proofloop", () => {
  assert.equal(typeof DOC, "object");
  assert.ok(DOC && DOC.jobs && DOC.jobs.proofloop, "parses to a jobs.proofloop object");
});

// req 2 — workflow_dispatch is the ONLY trigger (rejects push/schedule/pull_request[_target]/…)
test("req2: triggers are EXACTLY workflow_dispatch + pull_request (no push/schedule/target)", () => {
  assert.deepEqual(Object.keys(ON).sort(), ["pull_request", "workflow_dispatch"], "no push/schedule/pull_request_target/other trigger");
  assert.equal(ON.push, undefined, "no push trigger");
  assert.equal(ON.schedule, undefined, "no schedule trigger");
  assert.equal(ON.pull_request_target, undefined, "no pull_request_target trigger");
});

// ── Task 5: pull_request trigger, path filters, fork authorization ───────────────────────────

const PR_PATHS = ["app/**", "platform/**", "fixtures/flows/**", ".github/workflows/proofloop.yml"];

/** Minimal GitHub-Actions path-filter match: `X/**` matches anything under `X/`; otherwise exact. */
function matchesPrPaths(changedPath: string): boolean {
  return PR_PATHS.some((g) =>
    g.endsWith("/**") ? changedPath.startsWith(g.slice(0, -2)) : changedPath === g,
  );
}

test("Task 5: pull_request carries EXACTLY the approved path filters and keeps workflow_dispatch", () => {
  assert.deepEqual((ON.pull_request as any).paths, PR_PATHS, "exact path filters");
  assert.ok(ON.workflow_dispatch !== undefined, "manual dispatch is preserved");
  assert.ok((ON.workflow_dispatch as any).inputs?.bugs !== undefined, "the dispatch bugs input is preserved");
});

test("Task 5: code-path changes match the filters; docs-only changes do NOT trigger", () => {
  // code paths trigger
  for (const p of ["app/src/server.ts", "platform/src/run-cli.ts", "fixtures/flows/login.flow.md", ".github/workflows/proofloop.yml"]) {
    assert.ok(matchesPrPaths(p), `${p} should trigger`);
  }
  // docs-only / out-of-scope paths do NOT trigger
  for (const p of ["README.md", "phases/06-cicd-integration.md", "platform/test/x.test.ts".replace("platform/", "docs/"), "LICENSE", ".gitignore"]) {
    assert.ok(!matchesPrPaths(p), `${p} should NOT trigger`);
  }
});

test("Task 5: fork PRs are unauthorized + spend-free; same-repo PRs are authorized", () => {
  const authRun = String(DOC.jobs.authorize.steps[0].run ?? "");
  // fork detection: pull_request whose head repo != this repo → authorized=false
  assert.match(authRun, /github\.event_name.*pull_request/);
  assert.match(authRun, /head\.repo\.full_name.*!=.*github\.repository/);
  assert.match(authRun, /authorized=false/);
  assert.match(authRun, /authorized=true/, "the else branch authorizes same-repo PRs / dispatch");
  // the spending pipeline only runs when authorized — so a fork PR spends nothing
  assert.match(String(MAIN.if), /needs\.authorize\.outputs\.authorized == 'true'/);
  // the fork-notice job covers the unauthorized case with no install/spend
  assert.match(String(DOC.jobs["fork-notice"].if), /authorized != 'true'/);
});

// req 6 — only official, version-pinned actions
test("req6: every action is official (actions/*) and pinned to an explicit major version", () => {
  const uses = allSteps().map((s) => s.uses).filter((u): u is string => typeof u === "string");
  assert.ok(uses.length >= 4, "the workflow uses several actions");
  for (const u of uses) {
    assert.ok(u.startsWith("actions/"), `non-official action: ${u}`);
    assert.match(u, /@v\d+/, `action must pin an explicit major version: ${u}`);
  }
});

// req 7 — permissions are EXACTLY the approved minimum (no extra grants)
test("req7: the permissions object is exactly { contents: read, pull-requests: write }", () => {
  assert.deepEqual(DOC.permissions, { contents: "read", "pull-requests": "write" });
});

// req 8/9/10 — exhaustive environment partitioning over every parsed step
test("req8/9/10: exhaustive env partition — SUT-only vars only on SUT boot, debug token nowhere", () => {
  const SUT_ONLY = ["PROOFLOOP_BUGS", "APP_PORT", "SESSION_SECRET", "PROOFLOOP_DEBUG_TOKEN"];
  const TESTER_ALLOWED = ["ANTHROPIC_API_KEY", "BASE_URL", "PROOFLOOP_MODEL", "PROOFLOOP_VERIFIER_MODEL"];

  // no job-level env on the authorized main job
  assert.equal(MAIN.env, undefined, "the main job must not declare a job-wide env block");

  // PROOFLOOP_DEBUG_TOKEN must not appear in ANY executable surface of ANY step (env keys/values,
  // run bodies, with-blocks) across ALL jobs. YAML comments are stripped by the parser, so an
  // explanatory comment that names it does not trip this.
  for (const s of allSteps()) {
    assert.ok(
      !executableSurface(s).includes("PROOFLOOP_DEBUG_TOKEN"),
      `PROOFLOOP_DEBUG_TOKEN must not appear in any executable surface of "${s.name ?? s.id ?? "?"}"`,
    );
  }

  // Per main-job step: SUT-only env vars (PROOFLOOP_BUGS/APP_PORT) and SESSION_SECRET handling.
  for (const s of STEPS) {
    const name = s.name ?? "";
    const envKeys = Object.keys(s.env ?? {});
    const run = s.run ?? "";
    const isBoot = name.includes("Boot SUT");

    for (const v of ["PROOFLOOP_BUGS", "APP_PORT"]) {
      if (envKeys.includes(v)) assert.ok(isBoot, `${v} env may appear only on the SUT boot step (found on "${name}")`);
    }
    assert.ok(!envKeys.includes("SESSION_SECRET"), `SESSION_SECRET must never be a step env key (on "${name}")`);
    if (run.includes("SESSION_SECRET")) {
      assert.ok(isBoot, `SESSION_SECRET may be generated only in the SUT boot command (found in "${name}")`);
      for (const line of run.split("\n")) {
        if (line.includes("SESSION_SECRET")) {
          assert.ok(!line.includes("GITHUB_ENV"), `SESSION_SECRET must never be written to $GITHUB_ENV: ${line.trim()}`);
        }
      }
    }
  }

  // The SUT boot step is the ONLY step carrying SUT-only vars as env, and exactly these two.
  const boot = step("Boot SUT");
  assert.deepEqual(
    Object.keys(boot.env ?? {}).filter((k) => SUT_ONLY.includes(k)).sort(),
    ["APP_PORT", "PROOFLOOP_BUGS"],
    "SUT boot carries exactly APP_PORT + PROOFLOOP_BUGS as SUT-only env",
  );

  // Every non-SUT step (tester, aggregation, upload, teardown, enforcement, ledger) receives NO
  // SUT-only env var.
  for (const s of STEPS) {
    if ((s.name ?? "").includes("Boot SUT")) continue;
    const leaked = Object.keys(s.env ?? {}).filter((k) => SUT_ONLY.includes(k));
    assert.deepEqual(leaked, [], `"${s.name}" must receive no SUT-only env vars (found ${leaked.join(", ")})`);
  }

  // Tester/model steps receive ONLY their allowed tester configuration.
  for (const n of ["Preflight", "Run flows"]) {
    for (const k of Object.keys(step(n).env ?? {})) {
      assert.ok(TESTER_ALLOWED.includes(k), `"${n}" has an unexpected env var: ${k}`);
    }
  }
});

// req 11 — no --summary call
test("req11: no executable command invokes --summary", () => {
  for (const s of allSteps()) {
    assert.ok(!(s.run ?? "").includes("--summary"), `--summary found in step "${s.name}"`);
  }
  assert.ok(!RAW.includes("--summary"), "raw-file guard: --summary absent");
});

// req 12 — no execution retry: each CLI runs once in one manifest loop, no retry construct
test("req12: the flow loop runs each CLI exactly once with no retry construct", () => {
  const run = step("Run flows").run ?? "";
  const count = (re: RegExp) => (run.match(re) ?? []).length;
  assert.equal(count(/npm run run --/g), 1, "exactly one `npm run run --`");
  assert.equal(count(/npm run verify --/g), 1, "exactly one `npm run verify --`");
  assert.equal(count(/npm run report --/g), 1, "exactly one `npm run report --`");
  assert.equal(count(/for flowPath in/g), 1, "exactly one manifest-flow loop");
  assert.ok(!/\buntil\b/.test(run), "no until-loop retry in the flow loop");
  assert.ok(!/\bretry\b|\battempt\b|\brerun\b/i.test(run), "no retry/attempt/rerun construct");
  assert.equal(MAIN.strategy, undefined, "no job strategy/matrix");
});

// req 13 — serial execution: one loop, run→verify→report order, no backgrounding
test("req13: flows execute serially (one loop, ordered CLIs, no backgrounding/matrix)", () => {
  assert.equal(MAIN.strategy, undefined, "no matrix strategy");
  const run = step("Run flows").run ?? "";
  assert.match(run, /for flowPath in/, "one loop iterates the manifest flows");
  const iRun = run.indexOf("npm run run --");
  const iVerify = run.indexOf("npm run verify --");
  const iReport = run.indexOf("npm run report --");
  assert.ok(iRun >= 0 && iRun < iVerify && iVerify < iReport, "run → verify → report inside the loop");
  assert.ok(!run.includes("setsid"), "no flow is launched via setsid (that's the SUT boot, a different step)");
  for (const line of run.split("\n")) {
    const t = line.trim();
    assert.ok(!(t.endsWith("&") && !t.endsWith("&&")), `flow CLI must not be backgrounded: ${t}`);
  }
});

// req 14 — app-not-ready path still reaches aggregation
test("req14: the app-not-ready branch updates all flows and still reaches aggregation", () => {
  assert.match(String(step("Mark all flows").if), /app_ready != 'true'/);
  assert.match(String(step("Run flows").if), /app_ready == 'true'/);
  assert.equal(step("Aggregate").if, undefined, "aggregation is unconditional w.r.t. readiness");
  assert.ok(idx("Mark all flows") < idx("Aggregate"), "mark-all precedes aggregation");
  assert.ok(idx("Run flows") < idx("Aggregate"), "the run loop precedes aggregation");
  assert.match(String(step("Mark all flows").run), /mark-all-error/, "the not-ready path marks EVERY flow via ledger mark-all-error");
});

// req 18 — sticky comment: always()+PR-only, same-repo gated, marker-based upsert (no dup create)
test("req18: sticky comment is always()+PR-only, same-repo gated, marker-based single upsert", () => {
  const c = step("Upsert sticky PR comment");
  assert.match(String(c.if), /always\(\)/, "runs always()");
  assert.match(String(c.if), /github\.event_name == 'pull_request'/, "PR events only");
  // Same-repository authorization is inherited from the main job's gate + the authorize rule.
  assert.match(String(MAIN.if), /needs\.authorize\.outputs\.authorized == 'true'/, "main job is same-repo gated");
  const authRun = String(DOC.jobs.authorize.steps[0].run ?? "");
  assert.match(authRun, /head\.repo\.full_name.*github\.repository/, "authorize permits only same-repository PRs");
  // Script: marker, summary-file availability (try/catch on summary.md), search, update-or-create.
  const script = String((c.with as Record<string, unknown>).script);
  assert.ok(script.includes("<!-- proofloop-ci -->"), "uses the upsert marker");
  assert.match(script, /summary\.md/, "reads the generated summary file");
  assert.match(script, /try\s*\{[\s\S]*readFileSync[\s\S]*\}\s*catch/, "handles summary-file availability (fallback)");
  assert.match(script, /\.find\([\s\S]*includes\(marker\)/, "searches for an existing marker comment");
  assert.match(
    script,
    /if \(existing\)\s*\{[\s\S]*updateComment[\s\S]*\}\s*else\s*\{[\s\S]*createComment/,
    "updates when found, creates ONLY in the else branch (no unconditional create)",
  );
});

// req 19 — no ground-truth (bug-ledger / expected-verdict / coverage) leaks into the workflow
test("req19: no bug-ledger / expected-verdict / coverage ground-truth appears in the workflow", () => {
  const forbidden = [
    /\bBUG-\d+\b/i, /bug-ledger/i, /bug_ledger/i,
    /expectedVerdict/i, /expected_verdict/i, /expected verdict/i,
    /flow-coverage/i, /fixtures\/bug-ledger/i,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(RAW), `forbidden ground-truth reference matched ${re}`);
  }
  // The generic `bugs` input / PROOFLOOP_BUGS are allowed only as the SUT config surface — never
  // interpreted into an expected outcome and never on a tester step (proven in req8/9/10).
});
