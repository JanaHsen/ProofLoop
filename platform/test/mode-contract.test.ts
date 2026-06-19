/**
 * Phase 5 Task 3 — headed/headless mode contract (D32/D36). Pure unit tests, no browser
 * and no API: the CLI parse, the launch-seam mode→argv resolution, the headed-without-
 * display loud failure, and the viewport dimensions used by the typed browser config.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseRunArgs } from "../src/run-cli";
import {
  HEADLESS_FLAG,
  HeadedDisplayUnavailableError,
  assertHeadedDisplay,
  browserConfigFor,
  buildServerArgs,
  effectiveMode,
  isDisplayAvailable,
  resolveLaunchArgs,
  viewportDimensions,
} from "../src/mcp/client";

const OPTS = { viewport: "desktop", outputDir: "/tmp/out" } as const;

// --- CLI parsing: one positional + the single --headed override ------------------

test("parseRunArgs: default is headless", () => {
  const r = parseRunArgs(["flows/login.flow.md"]);
  assert.deepEqual(r, { ok: true, flowPath: "flows/login.flow.md", requestedMode: "headless" });
});

test("parseRunArgs: --headed selects headed (order-independent)", () => {
  for (const args of [["f.md", "--headed"], ["--headed", "f.md"]]) {
    const r = parseRunArgs(args);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.requestedMode, "headed");
    assert.equal(r.ok && r.flowPath, "f.md");
  }
});

test("parseRunArgs: --headless is an unknown option (rejected loudly, no silent no-op)", () => {
  const r = parseRunArgs(["f.md", "--headless"]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /--headless/);
});

test("parseRunArgs: an unknown option is rejected", () => {
  const r = parseRunArgs(["f.md", "--watch"]);
  assert.equal(r.ok, false);
});

test("parseRunArgs: exactly one positional flow path is required", () => {
  assert.equal(parseRunArgs([]).ok, false);
  assert.equal(parseRunArgs(["a.md", "b.md"]).ok, false);
  assert.equal(parseRunArgs(["--headed"]).ok, false);
});

// --- launch seam: mode → argv (the ONLY place mode changes browser behavior) ------

test("effectiveMode defaults to headless", () => {
  assert.equal(effectiveMode(undefined), "headless");
  assert.equal(effectiveMode("headed"), "headed");
  assert.equal(effectiveMode("headless"), "headless");
});

test("resolveLaunchArgs: headed omits --headless and equals the mode-agnostic base", () => {
  const args = resolveLaunchArgs({ ...OPTS, mode: "headed" });
  assert.ok(!args.includes(HEADLESS_FLAG));
  assert.deepEqual(args, buildServerArgs(OPTS));
});

test("resolveLaunchArgs: headless adds exactly one --headless", () => {
  const args = resolveLaunchArgs({ ...OPTS, mode: "headless" });
  assert.equal(args.filter((a) => a === HEADLESS_FLAG).length, 1);
});

test("resolveLaunchArgs: omitted mode defaults to headless (one --headless)", () => {
  const args = resolveLaunchArgs(OPTS);
  assert.equal(args.filter((a) => a === HEADLESS_FLAG).length, 1);
});

test("resolveLaunchArgs: the headed/headless pair differs by ONLY the trailing --headless", () => {
  const headed = resolveLaunchArgs({ ...OPTS, mode: "headed" });
  const headless = resolveLaunchArgs({ ...OPTS, mode: "headless" });
  assert.deepEqual(headless.slice(0, headed.length), headed);
  assert.deepEqual(headless.slice(headed.length), [HEADLESS_FLAG]);
  assert.deepEqual(headless.filter((a) => a !== HEADLESS_FLAG), headed);
});

// --- headed-without-display fails loudly; never silently falls back ----------------

test("isDisplayAvailable: win32/darwin always; linux needs DISPLAY/WAYLAND_DISPLAY", () => {
  assert.equal(isDisplayAvailable({}, "win32"), true);
  assert.equal(isDisplayAvailable({}, "darwin"), true);
  assert.equal(isDisplayAvailable({}, "linux"), false);
  assert.equal(isDisplayAvailable({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(isDisplayAvailable({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
});

test("assertHeadedDisplay: headed without a display throws (no headless fallback)", () => {
  assert.throws(
    () => assertHeadedDisplay("headed", {}, "linux"),
    HeadedDisplayUnavailableError,
  );
  assert.throws(() => assertHeadedDisplay("headed", {}, "linux"), /Refusing to/);
});

test("assertHeadedDisplay: headless never throws; headed with a display is fine", () => {
  assert.doesNotThrow(() => assertHeadedDisplay("headless", {}, "linux"));
  assert.doesNotThrow(() => assertHeadedDisplay("headed", {}, "win32"));
  assert.doesNotThrow(() => assertHeadedDisplay("headed", { DISPLAY: ":0" }, "linux"));
});

// --- typed browser config dimensions ----------------------------------------------

test("viewportDimensions: desktop and mobile (mobile width <=480)", () => {
  assert.deepEqual(viewportDimensions("desktop"), { width: 1280, height: 720 });
  assert.deepEqual(viewportDimensions("mobile"), { width: 390, height: 844 });
  assert.ok(viewportDimensions("mobile").width <= 480);
});

test("logged browser viewport equals the MCP --viewport-size (single source, no duplicate map)", () => {
  for (const v of ["desktop", "mobile"] as const) {
    const args = resolveLaunchArgs({ viewport: v, outputDir: "/t", mode: "headless" });
    const sizeStr = args[args.indexOf("--viewport-size") + 1]; // what the browser launches with
    const [width, height] = sizeStr.split("x").map(Number);
    // The manifest's typed browser.viewport is derived from the SAME mapping.
    assert.deepEqual(browserConfigFor(v).viewport, { width, height });
  }
});

test("browserConfigFor: complete typed config matching D36 (chromium, isolated, a11y, vision off)", () => {
  assert.deepEqual(browserConfigFor("desktop"), {
    engine: "chromium",
    isolated: true,
    viewport: { width: 1280, height: 720 },
    accessibilitySnapshots: true,
    visionEnabled: false,
  });
});
