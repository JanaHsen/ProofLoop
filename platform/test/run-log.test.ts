import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { digestSnapshot, extractYamlBlock, parseSnapshot, validateRef } from "../src/mcp/snapshot";
import { browserConfigFor } from "../src/mcp/client";
import { parseFlow } from "../src/parser";
import { RunLogger, RunLoggerOptions } from "../src/run/logger";
import {
  inferCrashed,
  readEvents,
  readManifest,
  verifyAuditChain,
} from "../src/run/audit";
import {
  ActionEvent,
  InvalidRunManifestError,
  RUN_LOG_SCHEMA_VERSION,
  UnsupportedRunLogSchemaError,
  computePlanHash,
} from "../src/run/schema";

/** A valid, complete 1.2 mode-metadata triplet for the writer (headless, desktop). */
const MODE_META = {
  mode: "headless" as const,
  requestedMode: "headless" as const,
  browser: browserConfigFor("desktop"),
};

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
    ...MODE_META,
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
    // run-log 1.2: an un-threaded mode defaults to the CI-safe headless (was hardcoded
    // "headed" in 1.1); the explicit-mode contract is covered by the dedicated 1.2 test.
    assert.equal(m.mode, "headless");
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

test("run-log 1.1 reader reads a stored 1.0 run cleanly (no failureDetail on its actions)", () => {
  const root = tmpRoot();
  try {
    // Hand-build a 1.0 run dir (RunLogger now stamps 1.1, so a legacy run is constructed
    // directly). The action event has NO failureDetail/failureDetailTruncated — the 1.1
    // reader must tolerate their absence and the audit chain must still verify.
    const runDir = path.join(root, "legacy-1.0");
    fs.mkdirSync(path.join(runDir, "snapshots"), { recursive: true });
    const yaml = SNAP.yaml;
    const digest = digestSnapshot(yaml);
    const refs = [...SNAP.refs];
    const blob = {
      snapshotId: "snapshot-001",
      digest,
      yaml,
      refs,
      elements: SNAP.elements.map((e) => ({ ref: e.ref, role: e.role, ...(e.name !== undefined ? { name: e.name } : {}) })),
    };
    fs.writeFileSync(path.join(runDir, "snapshots", "snapshot-001.json"), JSON.stringify(blob, null, 2));

    const base = (seq: number) => ({ runLogSchemaVersion: "1.0", runId: "legacy-1.0", seq, ts: "2026-06-18T00:00:00.000Z" });
    const lines: unknown[] = [
      { ...base(1), type: "flow_start", flowId: "login", planHash: "sha256:plan", model: "claude-opus-4-8", entryUrl: "http://x/login" },
      { ...base(2), type: "snapshot", snapshotId: "snapshot-001", snapshotDigest: digest, path: "snapshots/snapshot-001.json", kind: "pre_action", refCount: refs.length, stepId: "login:S1" },
      { ...base(3), type: "action", decisionId: "decision-001", snapshotId: "snapshot-001", snapshotDigest: digest, ref: "e8", action: "click", refValidation: { valid: true, validatedBy: "harness" }, resolvedFrom: "snapshot-001", status: "executed", stepId: "login:S1" },
      { ...base(4), type: "flow_end", executionStatus: "completed" },
    ];
    fs.writeFileSync(path.join(runDir, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runLogSchemaVersion: "1.0",
        runId: "legacy-1.0",
        flowId: "login",
        planHash: "sha256:plan",
        model: "claude-opus-4-8",
        mode: "headed",
        startedAt: "2026-06-18T00:00:00.000Z",
        finishedAt: "2026-06-18T00:00:01.000Z",
        executionStatus: "completed",
        pricingConfigId: "anthropic-2026-06",
        totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, snapshotCount: 1, actionCount: 1, errorCount: 0, retryCount: 0 },
      }, null, 2),
    );

    const { events, truncatedFinalLine } = readEvents(path.join(runDir, "events.jsonl"));
    assert.equal(truncatedFinalLine, false);
    for (const e of events) assert.equal(e.runLogSchemaVersion, "1.0"); // version preserved, never rewritten
    const action = events.find((e) => e.type === "action") as ActionEvent;
    assert.equal(action.failureDetail, undefined);
    assert.equal(action.failureDetailTruncated, undefined);
    // the audit chain still verifies a 1.0 run under the 1.1 reader
    const report = verifyAuditChain(runDir);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
    assert.equal(readManifest(runDir).runLogSchemaVersion, "1.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readers accept supported run-log versions (1.0, 1.1, 1.2, 1.3) and reject an unknown future version", () => {
  const root = tmpRoot();
  try {
    const p = path.join(root, "events.jsonl");
    const ev = (v: string) =>
      JSON.stringify({
        runLogSchemaVersion: v,
        runId: "r",
        seq: 1,
        ts: "2026-06-18T00:00:00.000Z",
        type: "flow_start",
        flowId: "f",
        planHash: "sha256:plan",
        model: "m",
        entryUrl: "http://x/login",
      }) + "\n";

    // every supported version parses cleanly (1.2 added in Phase 5 / D35; 1.3 in D48)
    for (const v of ["1.0", "1.1", "1.2", "1.3"]) {
      fs.writeFileSync(p, ev(v));
      assert.equal(readEvents(p).events.length, 1, `events v${v} must read`);
    }

    // an unknown future version is rejected with the stable unsupported-schema error
    fs.writeFileSync(p, ev("2.0"));
    assert.throws(() => readEvents(p), UnsupportedRunLogSchemaError);
    assert.throws(() => readEvents(p), /unsupported runLogSchemaVersion "2\.0" \(supported: 1\.0, 1\.1, 1\.2, 1\.3\)/);

    // the manifest reader gates the same way: a stored 1.1 manifest still reads under the
    // 1.2 readers; a future 2.0 manifest is rejected.
    const okDir = path.join(root, "run-1.1");
    fs.mkdirSync(okDir, { recursive: true });
    fs.writeFileSync(
      path.join(okDir, "run.json"),
      JSON.stringify({ runLogSchemaVersion: "1.1", runId: "run-1.1", mode: "headed", executionStatus: "completed" }),
    );
    assert.equal(readManifest(okDir).runLogSchemaVersion, "1.1");

    const runDir = path.join(root, "run-future");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({ runLogSchemaVersion: "2.0", runId: "run-future", executionStatus: "completed" }),
    );
    assert.throws(() => readManifest(runDir), UnsupportedRunLogSchemaError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("current run-log manifest records effective mode + requestedMode + typed browser; no raw subprocess args", () => {
  const root = tmpRoot();
  try {
    const logger = new RunLogger({
      runsRoot: root,
      runId: "run-1.2",
      flowId: "login",
      planHash: "sha256:plan",
      model: "claude-opus-4-8",
      pricingConfigId: "anthropic-2026-06",
      mode: "headed",
      requestedMode: "headed",
      browser: {
        engine: "chromium",
        isolated: true,
        viewport: { width: 1280, height: 720 },
        accessibilitySnapshots: true,
        visionEnabled: false,
      },
      now: FIXED_NOW,
    });
    logger.finalize("completed");

    const m = readManifest(logger.runDir);
    assert.equal(m.runLogSchemaVersion, RUN_LOG_SCHEMA_VERSION);
    assert.equal(m.mode, "headed");
    assert.equal(m.requestedMode, "headed");
    assert.deepEqual(m.browser, {
      engine: "chromium",
      isolated: true,
      viewport: { width: 1280, height: 720 },
      accessibilitySnapshots: true,
      visionEnabled: false,
    });

    // No raw subprocess argument string leaks into the manifest (D36).
    const raw = fs.readFileSync(path.join(logger.runDir, "run.json"), "utf8");
    for (const arg of ["--headless", "--isolated", "--viewport-size", "--snapshot-mode", "cli.js", "--output-dir"]) {
      assert.ok(!raw.includes(arg), `manifest must not contain raw arg ${arg}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("1.2 writer requires complete, consistent mode metadata — no silent default", () => {
  const root = tmpRoot();
  try {
    const base = {
      runsRoot: root,
      runId: "bad",
      flowId: "login",
      planHash: "sha256:plan",
      model: "m",
      pricingConfigId: "anthropic-2026-06",
      ...MODE_META,
      now: FIXED_NOW,
    };
    const make = (over: Record<string, unknown>): RunLogger =>
      new RunLogger({ ...base, ...over } as unknown as RunLoggerOptions);

    // a missing mode must NOT silently become headless — it must throw
    assert.throws(() => make({ mode: undefined }), InvalidRunManifestError);
    assert.throws(() => make({ requestedMode: undefined }), InvalidRunManifestError);
    // requestedMode !== mode is an internal contradiction (D36: no silent fallback)
    assert.throws(
      () => make({ mode: "headed", requestedMode: "headless" }),
      /must equal effective mode/,
    );
    // an incomplete browser config is rejected
    assert.throws(
      () => make({ browser: { engine: "chromium" } }),
      /browser config is missing or incomplete/,
    );
    // the valid triplet constructs fine (and is the only accepted shape)
    assert.doesNotThrow(() => make({}));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readManifest enforces the 1.2 mode contract; 1.0/1.1 may omit the new fields", () => {
  const root = tmpRoot();
  try {
    const full = {
      runLogSchemaVersion: "1.2",
      runId: "m",
      flowId: "login",
      planHash: "sha256:plan",
      model: "m",
      mode: "headless",
      requestedMode: "headless",
      browser: browserConfigFor("desktop"),
      startedAt: "2026-06-18T00:00:00.000Z",
      executionStatus: "completed",
      pricingConfigId: "anthropic-2026-06",
      totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, snapshotCount: 0, actionCount: 0, errorCount: 0, retryCount: 0 },
    };
    let n = 0;
    const write = (over: Record<string, unknown>): string => {
      const dir = path.join(root, `m${n++}`);
      fs.mkdirSync(dir, { recursive: true });
      // JSON.stringify drops `undefined` keys → that field is absent from the manifest.
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...full, ...over }));
      return dir;
    };

    // a complete 1.2 manifest reads
    assert.equal(readManifest(write({})).runLogSchemaVersion, "1.2");
    // a 1.2 manifest missing requestedMode is rejected
    assert.throws(() => readManifest(write({ requestedMode: undefined })), InvalidRunManifestError);
    // a 1.2 manifest with an incomplete browser is rejected
    assert.throws(() => readManifest(write({ browser: { engine: "chromium" } })), /browser config is missing or incomplete/);
    // a 1.2 manifest with requestedMode !== mode is rejected
    assert.throws(() => readManifest(write({ requestedMode: "headed" })), /must equal effective mode/);

    // stored 1.0 / 1.1 manifests WITHOUT requestedMode/browser still read successfully
    for (const v of ["1.0", "1.1"]) {
      const dir = write({ runLogSchemaVersion: v, mode: "headed", requestedMode: undefined, browser: undefined });
      const m = readManifest(dir);
      assert.equal(m.runLogSchemaVersion, v);
      assert.equal(m.requestedMode, undefined);
      assert.equal(m.browser, undefined);
    }
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
