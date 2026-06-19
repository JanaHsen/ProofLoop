/**
 * Engine configuration from the environment. The executor's only knowledge of the SUT
 * is BASE_URL (the black-box boundary). The decider model and API key come from env;
 * the key is read here and passed straight to the decider — never logged, never
 * hardcoded. PROOFLOOP_BUGS / PROOFLOOP_DEBUG_TOKEN are deliberately NOT read.
 */

export interface EngineConfig {
  /** The only thing the tester is told about the SUT. */
  baseUrl: string;
  /** Decider model id; logged in the manifest. Defaults to the frozen Phase 2 choice. */
  model: string;
  /**
   * Phase 3 outcome-verifier model id — SEPARATELY configurable from the decider (D22) and
   * logged in every evaluation record. From `PROOFLOOP_VERIFIER_MODEL`; **no default** — a
   * live verify run must set it explicitly so an absent config never silently spends money on
   * a fallback model. `.env.example` documents `claude-opus-4-8` as the selected provisional
   * value. Resolve at the live call site via `requireVerifierModel()`; must be priced in
   * `platform/config/pricing.<id>.json` before a live verify run.
   */
  verifierModel?: string;
  /** From ANTHROPIC_API_KEY; undefined if absent (CLI errors before any live call). */
  anthropicApiKey?: string;
  pricingConfigId: string;
}

export function readEngineConfig(
  env: NodeJS.ProcessEnv = process.env,
): EngineConfig {
  return {
    baseUrl: env.BASE_URL ?? "http://localhost:3000",
    model: env.PROOFLOOP_MODEL ?? "claude-sonnet-4-6",
    // No default: a missing verifier model must fail loudly at the live call site
    // (requireVerifierModel), never silently fall back to a paid model.
    verifierModel: env.PROOFLOOP_VERIFIER_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    pricingConfigId: env.PROOFLOOP_PRICING_CONFIG ?? "anthropic-2026-06",
  };
}

/**
 * The verifier model for a LIVE verify run, or throw a clear configuration error. There is
 * deliberately NO default: a missing `PROOFLOOP_VERIFIER_MODEL` must fail loudly rather than
 * silently spend money on a fallback model. `.env.example` documents `claude-opus-4-8` as the
 * selected provisional value to copy into a local `.env`.
 */
export function requireVerifierModel(config: EngineConfig): string {
  const model = config.verifierModel?.trim();
  if (!model) {
    throw new Error(
      "PROOFLOOP_VERIFIER_MODEL is not set. Set it explicitly (e.g. claude-opus-4-8) before a " +
        "live verify run — there is no default, to avoid silently spending on a fallback model.",
    );
  }
  return model;
}
