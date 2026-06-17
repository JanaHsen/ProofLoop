import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildServerArgs } from "../src/mcp/client";
import {
  DISPATCH_ALLOWLIST,
  REQUIRED_TOOLS,
  isAllowedElementAction,
  isCoordinateTool,
} from "../src/mcp/tools";
import {
  digestSnapshot,
  extractPageInfo,
  extractSnapshotFileLink,
  extractYamlBlock,
  isRefToken,
  parseSnapshot,
} from "../src/mcp/snapshot";

const RESULT_FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "snapshot-result.txt"),
  "utf8",
);

// --- isolation / headed / vision config (D17 + Phase-2-headed + layer-1) ----------
// These assert the DELIBERATE launch choices in code, so isolation is proven by the
// spec the harness builds — not assumed from @playwright/mcp's defaults.

test("buildServerArgs: isolated, never persists a profile (D17)", () => {
  const args = buildServerArgs({ viewport: "desktop", outputDir: "/tmp/out" });
  assert.ok(args.includes("--isolated"), "must launch with --isolated");
  assert.ok(
    !args.includes("--user-data-dir"),
    "must not set a persistent user-data-dir",
  );
  assert.ok(
    !args.includes("--storage-state"),
    "must not seed storage state across flows",
  );
});

test("buildServerArgs: headed (Phase 2) and vision off (layer 1)", () => {
  const args = buildServerArgs({ viewport: "desktop", outputDir: "/tmp/out" });
  assert.ok(!args.includes("--headless"), "Phase 2 is headed throughout");
  assert.ok(!args.includes("--caps"), "vision/coordinate capability never enabled");
});

test("buildServerArgs: honors FlowPlan.viewport (never hardcoded desktop)", () => {
  const desktop = buildServerArgs({ viewport: "desktop", outputDir: "/tmp/o" });
  const mobile = buildServerArgs({ viewport: "mobile", outputDir: "/tmp/o" });
  assert.ok(desktop.includes("1280x720"));
  const mobileSize = mobile[mobile.indexOf("--viewport-size") + 1];
  assert.equal(mobileSize, "390x844");
  assert.ok(Number(mobileSize.split("x")[0]) <= 480, "mobile width must be <=480px");
});

test("buildServerArgs: snapshots returned inline, output dir wired", () => {
  const args = buildServerArgs({ viewport: "desktop", outputDir: "/tmp/run-1" });
  assert.equal(args[args.indexOf("--snapshot-mode") + 1], "full");
  assert.equal(args[args.indexOf("--output-mode") + 1], "stdout");
  assert.equal(args[args.indexOf("--output-dir") + 1], "/tmp/run-1");
  assert.ok(args[0].endsWith("cli.js") && fs.existsSync(args[0]), "cli.js resolved");
});

// --- two-layer tool lockout (D14 / D16) -------------------------------------------

test("dispatch allowlist is exactly the six harness tools", () => {
  assert.equal(DISPATCH_ALLOWLIST.size, 6);
  for (const t of REQUIRED_TOOLS) assert.ok(DISPATCH_ALLOWLIST.has(t));
  for (const forbidden of [
    "browser_evaluate",
    "browser_run_code_unsafe",
    "browser_fill_form",
    "browser_take_screenshot",
  ]) {
    assert.ok(!DISPATCH_ALLOWLIST.has(forbidden), `${forbidden} must not dispatch`);
  }
});

test("isCoordinateTool flags vision tools but not snapshot/screenshot/click", () => {
  for (const v of [
    "browser_mouse_click_xy",
    "browser_mouse_move_xy",
    "browser_screen_click",
    "browser_screen_capture",
  ]) {
    assert.ok(isCoordinateTool(v), `${v} should be flagged`);
  }
  for (const ok of [
    "browser_take_screenshot",
    "browser_click",
    "browser_type",
    "browser_snapshot",
  ]) {
    assert.ok(!isCoordinateTool(ok), `${ok} should NOT be flagged`);
  }
});

test("isAllowedElementAction accepts only click/type (D15)", () => {
  assert.ok(isAllowedElementAction("click"));
  assert.ok(isAllowedElementAction("type"));
  for (const x of ["navigate", "evaluate", "select", "press", ""]) {
    assert.ok(!isAllowedElementAction(x));
  }
});

// --- snapshot parsing (the audit-chain substrate) ---------------------------------

test("parseSnapshot: extracts every ref with role and accessible name", () => {
  const yaml = extractYamlBlock(RESULT_FIXTURE);
  assert.ok(yaml, "inline YAML block present");
  const snap = parseSnapshot(yaml!, RESULT_FIXTURE);

  assert.deepEqual(
    [...snap.refs].sort(),
    ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"],
  );
  const byRef = new Map(snap.elements.map((e) => [e.ref, e]));
  assert.deepEqual(
    { role: byRef.get("e5")!.role, name: byRef.get("e5")!.name },
    { role: "textbox", name: "Username" },
  );
  assert.deepEqual(
    { role: byRef.get("e8")!.role, name: byRef.get("e8")!.name },
    { role: "button", name: "Sign in" },
  );
  assert.equal(byRef.get("e9")!.role, "link");
  // a node without a ref (`- text: Username`) is not an element
  assert.equal(snap.elements.length, 9);
  assert.equal(snap.pageTitle, "Probe");
});

test("digestSnapshot is deterministic and sha256-prefixed", () => {
  const yaml = extractYamlBlock(RESULT_FIXTURE)!;
  const d1 = digestSnapshot(yaml);
  const d2 = digestSnapshot(yaml);
  assert.equal(d1, d2);
  assert.match(d1, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(d1, digestSnapshot(yaml + "\n- button [ref=e10]"));
});

test("isRefToken accepts eN tokens and rejects selectors", () => {
  for (const ok of ["e1", "e5", "e123"]) assert.ok(isRefToken(ok));
  for (const bad of ["#username", "button", "e", "e5x", ".btn", "//div"]) {
    assert.ok(!isRefToken(bad), `${bad} must be rejected`);
  }
});

test("extractSnapshotFileLink: file-delivery fallback is recognized", () => {
  const linkText =
    "### Snapshot\n- [Snapshot](.playwright-mcp/page-2026.yml)\n";
  assert.equal(
    extractSnapshotFileLink(linkText),
    ".playwright-mcp/page-2026.yml",
  );
  assert.equal(extractYamlBlock(linkText), null);
  assert.equal(extractPageInfo("- Page URL: http://x\n").pageUrl, "http://x");
});
