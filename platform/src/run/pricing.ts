/**
 * Versioned pricing (Task 4 freeze, decision #4). Rates live in committed files
 * `platform/config/pricing.<pricingConfigId>.json` so Phase 7 can recompute cost
 * from the raw usage + the historical committed rates even after public prices move.
 * Sourced from the Anthropic claude-api reference at implementation time, not memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ModelRates {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-write tokens, 5-minute TTL. */
  cacheWrite5m: number;
  /** USD per million cache-write tokens, 1-hour TTL. */
  cacheWrite1h: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
}

export interface PricingConfig {
  pricingConfigId: string;
  currency: string;
  unit: string;
  source: string;
  models: Record<string, ModelRates>;
}

/**
 * The raw Anthropic Messages API `usage` object, captured VERBATIM (decision #4a):
 * cache fields are retained even when zero, and the index signature preserves any
 * future fields (e.g. a 5m/1h cache_creation breakdown) without a schema migration.
 */
export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

const CONFIG_DIR = path.join(__dirname, "..", "..", "config");

export function pricingFilePath(pricingConfigId: string): string {
  return path.join(CONFIG_DIR, `pricing.${pricingConfigId}.json`);
}

/** Load a committed pricing config by id. Throws if missing or malformed. */
export function loadPricing(pricingConfigId: string): PricingConfig {
  const file = pricingFilePath(pricingConfigId);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as PricingConfig;
  if (cfg.pricingConfigId !== pricingConfigId) {
    throw new Error(
      `pricing file ${file} declares id "${cfg.pricingConfigId}", expected "${pricingConfigId}"`,
    );
  }
  return cfg;
}

const PER_MTOK = 1_000_000;

/**
 * Compute USD cost from raw usage + a model's rates. cache_creation is priced at the
 * 5-minute write rate (the API default TTL); Phase 2 never caches, so cache fields
 * are zero in practice — the term exists so enabling caching later doesn't require a
 * schema or cost-logic change.
 */
export function computeCostUsd(usage: RawUsage, rates: ModelRates): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * rates.input +
      output * rates.output +
      cacheWrite * rates.cacheWrite5m +
      cacheRead * rates.cacheRead) /
    PER_MTOK
  );
}

/** Look up a model's rates, throwing a clear error if the model is not priced. */
export function ratesFor(cfg: PricingConfig, model: string): ModelRates {
  const rates = cfg.models[model];
  if (!rates) {
    throw new Error(
      `model "${model}" is not in pricing config "${cfg.pricingConfigId}" (known: ${Object.keys(cfg.models).join(", ")})`,
    );
  }
  return rates;
}

/**
 * Guard-facing token totals. The prompt-token ceiling bounds ALL input-side tokens
 * (fresh input + cache writes + cache reads); completion tokens are output tokens.
 */
export function usageTotals(usage: RawUsage): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    completionTokens: usage.output_tokens ?? 0,
  };
}
