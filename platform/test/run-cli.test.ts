/**
 * Phase 6 Task 1 — run-cli: the D38 exit-code contract + the D39 --id-file emission.
 * Pure/in-process: the executor (live browser + LLM) is injected, so no network and no
 * browser are ever touched. We assert the PROCESS EXIT CODE for every approved branch and
 * that --id-file holds exactly the runId.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseRunArgs,
  runCli,
  type RunCliDeps,
  type RunInputs,
} from "../src/run-cli";
import { FlowParseError } from "../src/parser";
import type { FlowPlan } from "../src/flow-plan";
import type { EngineConfig } from "../src/config";
import type { ExecutionStatus, RunManifest } from "../src/run/schema";

// --- a stdout/stderr capture stream (defaults route to process streams) -----------
function capture() {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    write(s: string) {
      chunks.push(s);
      return true;
    },
  };
}

const FIXED_RUN_ID = "add-to-cart-2026-06-20T00-00-00-000Z-deadbeef";

const CONFIG: EngineConfig = {
  baseUrl: "http://localhost:3000",
  model: "claude-sonnet-4-6",
  verifierModel: "claude-opus-4-8",
  summaryModel: undefined,
  anthropicApiKey: "test-key-never-used",
  pricingConfigId: "anthropic-2026-06",
};

function fakePlan(): FlowPlan {
  return { id: "add-to-cart", viewport: "desktop" } as unknown as FlowPlan;
}

/** A finalized manifest carrying the given runId + status; only the fields the CLI reads. */
function fakeManifest(runId: string, status: ExecutionStatus): RunManifest {
  return {
    runId,
    executionStatus: status,
    mode: "headless",
    totals: {
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      snapshotCount: 0,
      actionCount: 0,
      errorCount: 0,
      retryCount: 0,
    },
  } as unknown as RunManifest;
}

/** Deps that never reach a live run: fixed runId, no-op display check, config with a key. */
function baseDeps(over: Partial<RunCliDeps>): Partial<RunCliDeps> {
  return {
    readConfig: () => CONFIG,
    assertDisplay: () => {},
    newRunId: () => FIXED_RUN_ID,
    parseFlow: () => fakePlan(),
    ...over,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-run-cli-"));
}

// ---------------------------------------------------------------------------------
// parseRunArgs — the new --id-file surface (existing --headed contract: mode-contract.test)
// ---------------------------------------------------------------------------------

test("parseRunArgs: --id-file captures the path (order-independent, with --headed)", () => {
  for (const args of [
    ["f.md", "--id-file", "x.txt"],
    ["--id-file", "x.txt", "f.md"],
    ["f.md", "--id-file", "x.txt", "--headed"],
  ]) {
    const r = parseRunArgs(args);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.idFilePath, "x.txt");
    assert.equal(r.ok && r.flowPath, "f.md");
  }
});

test("parseRunArgs: --id-file requires a path argument", () => {
  assert.equal(parseRunArgs(["f.md", "--id-file"]).ok, false);
  assert.equal(parseRunArgs(["f.md", "--id-file", "--headed"]).ok, false);
});

test("parseRunArgs: absent --id-file ⇒ idFilePath omitted (result shape unchanged)", () => {
  assert.deepEqual(parseRunArgs(["f.md"]), {
    ok: true,
    flowPath: "f.md",
    requestedMode: "headless",
  });
});

// ---------------------------------------------------------------------------------
// D38 exit-code contract
// ---------------------------------------------------------------------------------

test("runCli: exits 0 on success and --id-file holds exactly the printed runId", async () => {
  const dir = tmpDir();
  const idFile = path.join(dir, "run-id.txt");
  const out = capture();
  try {
    const code = await runCli(
      ["node", "run-cli", "f.flow.md", "--id-file", idFile],
      baseDeps({
        execute: async (i: RunInputs) => fakeManifest(i.runId, "completed"),
        out,
        err: capture(),
      }),
    );
    assert.equal(code, 0);
    const content = fs.readFileSync(idFile, "utf8");
    assert.equal(content, `${FIXED_RUN_ID}\n`, "exactly the id + a single trailing newline");
    assert.equal(content.replace(/\n$/, ""), FIXED_RUN_ID);
    assert.ok(
      out.text().includes(`runId=${FIXED_RUN_ID}`),
      "the id file equals the runId printed on stdout",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: a finalized run exits 0 for EVERY recorded executionStatus (D38)", async () => {
  // The load-bearing delta: blocked/guard_tripped/error/cancelled are DATA, not failures.
  const statuses: ExecutionStatus[] = [
    "completed",
    "blocked",
    "guard_tripped",
    "error",
    "cancelled",
  ];
  for (const status of statuses) {
    const code = await runCli(
      ["node", "run-cli", "f.flow.md"],
      baseDeps({
        execute: async (i: RunInputs) => fakeManifest(i.runId, status),
        out: capture(),
        err: capture(),
      }),
    );
    assert.equal(code, 0, `executionStatus=${status} must exit 0`);
  }
});

test("runCli: exits 2 on invalid args (≠ one positional)", async () => {
  assert.equal(
    await runCli(["node", "run-cli"], baseDeps({ out: capture(), err: capture() })),
    2,
  );
  assert.equal(
    await runCli(
      ["node", "run-cli", "a.md", "b.md"],
      baseDeps({ out: capture(), err: capture() }),
    ),
    2,
  );
});

test("runCli: exits 2 on missing config (no ANTHROPIC_API_KEY)", async () => {
  const code = await runCli(
    ["node", "run-cli", "f.flow.md"],
    baseDeps({
      readConfig: () => ({ ...CONFIG, anthropicApiKey: undefined }),
      out: capture(),
      err: capture(),
    }),
  );
  assert.equal(code, 2);
});

test("runCli: exits 1 on a malformed flow", async () => {
  const code = await runCli(
    ["node", "run-cli", "bad.flow.md"],
    baseDeps({
      parseFlow: () => {
        throw new FlowParseError("missing Steps section");
      },
      out: capture(),
      err: capture(),
    }),
  );
  assert.equal(code, 1);
});

test("runCli: an --id-file write failure exits non-zero (no false success)", async () => {
  const out = capture();
  const err = capture();
  const code = await runCli(
    ["node", "run-cli", "f.flow.md", "--id-file", "/definitely/not/writable/run-id.txt"],
    baseDeps({
      execute: async (i: RunInputs) => fakeManifest(i.runId, "completed"),
      writeIdFile: () => {
        throw new Error("EACCES: simulated write failure");
      },
      out,
      err,
    }),
  );
  assert.equal(code, 1);
  assert.ok(err.text().includes("failed to write --id-file"));
});

test("runCli: an uncaught crash before finalize propagates (process exits non-zero)", async () => {
  // No trustworthy artifact → must NOT exit 0. The top-level wrapper turns this into exit 1.
  await assert.rejects(() =>
    runCli(
      ["node", "run-cli", "f.flow.md"],
      baseDeps({
        execute: async () => {
          throw new Error("run crashed before finalizing an artifact");
        },
        out: capture(),
        err: capture(),
      }),
    ),
  );
});
