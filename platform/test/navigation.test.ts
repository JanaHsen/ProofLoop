import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  auditUrl,
  deriveSutOrigin,
  isAllowedFinalUrl,
  observedDisplayPath,
  resolveTrustedDestination,
  verifyStoredSnapshotDigest,
  type ObservedSnapshotRecord,
} from "../src/engine/navigation";
import { digestSnapshot } from "../src/mcp/snapshot";

const SECRET_URL = "http://localhost:3000/order/O-00001?token=secret-value#private";

const ORIGIN = "http://localhost:3000";
const RUN = "checkout-run";

function rec(over: Partial<ObservedSnapshotRecord> = {}): ObservedSnapshotRecord {
  return {
    snapshotId: "snapshot-016",
    runId: RUN,
    digest: "sha256:abc",
    pageUrl: "http://localhost:3000/order/O-00001",
    ...over,
  };
}

function resolve(over: {
  snapshotId?: unknown;
  record?: ObservedSnapshotRecord | undefined;
  digestValid?: boolean;
  sutOrigin?: string;
} = {}) {
  return resolveTrustedDestination({
    snapshotId: "snapshotId" in over ? over.snapshotId : "snapshot-016",
    currentRunId: RUN,
    sutOrigin: over.sutOrigin ?? ORIGIN,
    record: "record" in over ? over.record : rec(),
    digestValid: over.digestValid ?? true,
  });
}

// ── deriveSutOrigin ──────────────────────────────────────────────────────────────────
test("deriveSutOrigin strips path/query to the bare origin and throws on a malformed BASE_URL", () => {
  assert.equal(deriveSutOrigin("http://localhost:3000"), ORIGIN);
  assert.equal(deriveSutOrigin("http://localhost:3000/some/path?q=1"), ORIGIN);
  assert.equal(deriveSutOrigin("https://example.test:8443"), "https://example.test:8443");
  assert.throws(() => deriveSutOrigin("not a url"));
});

// ── resolveTrustedDestination — POSITIVE ─────────────────────────────────────────────
test("POSITIVE: a valid same-run, same-origin, http observed URL resolves", () => {
  const d = resolve();
  assert.ok(d.ok);
  if (d.ok) {
    assert.equal(d.url, "http://localhost:3000/order/O-00001");
    assert.equal(d.origin, ORIGIN);
    assert.equal(d.sourceSnapshotId, "snapshot-016");
  }
});

test("POSITIVE: a same-origin RELATIVE stored URL resolves onto the SUT origin (absolute form also ok)", () => {
  const d = resolve({ record: rec({ pageUrl: "/order/O-00001" }) });
  assert.ok(d.ok);
  if (d.ok) assert.equal(d.url, "http://localhost:3000/order/O-00001");
});

// ── resolveTrustedDestination — NEGATIVE (the safety contract) ────────────────────────
test("NEGATIVE: a non-string snapshotId is rejected (model supplied no usable id)", () => {
  for (const bad of [undefined, 42, null, ""]) {
    const d = resolve({ snapshotId: bad });
    assert.ok(!d.ok && d.code === "BAD_SNAPSHOT_ID", `code for ${JSON.stringify(bad)}`);
  }
});

test("NEGATIVE: a missing snapshot (fabricated id) is rejected", () => {
  const d = resolve({ record: undefined });
  assert.ok(!d.ok && d.code === "SNAPSHOT_NOT_FOUND");
});

test("NEGATIVE: a snapshot from another run is rejected", () => {
  const d = resolve({ record: rec({ runId: "some-other-run" }) });
  assert.ok(!d.ok && d.code === "SNAPSHOT_FOREIGN_RUN");
});

test("NEGATIVE: a snapshot whose stored digest no longer verifies is rejected", () => {
  const d = resolve({ digestValid: false });
  assert.ok(!d.ok && d.code === "SNAPSHOT_DIGEST_MISMATCH");
});

test("NEGATIVE: a snapshot without a page URL is rejected", () => {
  for (const pageUrl of [undefined, "", "   "]) {
    const d = resolve({ record: rec({ pageUrl }) });
    assert.ok(!d.ok && d.code === "NO_PAGE_URL", `pageUrl=${JSON.stringify(pageUrl)}`);
  }
});

test("NEGATIVE: a malformed stored URL is rejected", () => {
  const d = resolve({ record: rec({ pageUrl: "http://" }) });
  assert.ok(!d.ok && d.code === "MALFORMED_URL");
});

test("NEGATIVE: a non-http(s) protocol (javascript:/data:/file:) is rejected", () => {
  for (const pageUrl of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    const d = resolve({ record: rec({ pageUrl }) });
    assert.ok(!d.ok && d.code === "UNSUPPORTED_PROTOCOL", pageUrl);
  }
});

