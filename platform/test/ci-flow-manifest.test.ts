/**
 * Phase 6 Task 2 — the CI flow manifest loader/validator (D40). No live flow, no LLM.
 * Positive cases use the COMMITTED manifest; negative cases use throwaway temp manifests with
 * the REAL repo root, so flow paths resolve against the real fixtures/flows/ without touching
 * the five canonical flow files.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CI_FLOWS_SCHEMA_VERSION,
  CiFlowManifestError,
  loadCiFlowManifest,
} from "../src/ci/flow-manifest";
import { parseFlowFile } from "../src/parser";

// platform/test → repo root (the SAME root the loader derives from its own __dirname).
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FLOWS_DIR = path.join(REPO_ROOT, "fixtures", "flows");

/** The frozen, contractual order of the five canonical flows. */
const EXPECTED: string[] = [
  "fixtures/flows/login.flow.md",
  "fixtures/flows/add-to-cart.flow.md",
  "fixtures/flows/checkout.flow.md",
  "fixtures/flows/checkout-mobile.flow.md",
  "fixtures/flows/form.flow.md",
];

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Write a throwaway manifest (object → JSON, or a raw string) and return its path. */
function manifestPath(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-cimanifest-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "ci-flows.json");
  fs.writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
  return file;
}

/** Load a throwaway manifest against the real repo root. */
function load(content: unknown) {
  return loadCiFlowManifest({ manifestPath: manifestPath(content), repoRoot: REPO_ROOT });
}

/** Assert a throwaway manifest is rejected with a CiFlowManifestError. */
function rejects(content: unknown, match?: RegExp): void {
  const p = manifestPath(content);
  assert.throws(
    () => loadCiFlowManifest({ manifestPath: p, repoRoot: REPO_ROOT }),
    (e: unknown) => {
      assert.ok(e instanceof CiFlowManifestError, `expected CiFlowManifestError, got ${String(e)}`);
      if (match) assert.match((e as Error).message, match);
      return true;
    },
  );
}

const VALID_ONE = ["fixtures/flows/login.flow.md"];

// ---------------------------------------------------------------------------------
// positive — the committed manifest
// ---------------------------------------------------------------------------------

test("the committed manifest loads to exactly the five canonical flows in frozen order", () => {
  const m = loadCiFlowManifest(); // defaults: committed manifest + repo root from __dirname
  assert.equal(m.schemaVersion, CI_FLOWS_SCHEMA_VERSION);
  assert.equal(m.flows.length, 5);
  assert.deepEqual(
    m.flows.map((f) => f.flowPath),
    EXPECTED,
    "flowPath list is the manifest list, in order",
  );
});

test("each returned absolute path points to the corresponding canonical flow and parses", () => {
  const m = loadCiFlowManifest();
  for (let i = 0; i < EXPECTED.length; i += 1) {
    const f = m.flows[i];
    assert.equal(f.flowPath, EXPECTED[i]);
    assert.equal(f.absolutePath, path.resolve(REPO_ROOT, EXPECTED[i]), "resolved abs path");
    assert.equal(path.dirname(f.absolutePath), FLOWS_DIR, "lives directly in fixtures/flows/");
    assert.ok(fs.existsSync(f.absolutePath), "file exists on disk");
    const plan = parseFlowFile(f.absolutePath);
    assert.equal(plan.id, f.flowId, "flowId comes from the deterministic Phase 1 parse");
  }
});

test("manifest order is preserved, not sorted or canonicalized", () => {
  const reversed = [...EXPECTED].reverse();
  const m = load({ schemaVersion: "1.0", flows: reversed });
  assert.deepEqual(m.flows.map((f) => f.flowPath), reversed);
});

test("resolution does not depend on process.cwd()", () => {
  const original = process.cwd();
  try {
    process.chdir(os.tmpdir());
    const m = loadCiFlowManifest(); // derives everything from __dirname, never cwd
    assert.equal(m.flows[0].absolutePath, path.resolve(REPO_ROOT, EXPECTED[0]));
    assert.equal(path.dirname(m.flows[0].absolutePath), FLOWS_DIR);
  } finally {
    process.chdir(original);
  }
});

// ---------------------------------------------------------------------------------
// negative — structural defects
// ---------------------------------------------------------------------------------

test("missing manifest file fails", () => {
  assert.throws(
    () =>
      loadCiFlowManifest({
        manifestPath: path.join(os.tmpdir(), "proofloop-no-such-manifest.json"),
        repoRoot: REPO_ROOT,
      }),
    CiFlowManifestError,
  );
});

test("non-JSON content fails (strict parse)", () => {
  rejects("{ this is not json", /valid JSON/);
});

test("a non-object top-level (array) fails", () => {
  rejects(["fixtures/flows/login.flow.md"], /must be a JSON object/);
});

test("unsupported schemaVersion fails", () => {
  rejects({ schemaVersion: "2.0", flows: VALID_ONE }, /schemaVersion/);
});

test("missing schemaVersion fails", () => {
  rejects({ flows: VALID_ONE }, /schemaVersion/);
});

test("missing flows fails", () => {
  rejects({ schemaVersion: "1.0" }, /flows/);
});

test("malformed flows (non-array, empty, non-string, empty-string) fail", () => {
  rejects({ schemaVersion: "1.0", flows: "nope" }, /non-empty array/);
  rejects({ schemaVersion: "1.0", flows: [] }, /non-empty array/);
  rejects({ schemaVersion: "1.0", flows: [123] }, /non-empty strings/);
  rejects({ schemaVersion: "1.0", flows: [""] }, /non-empty strings/);
});

test("an unknown top-level key fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: VALID_ONE, expectedVerdicts: { login: "PASS" } },
    /unknown top-level field/,
  );
});

test("a nonexistent / missing flow file fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/flows/does-not-exist.flow.md"] },
    /does not exist/,
  );
});

test("a duplicate flow path fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/flows/login.flow.md", "fixtures/flows/login.flow.md"] },
    /duplicate/,
  );
});

test("an absolute flow path fails", () => {
  rejects({ schemaVersion: "1.0", flows: ["/etc/evil.flow.md"] }, /absolute/);
});

test("a '..' traversal path fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/flows/../../secret.flow.md"] },
    /directly in fixtures\/flows/,
  );
});

test("a normalized path escaping fixtures/flows/ fails", () => {
  // Resolves to fixtures/bug-ledger.yaml — must never reach the ground-truth ledger.
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/flows/../bug-ledger.yaml"] },
    /directly in fixtures\/flows/,
  );
});

test("a path inside another directory fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/other/login.flow.md"] },
    /directly in fixtures\/flows/,
  );
});

test("a path in a nested subdirectory of fixtures/flows/ fails", () => {
  rejects(
    { schemaVersion: "1.0", flows: ["fixtures/flows/nested/login.flow.md"] },
    /directly in fixtures\/flows/,
  );
});

test("a wrong file extension fails", () => {
  rejects({ schemaVersion: "1.0", flows: ["fixtures/flows/login.txt"] }, /\.flow\.md/);
});
