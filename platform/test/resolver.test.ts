import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseFlow } from "../src/parser";
import { extractYamlBlock, parseSnapshot } from "../src/mcp/snapshot";
import { browserConfigFor } from "../src/mcp/client";
import { RunLogger } from "../src/run/logger";
import {
  EvidenceIntegrityError,
  ProvidedSnapshot,
  resolveEvidence,
} from "../src/verify/resolver";
import type { ActionEvent, ErrorEvent } from "../src/run/schema";

/** Valid, complete 1.2 mode metadata for the logger (headless, desktop). */
const MODE_META = {
  mode: "headless" as const,
  requestedMode: "headless" as const,
  browser: browserConfigFor("desktop"),
};

const FROZEN = path.join(__dirname, "fixtures", "runs", "add-to-cart-frozen");
const BLOCKED = path.join(__dirname, "fixtures", "runs", "blocked-non-completing");
const SNAP = parseSnapshot(
  extractYamlBlock(fs.readFileSync(path.join(__dirname, "fixtures", "snapshot-result.txt"), "utf8"))!,
);
const NOW = () => new Date("2026-06-19T00:00:00.000Z");

const ids = (snaps: ProvidedSnapshot[]) => snaps.map((s) => s.snapshotId);

/** Synthetic plan whose flowId/step count yield the stepIds the fixtures use. */
function planFor(flowId: string, stepCount: number, criteriaLines: string[]): ReturnType<typeof parseFlow> {
  const steps = Array.from({ length: stepCount }, (_, i) => `${i + 1}. step ${i + 1}.`).join("\n");
  const criteria = criteriaLines.map((c) => `- ${c}`).join("\n");
  return parseFlow(`---\nname: ${flowId}\nentry: /login\n---\n\n## Steps\n${steps}\n\n## Acceptance Criteria\n${criteria}\n`, flowId);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-resolver-"));
}

test("terminal criterion ⇒ terminal snapshot + all step boundaries", () => {
  const plan = planFor("add-to-cart", 5, ["the cart total is correct."]); // no (after ...) => terminal
  const [r] = resolveEvidence(plan, FROZEN);
  assert.equal(r.criterionId, "add-to-cart:C1");
  assert.equal(r.shortCircuit, undefined);
  assert.equal(r.evidence?.windowKind, "terminal");
  // the single terminal snapshot leads, then all five boundaries
  assert.equal(r.evidence!.snapshots[0].kind, "terminal");
  assert.equal(r.evidence!.snapshots[0].snapshotId, "snapshot-022");
  assert.deepEqual(
    ids(r.evidence!.snapshots),
    ["snapshot-022", "snapshot-005", "snapshot-008", "snapshot-013", "snapshot-018", "snapshot-021"],
  );
  assert.equal(r.evidence!.events.length, 0);
});

test("pinned (after step 5) ⇒ the S5 boundary, and never a later snapshot", () => {
  const plan = planFor("add-to-cart", 5, ["the items are right. (after step 5)"]);
  const [r] = resolveEvidence(plan, FROZEN);
  assert.equal(r.evidence?.windowKind, "pinned");
  // exactly the five boundaries S1..S5, in order — and crucially NOT the terminal
  assert.deepEqual(ids(r.evidence!.snapshots), ["snapshot-005", "snapshot-008", "snapshot-013", "snapshot-018", "snapshot-021"]);
  assert.ok(!ids(r.evidence!.snapshots).includes("snapshot-022"), "the future terminal snapshot must never be provided");
  assert.equal(r.evidence!.snapshots.at(-1)!.stepId, "add-to-cart:S5");
  assert.ok(r.evidence!.snapshots.every((s) => s.kind === "step_boundary"));
});

test("≤-checkpoint window: pinned (after step 3) excludes the S4/S5 boundaries and the terminal", () => {
  const plan = planFor("add-to-cart", 5, ["subtotal is right. (after step 3)"]);
  const [r] = resolveEvidence(plan, FROZEN);
  assert.equal(r.evidence?.windowKind, "pinned");
  assert.deepEqual(ids(r.evidence!.snapshots), ["snapshot-005", "snapshot-008", "snapshot-013"]);
  for (const later of ["snapshot-018", "snapshot-021", "snapshot-022"]) {
    assert.ok(!ids(r.evidence!.snapshots).includes(later), `${later} is in the future of step 3`);
  }
});