test("NEGATIVE: a URL embedding credentials is rejected", () => {
  const d = resolve({ record: rec({ pageUrl: "http://user:pass@localhost:3000/order/O-00001" }) });
  assert.ok(!d.ok && d.code === "URL_HAS_CREDENTIALS");
});

test("NEGATIVE: an external origin (host, scheme, or port mismatch) is rejected", () => {
  for (const pageUrl of [
    "http://evil.example/order/O-00001",
    "https://localhost:3000/order/O-00001", // scheme differs
    "http://localhost:4000/order/O-00001", // port differs
  ]) {
    const d = resolve({ record: rec({ pageUrl }) });
    assert.ok(!d.ok && d.code === "CROSS_ORIGIN", pageUrl);
  }
});

// ── isAllowedFinalUrl — the redirect-escape guard ─────────────────────────────────────
test("isAllowedFinalUrl accepts only a same-origin http(s) final URL", () => {
  assert.equal(isAllowedFinalUrl("http://localhost:3000/order/O-00001", ORIGIN), true);
  assert.equal(isAllowedFinalUrl("http://evil.example/x", ORIGIN), false); // redirect escape
  assert.equal(isAllowedFinalUrl("https://localhost:3000/x", ORIGIN), false); // scheme escape
  assert.equal(isAllowedFinalUrl("javascript:alert(1)", ORIGIN), false);
  assert.equal(isAllowedFinalUrl(undefined, ORIGIN), false);
  assert.equal(isAllowedFinalUrl("", ORIGIN), false);
});

// ── auditUrl / observedDisplayPath — URL sanitization ────────────────────────────────
test("auditUrl preserves origin+path, redacts query VALUES to key names, drops fragment & credentials", () => {
  const a = auditUrl(SECRET_URL);
  assert.equal(a.safe, "http://localhost:3000/order/O-00001?token");
  assert.ok(!a.safe.includes("secret-value"), "query value must never appear");
  assert.ok(!a.safe.includes("private"), "fragment must never appear");
  assert.ok(a.digest.startsWith("sha256:"));
  // credentials are stripped (origin excludes userinfo)
  assert.ok(!auditUrl("http://user:pass@localhost:3000/x?k=v").safe.includes("user"));
  assert.ok(!auditUrl("http://user:pass@localhost:3000/x?k=v").safe.includes("pass"));
  // a no-query URL has no '?' summary; the digest still differs per full URL
  assert.equal(auditUrl("http://localhost:3000/a").safe, "http://localhost:3000/a");
  assert.notEqual(auditUrl(SECRET_URL).digest, auditUrl("http://localhost:3000/order/O-00001").digest);
  // degrades safely on an unparseable URL
  assert.equal(auditUrl("http://").safe, "(unparseable url)");
});

test("observedDisplayPath exposes only a sanitized path (no origin, value, fragment, or credentials)", () => {
  assert.equal(observedDisplayPath(SECRET_URL), "/order/O-00001?token");
  assert.ok(!observedDisplayPath(SECRET_URL).includes("secret-value"));
  assert.ok(!observedDisplayPath(SECRET_URL).includes("private"));
  assert.ok(!observedDisplayPath(SECRET_URL).includes("localhost"));
  assert.equal(observedDisplayPath("http://localhost:3000/a"), "/a");
});

// ── verifyStoredSnapshotDigest — disk-backed integrity re-check ───────────────────────
test("verifyStoredSnapshotDigest passes on an intact blob and fails on tamper/missing", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofloop-nav-"));
  try {
    fs.mkdirSync(path.join(runDir, "snapshots"), { recursive: true });
    const yaml = '- generic [ref=e1]:\n  - heading "Order placed" [ref=e13]';
    const digest = digestSnapshot(yaml);
    const write = (id: string, blob: unknown) =>
      fs.writeFileSync(path.join(runDir, "snapshots", `${id}.json`), JSON.stringify(blob));

    write("snapshot-016", { snapshotId: "snapshot-016", digest, yaml, refs: ["e1", "e13"], elements: [] });
    assert.equal(verifyStoredSnapshotDigest(runDir, "snapshot-016", digest), true);

    // tampered yaml no longer recomputes to the recorded digest
    write("snapshot-017", { snapshotId: "snapshot-017", digest, yaml: yaml + "\n  - text: TAMPERED", refs: [], elements: [] });
    assert.equal(verifyStoredSnapshotDigest(runDir, "snapshot-017", digest), false);

    // a missing blob fails closed
    assert.equal(verifyStoredSnapshotDigest(runDir, "snapshot-999", digest), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
