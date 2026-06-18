import test from "node:test";
import assert from "node:assert/strict";

import { parseSnapshot } from "../src/mcp/snapshot";
import { AnthropicDecider } from "../src/engine/decider";
import { parseDecision } from "../src/engine/protocol";

// LIVE decider smoke — one real Sonnet call to confirm MOCK FIDELITY: that the real
// tool-use response shape is exactly what parseDecision + the loop assume (so the
// mocked loop tests aren't false confidence). OFF by default (spends real money):
//   PROOFLOOP_LIVE_LLM=1 node --env-file=../.env --require ts-node/register/transpile-only \
//     --test "test/decider-live.test.ts"
const KEY = process.env.ANTHROPIC_API_KEY;
const SKIP =
  process.env.PROOFLOOP_LIVE_LLM && KEY
    ? false
    : "set PROOFLOOP_LIVE_LLM=1 and ANTHROPIC_API_KEY to run the live decider smoke";

test("live decider returns a parseable, ref-valid StepDecision", { skip: SKIP }, async () => {
  const snapshot = parseSnapshot(
    '- generic [ref=e1]:\n  - textbox "Username" [ref=e5]\n  - textbox "Password" [ref=e7]\n  - button "Sign in" [ref=e8]',
    "### Page\n- Page URL: http://localhost:3000/login\n- Page Title: Sign in",
  );
  const decider = new AnthropicDecider({
    apiKey: KEY!,
    model: process.env.PROOFLOOP_MODEL ?? "claude-sonnet-4-6",
  });

  const res = await decider.decide({
    step: { id: "login:S1", ordinal: 1, text: 'Enter the username "alice" and the password "password123".' },
    snapshot,
    attemptsInStep: [],
  });

  // usage shape the spine stores verbatim
  assert.equal(typeof res.usage.input_tokens, "number");
  assert.equal(typeof res.usage.output_tokens, "number");

  // the raw tool input parses to a valid StepDecision (mock fidelity)
  const parsed = parseDecision(res.rawDecision);
  assert.ok(parsed.ok, parsed.ok ? "" : `decision did not parse: ${parsed.error}`);
  // parsed is now narrowed to the success variant
  if (parsed.decision.kind === "action") {
    // if it chose an action, the ref is one the harness will accept
    assert.ok(snapshot.refs.has(parsed.decision.ref), `chose ref ${parsed.decision.ref} not in snapshot`);
  }
  console.log("live decision:", JSON.stringify(parsed.decision));
  console.log("live usage:", JSON.stringify(res.usage));
});
