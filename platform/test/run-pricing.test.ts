import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCostUsd,
  loadPricing,
  ratesFor,
  usageTotals,
} from "../src/run/pricing";

const CFG = loadPricing("anthropic-2026-06");

test("loadPricing resolves the committed config by id", () => {
  assert.equal(CFG.pricingConfigId, "anthropic-2026-06");
  assert.ok(CFG.models["claude-opus-4-8"]);
});

test("ratesFor: cache rates derive from input (1.25x/2x write, 0.1x read)", () => {
  const r = ratesFor(CFG, "claude-opus-4-8");
  assert.deepEqual(r, {
    input: 5.0,
    output: 25.0,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10.0,
    cacheRead: 0.5,
  });
  assert.throws(() => ratesFor(CFG, "no-such-model"), /not in pricing config/);
});

test("computeCostUsd from raw usage, including cache tokens", () => {
  const rates = ratesFor(CFG, "claude-opus-4-8");
  const base = computeCostUsd(
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    rates,
  );
  assert.equal(base, (1000 * 5 + 500 * 25) / 1e6); // 0.0175
  const cached = computeCostUsd(
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 100 },
    rates,
  );
  assert.equal(cached, (1000 * 5 + 500 * 25 + 200 * 6.25 + 100 * 0.5) / 1e6); // 0.0188
});

test("computeCostUsd is recomputable from raw usage (Phase 7 invariant)", () => {
  const usage = { input_tokens: 12345, output_tokens: 6789, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const a = computeCostUsd(usage, ratesFor(CFG, "claude-sonnet-4-6"));
  const b = computeCostUsd(usage, ratesFor(loadPricing("anthropic-2026-06"), "claude-sonnet-4-6"));
  assert.equal(a, b);
});

test("usageTotals: prompt totals include all input-side tokens", () => {
  assert.deepEqual(
    usageTotals({ input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }),
    { promptTokens: 115, completionTokens: 40 },
  );
});
