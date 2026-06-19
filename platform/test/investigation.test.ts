/**
 * Focused tests for the Phase 5 Task 2 investigation-only launcher. These run in the
 * normal `npm test` suite (no browser, no SUT, no API): they assert the mode toggle is
 * exactly one `--headless`, that production stays untouched, and that the harness reuses
 * the production snapshot/redaction/digest path rather than re-implementing it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildServerArgs, PlaywrightMcpClient } from "../src/mcp/client";
import { digestSnapshot, parseSnapshot } from "../src/mcp/snapshot";
import { redactValuesInText } from "../src/run/redaction";
import { RUN_LOG_SCHEMA_VERSION } from "../src/run/schema";
import {
  HEADLESS_FLAG,
  InvestigationMcpClient,
  scrubAndDigest,
} from "./investigation/mode-delta";

const OPTS = { viewport: "desktop", outputDir: "/tmp/out" } as const;

function investigationArgs(mode: "headed" | "headless"): string[] {
  return new InvestigationMcpClient({ ...OPTS, mode }).launchArgsForInspection;
}

// --- mode toggle is exactly one --headless ----------------------------------------

test("headed investigation args omit --headless (production-equivalent)", () => {
  const args = investigationArgs("headed");
  assert.ok(!args.includes(HEADLESS_FLAG), "headed must not pass --headless");
  assert.deepEqual(
    args,
    buildServerArgs(OPTS),
    "headed args are byte-identical to the production argv",
  );
});

test("headless investigation args include exactly one --headless", () => {
  const args = investigationArgs("headless");
  assert.equal(
    args.filter((a) => a === HEADLESS_FLAG).length,
    1,
    "exactly one --headless",
  );
});

test("the headed/headless pair differs by ONLY the single trailing --headless", () => {
  const headed = investigationArgs("headed");
  const headless = investigationArgs("headless");
  // Removing every --headless from the headless argv must reproduce the headed argv.
  assert.deepEqual(headless.filter((a) => a !== HEADLESS_FLAG), headed);
  // And the only positional addition is the trailing flag.
  assert.deepEqual(headless.slice(0, headed.length), headed);
  assert.deepEqual(headless.slice(headed.length), [HEADLESS_FLAG]);
});

// --- production is untouched -------------------------------------------------------

test("production buildServerArgs is unchanged (frozen headed argv, no --headless)", () => {
  const args = buildServerArgs(OPTS);
  assert.ok(!args.includes(HEADLESS_FLAG));
  assert.ok(!args.includes("--headed"));
  // The frozen production flag set (order-independent membership).
  for (const expected of [
    "--isolated",
    "--browser",
    "chromium",
    "--viewport-size",
    "1280x720",
    "--snapshot-mode",
    "full",
    "--output-mode",
    "stdout",
    "--output-dir",
    "/tmp/out",
  ]) {
    assert.ok(args.includes(expected), `production args must include ${expected}`);
  }
});

test("the investigation launcher writes no run-log (version owned by run/schema)", () => {
  // The investigation harness has no logger and emits no manifest/events, so it can't
  // touch the run-log version. (The version itself is bumped to 1.2 by Phase 5 Task 3 and
  // asserted in run-log.test.ts; here we just confirm the current value the suite sees.)
  assert.equal(RUN_LOG_SCHEMA_VERSION, "1.2");
});

// --- reuse of the production path (no duplicate parser/redactor/digest) ------------

test("investigation client reuses production lifecycle/nav/snapshot (inherited, not overridden)", () => {
  // Same function reference => the subclass does NOT re-implement these; it inherits
  // the production implementations verbatim. Only buildLaunchArgs is overridden.
  const proto = (c: unknown) => c as Record<string, unknown>;
  for (const m of ["launch", "navigate", "snapshot", "close"] as const) {
    assert.equal(
      proto(InvestigationMcpClient.prototype)[m],
      proto(PlaywrightMcpClient.prototype)[m],
      `${m} must be the inherited production method`,
    );
  }
  assert.equal(
    Object.getPrototypeOf(InvestigationMcpClient.prototype),
    PlaywrightMcpClient.prototype,
    "InvestigationMcpClient extends the production client",
  );
});

test("scrubAndDigest applies the production redactor then the production digest", () => {
  const raw = '- textbox "Card" [ref=e3]: "4111-1111-1111-1111"\n- button "Pay" [ref=e4]';
  const secret = "4111-1111-1111-1111";

  const { scrubbedYaml, digest } = scrubAndDigest(raw, [secret]);

  // Production redaction was applied (secret gone, marker present).
  assert.ok(!scrubbedYaml.includes(secret), "secret must be redacted");
  assert.ok(scrubbedYaml.includes("[REDACTED]"), "redaction marker present");
  // Output is exactly the production composition: digest(redact(raw)).
  assert.equal(scrubbedYaml, redactValuesInText(raw, [secret]));
  assert.equal(digest, digestSnapshot(redactValuesInText(raw, [secret])));
  // Empty secret set is a no-op scrub but still a real digest (clean checkpoints).
  const clean = scrubAndDigest(raw, []);
  assert.equal(clean.scrubbedYaml, raw);
  assert.equal(clean.digest, digestSnapshot(raw));
  // And the digest is over the same canonical surface the production parser exposes.
  assert.equal(parseSnapshot(raw).digest, clean.digest);
});