test("resolver re-verifies digests and surfaces a tampered blob (never silently used)", () => {
  // copy the frozen fixture to a temp dir, tamper a provided boundary blob's yaml
  const dir = tmpDir();
  try {
    fs.cpSync(FROZEN, path.join(dir, "run"), { recursive: true });
    const blobPath = path.join(dir, "run", "snapshots", "snapshot-021.json");
    const blob = JSON.parse(fs.readFileSync(blobPath, "utf8"));
    blob.yaml = blob.yaml + "\n- injected [ref=e999]"; // digest no longer matches the event
    fs.writeFileSync(blobPath, JSON.stringify(blob, null, 2));
    const plan = planFor("add-to-cart", 5, ["items right. (after step 5)"]);
    assert.throws(() => resolveEvidence(plan, path.join(dir, "run")), EvidenceIntegrityError);
    assert.throws(() => resolveEvidence(plan, path.join(dir, "run")), /snapshot-021 digest mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-completing step ⇒ terminal snapshot + the step's failed-action and error events", () => {
  const plan = planFor("frozen-demo", 3, ["the order was placed. (after step 2)"]);
  const [r] = resolveEvidence(plan, BLOCKED);
  assert.equal(r.criterionId, "frozen-demo:C1");
  assert.equal(r.shortCircuit, undefined);
  assert.equal(r.evidence?.windowKind, "non_completing");
  // exactly the (best-effort) terminal snapshot
  assert.equal(r.evidence!.snapshots.length, 1);
  assert.equal(r.evidence!.snapshots[0].kind, "terminal");
  // the disambiguating evidence: the failed action (with failureDetail) + the error event
  assert.equal(r.evidence!.events.length, 2);
  const action = r.evidence!.events[0] as ActionEvent;
  assert.equal(action.type, "action");
  assert.equal(action.status, "failed");
  assert.equal(action.isError, true);
  assert.match(action.failureDetail ?? "", /not enabled/);
  const err = r.evidence!.events[1] as ErrorEvent;
  assert.equal(err.type, "error");
  assert.equal(err.code, "REPEATED_NO_EFFECT");
});

test("never-reached step ⇒ short-circuit COULD_NOT_EXECUTE (no verifier evidence)", () => {
  const plan = planFor("frozen-demo", 3, ["confirmation persists. (after step 3)"]);
  const [r] = resolveEvidence(plan, BLOCKED);
  assert.equal(r.evidence, undefined);
  assert.deepEqual(r.shortCircuit, {
    kind: "ERROR",
    origin: "EXECUTION",
    code: "COULD_NOT_EXECUTE",
    explanation: "pinned step frozen-demo:S3 never ran (criterion frozen-demo:C1)",
  });
});

test("completed step with a missing boundary snapshot ⇒ MISSING_BOUNDARY_SNAPSHOT", () => {
  const dir = tmpDir();
  try {
    // a run where S1 reaches step_end but its step_boundary snapshot was never written
    const logger = new RunLogger({ runsRoot: dir, runId: "mb", flowId: "mb-demo", planHash: "sha256:p", model: "claude-sonnet-4-6", pricingConfigId: "anthropic-2026-06", ...MODE_META, now: NOW });
    logger.append({ type: "flow_start", flowId: "mb-demo", planHash: "sha256:p", model: "claude-sonnet-4-6", entryUrl: "http://x/" });
    logger.append({ type: "step_start", stepId: "mb-demo:S1", ordinal: 1, stepTextHash: "sha256:s1" });
    logger.append({ type: "step_end", stepId: "mb-demo:S1" }); // completed, but NO boundary snapshot
    logger.recordSnapshot(SNAP, "terminal", []);
    logger.append({ type: "flow_end", executionStatus: "completed" });
    logger.finalize("completed");

    const plan = planFor("mb-demo", 1, ["something. (after step 1)"]);
    const [r] = resolveEvidence(plan, logger.runDir);
    assert.equal(r.evidence, undefined);
    assert.equal(r.shortCircuit?.kind, "ERROR");
    assert.equal((r.shortCircuit as { code: string }).code, "MISSING_BOUNDARY_SNAPSHOT");
    assert.equal((r.shortCircuit as { origin: string }).origin, "EXECUTION");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal criterion with no terminal snapshot ⇒ MISSING_TERMINAL_SNAPSHOT", () => {
  const dir = tmpDir();
  try {
    // outer-catch shape: a step completes but the terminal snapshot was never captured
    const logger = new RunLogger({ runsRoot: dir, runId: "mt", flowId: "mt-demo", planHash: "sha256:p", model: "claude-sonnet-4-6", pricingConfigId: "anthropic-2026-06", ...MODE_META, now: NOW });
    logger.append({ type: "flow_start", flowId: "mt-demo", planHash: "sha256:p", model: "claude-sonnet-4-6", entryUrl: "http://x/" });
    logger.append({ type: "step_start", stepId: "mt-demo:S1", ordinal: 1, stepTextHash: "sha256:s1" });
    logger.recordSnapshot(SNAP, "step_boundary", [], "mt-demo:S1");
    logger.append({ type: "step_end", stepId: "mt-demo:S1" });
    logger.append({ type: "flow_end", executionStatus: "completed" });
    logger.finalize("completed");

    const plan = planFor("mt-demo", 1, ["a terminal check."]); // no (after ...) => terminal
    const [r] = resolveEvidence(plan, logger.runDir);
    assert.equal(r.evidence, undefined);
    assert.equal((r.shortCircuit as { code: string }).code, "MISSING_TERMINAL_SNAPSHOT");
    assert.equal((r.shortCircuit as { origin: string }).origin, "EXECUTION");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the resolver never reads criterion text (criteria with identical positions resolve identically)", () => {
  // two criteria, same position (terminal), wildly different text ⇒ identical windows
  const plan = planFor("add-to-cart", 5, ["the tax equals 10% of the subtotal.", "ZZZ totally unrelated wording."]);
  const results = resolveEvidence(plan, FROZEN);
  assert.equal(results.length, 2);
  assert.deepEqual(ids(results[0].evidence!.snapshots), ids(results[1].evidence!.snapshots));
  assert.equal(results[0].evidence!.windowKind, results[1].evidence!.windowKind);
});
