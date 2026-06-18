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
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    pricingConfigId: env.PROOFLOOP_PRICING_CONFIG ?? "anthropic-2026-06",
  };
}
