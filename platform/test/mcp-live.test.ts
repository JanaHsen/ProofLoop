import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PlaywrightMcpClient } from "../src/mcp/client";
import { REQUIRED_TOOLS, isCoordinateTool } from "../src/mcp/tools";
import { validateRef, type ValidatedRef } from "../src/mcp/snapshot";

// LIVE browser bring-up for the MCP client. Launches a real Chromium, so it is OFF by
// default (keeps `npm test` fast + deterministic). Run it with:
//   PROOFLOOP_LIVE_MCP=1 npm test
// Runs headless (the Phase 5 default) so it needs no display; it is SUT-independent
// (drives a data: URL), so it verifies the client mechanics without the app up. The
// substantive authenticated continuity / cross-flow leak proof rides on the Task 6
// login run against the real SUT.
const SKIP = process.env.PROOFLOOP_LIVE_MCP
  ? false
  : "set PROOFLOOP_LIVE_MCP=1 to run the live headed MCP browser test";

const FORM = `<!doctype html><title>Probe</title>
<h1>Sign in</h1>
<form>
  <label>Username <input name="username"></label>
  <label>Password <input name="password" type="password"></label>
  <button type="submit">Sign in</button>
</form>`;
const DATA_URL = "data:text/html," + encodeURIComponent(FORM);

test("live MCP client: launch → discover → snapshot → act → teardown", { skip: SKIP }, async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-live-"));
  const client = new PlaywrightMcpClient({ viewport: "desktop", outputDir, mode: "headless" });
  try {
    await client.launch();

    // capability discovery: required present, no coordinate/vision tools.
    for (const t of REQUIRED_TOOLS) assert.ok(client.discoveredTools.includes(t));
    assert.equal(client.discoveredTools.filter(isCoordinateTool).length, 0);

    // navigate to entry-like page; a fresh snapshot must return refs.
    await client.navigate(DATA_URL);
    const snap = await client.snapshot();
    assert.ok(snap.refs.size >= 3, "snapshot returned element refs");

    // locate controls by intent, then validate each ref against the live snapshot —
    // the only way to obtain a ValidatedRef the action methods accept.
    const vref = (role: string, name: string): ValidatedRef => {
      const ref = snap.elements.find((e) => e.role === role && e.name === name)?.ref;
      assert.ok(ref, `located ${role} "${name}"`);
      const v = validateRef(snap, ref!);
      assert.ok(v.valid, "ref validates against the live snapshot");
      return (v as Extract<typeof v, { valid: true }>).ref;
    };

    const typed = await client.typeRef(vref("textbox", "Username"), "Username field", "alice");
    assert.equal(typed.isError, false);
    await client.typeRef(vref("textbox", "Password"), "Password field", "secret-123");
    await client.clickRef(vref("button", "Sign in"), "Sign in button");

    // a forged brand (model text cast past the type) is still caught at runtime.
    await assert.rejects(
      () =>
        client.typeRef(
          "#username" as unknown as ValidatedRef,
          "selector attempt",
          "x",
        ),
      /not a snapshot ref token/,
    );
  } finally {
    await client.close();
    await client.close(); // idempotent
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
