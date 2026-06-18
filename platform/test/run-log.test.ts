import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractYamlBlock, parseSnapshot, validateRef } from "../src/mcp/snapshot";
import { parseFlow } from "../src/parser";
import { RunLogger } from "../src/run/logger";
import {
  inferCrashed,
  readEvents,
  readManifest,
  verifyAuditChain,
} from "../src/run/audit";
import { RUN_LOG_SCHEMA_VERSION, computePlanHash } from "../src/run/schema";

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "snapshot-result.txt"),
  "utf8",
);
const SNAP = parseSnapshot(extractYamlBlock(FIXTURE)!, FIXTURE);
const FIXED_NOW = () => new Date("2026-06-18T00:00:00.000Z");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-runs-"));
}

function newLogger(runsRoot: string, runId: string): RunLogger {
  return new RunLogger({
    runsRoot,
    runId,
    flowId: "login",
    planHash: "sha256:plan",
    model: "claude-opus-4-8",
    pricingConfigId: "anthropic-2026-06",
    now: FIXED_NOW,
  });
}

/** Drive a small valid run: flow_start → snapshot → llm_decision → action → finalize. */
function writeValidRun(runsRoot: string, runId: string): string {
  const logger = newLogger(runsRoot, runId);
  logger.append({
    type: "flow_start",
    flowId: "login",
    planHash: "sha256:plan",
    model: "claude-opus-4-8",
    entryUrl: "http://localhost:3000/login",
  });
  const { snapshotId, digest } = logger.recordSnapshot(SNAP, "pre_action", [], "login:S1");
  const v = validateRef(SNAP, "e8");
  assert.ok(v.valid);
  logger.append({
    type: "llm_decision",
    decisionId: "decision-001",
    snapshotId,
    snapshotDigest: digest,
    decision: { kind: "action", action: "click", ref: "e8", rationale: "submit" },
    usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0.00625,
    latencyMs: 800,
    stepId: "login:S1",
  });
  logger.append({
    type: "action",
    decisionId: "decision-001",
    snapshotId,
    snapshotDigest: digest,
    ref: "e8",
    action: "click",
    refValidation: { valid: true, validatedBy: "harness" },
    resolvedFrom: snapshotId,
    status: "executed",
    stepId: "login:S1",
  });
  logger.finalize("completed");
  return logger.runDir;
}

test("seq is single-writer, strictly increasing; events carry version + runId", () => {
  const root = tmpRoot();
  try {
    const runDir = writeValidRun(root, "run-1");
    const { events, truncatedFinalLine } = readEvents(path.join(runDir, "events.jsonl"));
    assert.equal(truncatedFinalLine, false);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
    for (const e of events) {
      assert.equal(e.runLogSchemaVersion, RUN_LOG_SCHEMA_VERSION);
      assert.equal(e.runId, "run-1");
    }
    assert.deepEqual(events.map((e) => e.type), ["flow_start", "snapshot", "llm_decision", "action"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest finalizes atomically with terminal status + accrued totals", () => {
  const root = tmpRoot();
  try {
    const runDir = writeValidRun(root, "run-2");
    const m = readManifest(runDir);
    assert.equal(m.executionStatus, "completed");
    assert.equal(m.mode, "headed");
    assert.ok(m.finishedAt);
    assert.equal(m.runLogSchemaVersion, RUN_LOG_SCHEMA_VERSION);
    assert.deepEqual(m.totals, {
      promptTokens: 1000,
      completionTokens: 50,
      costUsd: 0.00625,
      latencyMs: 800,
      snapshotCount: 1,
      actionCount: 1,
      errorCount: 0,
      retryCount: 0,
    });
    // atomic finalize leaves no temp file behind
    assert.ok(!fs.existsSync(path.join(runDir, "run.json.tmp")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crashed is reader-inferred only (running manifest => crashed)", () => {
  const root = tmpRoot();
  try {
    const logger = newLogger(root, "run-3");
    // mid-run: manifest is "running" on disk
    assert.equal(inferCrashed(readManifest(logger.runDir)), true);
    logger.finalize("completed");
    assert.equal(inferCrashed(readManifest(logger.runDir)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit chain re-verifies from stored artifacts only", () => {
  const root = tmpRoot();
  try {
    const runDir = writeValidRun(root, "run-4");
    const report = verifyAuditChain(runDir);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.findings[0], { decisionId: "decision-001", ref: "e8", ok: true, problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit chain catches a ref not present in the referenced snapshot", () => {
  const root = tmpRoot();
  try {
    const logger = newLogger(root, "run-5");
    const { snapshotId, digest } = logger.recordSnapshot(SNAP, "pre_action");
    logger.append({
      type: "action",
      decisionId: "decision-x",
      snapshotId,
      snapshotDigest: digest,
      ref: "e999", // not in the snapshot
      action: "click",
      refValidation: { valid: true, validatedBy: "harness" },
      resolvedFrom: snapshotId,
      status: "executed",
    });
    logger.finalize("completed");
    const report = verifyAuditChain(logger.runDir);
    assert.equal(report.ok, false);
    assert.match(report.findings[0].problems.join(" "), /e999 not present/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit chain catches a tampered snapshot blob (digest mismatch)", () => {
  const root = tmpRoot();
  try {
    const runDir = writeValidRun(root, "run-6");
    const blobPath = path.join(runDir, "snapshots", "snapshot-001.json");
    const blob = JSON.parse(fs.readFileSync(blobPath, "utf8"));
    blob.yaml = blob.yaml + "\n- injected [ref=e500]";
    fs.writeFileSync(blobPath, JSON.stringify(blob, null, 2));
    const report = verifyAuditChain(runDir);
    assert.equal(report.ok, false);
    assert.match(report.findings[0].problems.join(" "), /digest mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readEvents tolerates exactly one truncated final line", () => {
  const root = tmpRoot();
  try {
    const p = path.join(root, "events.jsonl");
    fs.writeFileSync(p, '{"seq":1,"type":"flow_start"}\n{"seq":2,"type":"snapshot"}\n{"seq":3,"type":"act');
    const { events, truncatedFinalLine } = readEvents(p);
    assert.equal(events.length, 2);
    assert.equal(truncatedFinalLine, true);
    // a clean trailing newline is not a truncation
    fs.writeFileSync(p, '{"seq":1,"type":"flow_start"}\n');
    assert.deepEqual(readEvents(p), { events: [{ seq: 1, type: "flow_start" }], truncatedFinalLine: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computePlanHash is deterministic, sha256-prefixed, plan-sensitive", () => {
  const a = parseFlow("---\nname: Demo\nentry: /x\n---\n\n## Steps\n1. Do a thing.\n\n## Acceptance Criteria\n- Something is true.\n", "demo");
  const b = parseFlow("---\nname: Demo\nentry: /y\n---\n\n## Steps\n1. Do a thing.\n\n## Acceptance Criteria\n- Something is true.\n", "demo");
  const h1 = computePlanHash(a);
  assert.equal(h1, computePlanHash(a));
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(h1, computePlanHash(b));
});
