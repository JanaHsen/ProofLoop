/**
 * (D48) The executor/decider USER PROMPT must never echo a raw page URL. After a trusted
 * navigate_to_observed_url reaches e.g. `…/order/O-00001?token=secret-value#private`, the next
 * decision receives a fresh snapshot whose `pageUrl` carries that secret query value and
 * fragment. The "Current page" line — and every other URL the prompt renders — must be reduced
 * to the same sanitized model-facing form as the observed-page list (pathname + query-KEY names;
 * no origin, query values, fragment, or credentials). No live model, browser, SUT, or network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseFlow } from "../src/parser";
import { parseSnapshot } from "../src/mcp/snapshot";
import { buildUserMessage, type DecisionContext, type ObservedPage } from "../src/engine/decider";

const SECRET_URL = "http://localhost:3000/order/O-00001?token=secret-value&mode=review#private";

const STEP = parseFlow(
  "---\nname: T\nentry: /x\n---\n\n## Steps\n1. revisit the order page.\n\n## Acceptance Criteria\n- ok.\n",
  "t",
).steps[0];

function ctxWithPageUrl(pageUrl: string, observedPages?: ObservedPage[]): DecisionContext {
  const snapshot = parseSnapshot(
    '- generic [ref=e1]:\n  - heading "Order O-00001" [ref=e2]',
    `### Page\n- Page URL: ${pageUrl}\n- Page Title: Order O-00001`,
  );
  return { step: STEP, snapshot, attemptsInStep: [], ...(observedPages ? { observedPages } : {}) };
}

test("decider prompt sanitizes the current-page URL: path + query KEYS only; no value, fragment, origin, or raw URL", () => {
  const msg = buildUserMessage(ctxWithPageUrl(SECRET_URL));
  assert.ok(msg.includes("/order/O-00001"), "pathname is shown");
  assert.ok(msg.includes("token"), "query key 'token' is shown");
  assert.ok(msg.includes("mode"), "query key 'mode' is shown");
  assert.ok(!msg.includes("secret-value"), "query VALUE must never appear");
  assert.ok(!msg.includes("private"), "fragment must never appear");
  assert.ok(!msg.includes("localhost"), "origin is omitted");
  assert.ok(!msg.includes("http://"), "no raw full URL / scheme appears");
  // exact rendered form
  assert.match(msg, /Current page: Order O-00001 \(\/order\/O-00001\?token,mode\)/);
});

test("decider prompt strips credentials from the current-page URL", () => {
  const msg = buildUserMessage(ctxWithPageUrl("http://alice:hunter2@localhost:3000/order/O-00001"));
  assert.ok(msg.includes("/order/O-00001"));
  assert.ok(!msg.includes("alice"), "username must not appear");
  assert.ok(!msg.includes("hunter2"), "password must not appear");
});

test("decider prompt renders observed pages by sanitized displayPath only (never a raw URL)", () => {
  const observed: ObservedPage[] = [{ snapshotId: "snapshot-016", displayPath: "/order/O-00001?token", pageTitle: "Order O-00001" }];
  const msg = buildUserMessage(ctxWithPageUrl("http://localhost:3000/cart", observed));
  assert.ok(msg.includes("snapshot-016: /order/O-00001?token"), "observed page is shown by displayPath");
  assert.ok(!msg.includes("secret-value"));
  assert.ok(!msg.includes("http://"));
});

test("decider prompt handles a missing page URL without leaking", () => {
  const snapshot = parseSnapshot('- generic [ref=e1]:\n  - heading "X" [ref=e2]', "### Page\n- Page Title: X");
  const msg = buildUserMessage({ step: STEP, snapshot, attemptsInStep: [] });
  assert.ok(msg.includes("Current page: X (unknown path)"));
});
