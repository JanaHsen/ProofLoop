/**
 * Phase 5 Task 6 — non-live proofs for the deterministic checkpoint-parity harness. These
 * run in the ordinary `npm test` suite (no browser, no SUT, no API). They prove the harness
 * uses ONLY the production launch path, passes the requested mode, never reconstructs launch
 * args, compares via the frozen Task 4 comparator, never converts a mismatch into success,
 * imports no LLM surface, and that the Task 2 alternate launch seam is gone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseSnapshot } from "../src/mcp/snapshot";
import {
  McpClientOptions,
  PlaywrightMcpClient,
  resolveLaunchArgs,
} from "../src/mcp/client";
import {
  CheckpointParityError,
  assertCheckpointParity,
  captureCheckpoint,
  captureClientOptions,
  checkCheckpointParity,
  productionClientFactory,
  scrubAndDigest,
  type CheckpointCapture,
} from "./parity/checkpoint-capture";

const rmrf = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** A stub that satisfies the client surface captureCheckpoint uses — no browser launched. */
function stubClient(): PlaywrightMcpClient {
  const snap = parseSnapshot(
    '- generic [ref=e1]:\n  - button "Go" [ref=e8]',
    "### Page\n- Page URL: http://x/login\n- Page Title: Login",
  );
  return {
    async launch() {},
    async navigate() {},
    async snapshot() {
      return snap;
    },
    async close() {},
  } as unknown as PlaywrightMcpClient;
}

function cap(id: string, mode: "headed" | "headless", yaml: string): CheckpointCapture {
  const { scrubbedYaml, digest } = scrubAndDigest(yaml);
  return { captureId: id, mode, route: "/login", url: "http://x/login", refCount: 0, scrubbedYaml, digest };
}

// 1 ---------------------------------------------------------------------------------
test("Task6: the default factory constructs the ordinary production client (no subclass)", () => {
  const c = productionClientFactory({ viewport: "desktop", outputDir: os.tmpdir(), mode: "headless" });
  assert.ok(c instanceof PlaywrightMcpClient);
  assert.equal(Object.getPrototypeOf(c), PlaywrightMcpClient.prototype, "exactly the production class");
});

// 2 ---------------------------------------------------------------------------------
test("Task6: captureCheckpoint passes the requested production BrowserMode", async () => {
  const recorded: McpClientOptions[] = [];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "task6-mode-"));
  try {
    await captureCheckpoint(
      { captureId: "x", mode: "headed", baseUrl: "http://x", route: "/login", outputDir: out },
      (opts) => {
        recorded.push(opts);
        return stubClient();
      },
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].mode, "headed");
  } finally {
    rmrf(out);
  }
});

// 3 ---------------------------------------------------------------------------------
test("Task6: the harness does not override or reconstruct launch arguments", () => {
  const code = stripComments(
    fs.readFileSync(path.join(__dirname, "parity", "checkpoint-capture.ts"), "utf8"),
  );
  for (const forbidden of ["buildServerArgs", "HEADLESS_FLAG", "buildLaunchArgs", "extends PlaywrightMcpClient", "--headless"]) {
    assert.ok(!code.includes(forbidden), `harness must not reference ${forbidden}`);
  }
  // It relies on the production resolveLaunchArgs via McpClientOptions.mode only:
  const opts = (mode: "headed" | "headless") =>
    captureClientOptions({ captureId: "x", mode, baseUrl: "b", route: "/r", outputDir: "/o" });
  assert.ok(!resolveLaunchArgs(opts("headed")).includes("--headless"));
  assert.equal(resolveLaunchArgs(opts("headless")).filter((a) => a === "--headless").length, 1);
});

// 4 ---------------------------------------------------------------------------------
test("Task6: both captures share viewport + non-mode config and differ only by mode", async () => {
  const recorded: McpClientOptions[] = [];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "task6-cfg-"));
  const factory = (opts: McpClientOptions) => {
    recorded.push(opts);
    return stubClient();
  };
  try {
    await captureCheckpoint({ captureId: "h", mode: "headed", baseUrl: "http://x", route: "/login", outputDir: path.join(out, "h") }, factory);
    await captureCheckpoint({ captureId: "l", mode: "headless", baseUrl: "http://x", route: "/login", outputDir: path.join(out, "l") }, factory);
    assert.equal(recorded[0].viewport, recorded[1].viewport); // identical viewport
    assert.equal(recorded[0].viewport, "desktop");
    assert.notEqual(recorded[0].mode, recorded[1].mode); // mode is the only intended browser variable
    // the per-capture outputDir is the isolation requirement (fresh profile), not a config branch.
    assert.notEqual(recorded[0].outputDir, recorded[1].outputDir);
  } finally {
    rmrf(out);
  }
});

