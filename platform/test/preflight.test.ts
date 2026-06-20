/**
 * Phase 6 Task 4 — CI preflight (§7). Proves the preflight validates the RESOLVER OUTPUT, not a
 * duplicated literal: an unpriced PROOFLOOP_MODEL override (which only reaches pricing via the
 * production `readEngineConfig` hook) fails through the resolver-based preflight. No model call.
 *
 * Uses the REAL committed manifest + REAL pricing config (both already exist); only the env is
 * varied. Priced model ids in anthropic-2026-06: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PreflightError, runPreflight } from "../src/ci/preflight";
import { preflightCli } from "../src/preflight-cli";

const OK_ENV: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "test-key-not-used-no-call-made",
  PROOFLOOP_MODEL: "claude-sonnet-4-6",
  PROOFLOOP_VERIFIER_MODEL: "claude-opus-4-8",
};

test("happy path: resolves and validates both models; returns the resolved executor id", () => {
  const r = runPreflight({ env: { ...OK_ENV } });
  assert.equal(r.executorModel, "claude-sonnet-4-6");
  assert.equal(r.verifierModel, "claude-opus-4-8");
  assert.equal(r.pricingConfigId, "anthropic-2026-06");
  assert.equal(r.flowCount, 5, "the committed manifest parses to five flows");
});

test("default drift protection: with PROOFLOOP_MODEL unset the resolver default is validated", () => {
  // No PROOFLOOP_MODEL → readEngineConfig defaults to claude-sonnet-4-6, which must be priceable.
  const r = runPreflight({
    env: { ANTHROPIC_API_KEY: "x", PROOFLOOP_VERIFIER_MODEL: "claude-opus-4-8" },
  });
  assert.equal(r.executorModel, "claude-sonnet-4-6", "resolver default is what gets validated");
});

test("§7: an UNPRICED PROOFLOOP_MODEL override fails through the resolver-based preflight", () => {
  assert.throws(
    () =>
      runPreflight({
        env: { ...OK_ENV, PROOFLOOP_MODEL: "claude-bogus-9-not-priced" },
      }),
    (e: unknown) => {
      assert.ok(e instanceof PreflightError, `expected PreflightError, got ${String(e)}`);
      assert.match((e as Error).message, /executor model is not priceable/);
      // The bogus id reached pricing ONLY via the resolver — proves it isn't a literal check.
      assert.match((e as Error).message, /claude-bogus-9-not-priced/);
      return true;
    },
  );
});

test("an unpriced PROOFLOOP_VERIFIER_MODEL override fails through the resolver", () => {
  assert.throws(
    () =>
      runPreflight({
        env: { ...OK_ENV, PROOFLOOP_VERIFIER_MODEL: "claude-bogus-verifier" },
      }),
    (e: unknown) =>
      e instanceof PreflightError &&
      /verifier model is not priceable/.test((e as Error).message) &&
      /claude-bogus-verifier/.test((e as Error).message),
  );
});

test("missing PROOFLOOP_VERIFIER_MODEL (no default) fails preflight", () => {
  assert.throws(
    () => runPreflight({ env: { ANTHROPIC_API_KEY: "x", PROOFLOOP_MODEL: "claude-sonnet-4-6" } }),
    (e: unknown) =>
      e instanceof PreflightError && /verifier model failed preflight/.test((e as Error).message),
  );
});

test("missing ANTHROPIC_API_KEY fails preflight", () => {
  assert.throws(
    () => runPreflight({ env: { PROOFLOOP_MODEL: "claude-sonnet-4-6", PROOFLOOP_VERIFIER_MODEL: "claude-opus-4-8" } }),
    (e: unknown) => e instanceof PreflightError && /ANTHROPIC_API_KEY/.test((e as Error).message),
  );
});

// ── CLI surface ────────────────────────────────────────────────────────────────────────────

test("preflightCli: exits 0 and prints the resolved models (never the secret)", () => {
  const lines: string[] = [];
  const code = preflightCli(["node", "preflight-cli.ts"], {
    preflight: () => ({
      executorModel: "claude-sonnet-4-6",
      verifierModel: "claude-opus-4-8",
      pricingConfigId: "anthropic-2026-06",
      flowCount: 5,
    }),
    out: { write: (s) => lines.push(s) },
    err: { write: () => {} },
  });
  assert.equal(code, 0);
  const printed = lines.join("");
  assert.match(printed, /executor=claude-sonnet-4-6/);
  assert.match(printed, /verifier=claude-opus-4-8/);
  assert.ok(!/test-key/.test(printed), "the API key is never printed");
});

test("preflightCli: exits 1 on a PreflightError", () => {
  const errs: string[] = [];
  const code = preflightCli(["node", "preflight-cli.ts"], {
    preflight: () => {
      throw new PreflightError("executor model is not priceable: claude-bogus");
    },
    out: { write: () => {} },
    err: { write: (s) => errs.push(s) },
  });
  assert.equal(code, 1);
  assert.match(errs.join(""), /preflight failed/);
});

test("preflightCli: exits 2 on stray arguments", () => {
  const code = preflightCli(["node", "preflight-cli.ts", "--unexpected"], {
    out: { write: () => {} },
    err: { write: () => {} },
  });
  assert.equal(code, 2);
});
