import test from "node:test";
import assert from "node:assert/strict";

import {
  isRedacted,
  isSensitive,
  redactValue,
  redactValuesInText,
} from "../src/run/redaction";

test("isSensitive: structural password signal is primary", () => {
  // structural-first: a password-type field is sensitive whatever its label
  assert.ok(isSensitive({ isPasswordField: true }));
  assert.ok(isSensitive({ isPasswordField: true, accessibleName: "unlabeled" }));
});

test("isSensitive: name regex augments for text-typed secrets", () => {
  for (const name of ["Password", "password123", "CVV", "Card number", "SSN", "OTP", "API token", "client secret"]) {
    assert.ok(isSensitive({ accessibleName: name }), `${name} should be sensitive`);
  }
  for (const name of ["Username", "Email", "Quantity", "Search"]) {
    assert.ok(!isSensitive({ accessibleName: name }), `${name} should not be sensitive`);
  }
});

test("redactValue: frozen record shape, fails safe on the gate-flow password", () => {
  const r = redactValue("password123", { accessibleName: "Password" });
  assert.deepEqual(r, { value: "[REDACTED]", valueLength: 11, sensitive: true });
  assert.ok(isRedacted(r));
  // non-sensitive value passes through unchanged
  assert.equal(redactValue("alice", { accessibleName: "Username" }), "alice");
  assert.ok(!isRedacted("alice"));
});

test("redactValuesInText scrubs known sensitive values from stored text", () => {
  const yaml = '- textbox "Username": alice\n- textbox "Password": s3cret!';
  const out = redactValuesInText(yaml, ["s3cret!"]);
  assert.ok(out.includes("alice"));
  assert.ok(!out.includes("s3cret!"));
  assert.ok(out.includes("[REDACTED]"));
  // empty list is a no-op
  assert.equal(redactValuesInText(yaml, []), yaml);
});