// 5 ---------------------------------------------------------------------------------
test("Task6: parity comparison uses the frozen compareSnapshotYaml", () => {
  const src = fs.readFileSync(path.join(__dirname, "parity", "checkpoint-capture.ts"), "utf8");
  assert.ok(/compareSnapshotYaml/.test(src) && /parity\/snapshot-parity/.test(src));
  const y = '- generic [active] [ref=e1]:\n  - button "Go" [ref=e8] [cursor=pointer]';
  const out = checkCheckpointParity(cap("h", "headed", y), cap("l", "headless", y));
  assert.equal(out.result.equal, true);
  assert.equal(out.byteEqual, true);
  assert.equal(out.digestEqual, true);
  assert.deepEqual(out.result.labels, { left: "headed", right: "headless" });
});

// 6 ---------------------------------------------------------------------------------
test("Task6: a synthetic mismatch surfaces the frozen structured diff", () => {
  const out = checkCheckpointParity(
    cap("h", "headed", '- button "Go" [ref=e8]'),
    cap("l", "headless", '- button "Stop" [ref=e8]'),
  );
  assert.equal(out.result.equal, false);
  assert.ok(out.result.differences.length > 0);
  assert.ok(out.result.differences.some((d) => d.path.endsWith("name")));
  assert.equal(out.byteEqual, false);
  assert.equal(out.digestEqual, false);
});

// 7 ---------------------------------------------------------------------------------
test("Task6: a mismatch is never converted into success", () => {
  const mismatch = checkCheckpointParity(cap("h", "headed", "- a [ref=e1]"), cap("l", "headless", "- b [ref=e1]"));
  assert.throws(() => assertCheckpointParity(mismatch), CheckpointParityError);
  try {
    assertCheckpointParity(mismatch);
    assert.fail("expected CheckpointParityError");
  } catch (e) {
    assert.ok(e instanceof CheckpointParityError);
    assert.ok(e.outcome.result.differences.length > 0, "structured diff preserved on the error");
  }
  // an equal pair does NOT throw
  assert.doesNotThrow(() =>
    assertCheckpointParity(checkCheckpointParity(cap("h", "headed", "- a [ref=e1]"), cap("l", "headless", "- a [ref=e1]"))),
  );
});

// 8 ---------------------------------------------------------------------------------
test("Task6: the harness imports no decider/verifier/summary/LLM surface", () => {
  for (const rel of ["parity/checkpoint-capture.ts", "checkpoint-parity-live.test.ts"]) {
    const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
    const importPaths = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const p of importPaths) {
      assert.ok(!/decider|verifier|summary|anthropic/i.test(p), `${rel} must not import "${p}"`);
    }
  }
});

// 9 ---------------------------------------------------------------------------------
test("Task6: the Task 2 alternate launch seam no longer exists", () => {
  assert.ok(
    !fs.existsSync(path.join(__dirname, "investigation", "mode-delta.ts")),
    "the investigation subclass module must be removed",
  );
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        out.push(...walk(full));
      } else if (e.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  };
  const CLIENT = path.join(__dirname, "..", "src", "mcp", "client.ts");
  const files = [...walk(path.join(__dirname)), ...walk(path.join(__dirname, "..", "src"))];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    // actual subclass syntax (not a string/regex literal that merely names the token)
    assert.ok(!/class\s+\w+\s+extends\s+PlaywrightMcpClient/.test(code), `${f} must not subclass the production client`);
    // an actual buildLaunchArgs definition/call may live ONLY in the production client
    if (/buildLaunchArgs\s*\(/.test(code)) {
      assert.equal(path.resolve(f), path.resolve(CLIENT), `buildLaunchArgs may live only in the production client (found in ${f})`);
    }
  }
});
