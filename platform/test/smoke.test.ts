import test from "node:test";
import assert from "node:assert/strict";

// Trivial test proving the node:test + ts-node harness runs green.
// Real parser tests land in Task 6.
test("platform test harness runs", () => {
  assert.equal(1 + 1, 2);
});
