// CI preflight (Phase 6, Task 4). Fail-fast validation that runs BEFORE the SUT boots
// and BEFORE any model spend. It exists to turn a typo, an unsupported model override, or
// an unpriced model into a clean preflight failure instead of a mid-run crash after money
// has been spent.
//
// CRITICAL (D41/§7): the preflight does NOT validate a literal model string copied into the
// workflow. It invokes the SAME production model-resolution path the executor/verifier use
// (`readEngineConfig` / `requireVerifierModel`), takes the model IDs that path RETURNS, and
// validates those resolved IDs through the SAME production pricing resolver
// (`loadPricing` + `ratesFor`). Setting `PROOFLOOP_MODEL=claude-sonnet-4-6` in CI is an
// explicit, auditable pin — but the preflight proves the *resolved* model is priceable, so a
// future default drift or a bad override is caught here, not in production. There is NO second
// hardcoded list of accepted model IDs.

import { readEngineConfig, requireVerifierModel } from "../config";
import { loadPricing, ratesFor } from "../run/pricing";
import { loadCiFlowManifest, type LoadCiFlowManifestOptions } from "./flow-manifest";

/** Raised on any preflight failure. Distinct, catchable, never swallowed. */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface PreflightResult {
  /** The executor model id as RESOLVED by readEngineConfig (PROOFLOOP_MODEL ?? default). */
  executorModel: string;
  /** The verifier model id as RESOLVED by requireVerifierModel (PROOFLOOP_VERIFIER_MODEL). */
  verifierModel: string;
  /** The pricing config id the resolver selected. */
  pricingConfigId: string;
  /** Number of flows the committed CI manifest parsed to. */
  flowCount: number;
}

export interface RunPreflightOptions {
  /** Environment to resolve config from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Forwarded to the manifest loader (mainly for tests). */
  manifest?: LoadCiFlowManifestOptions;
}

/**
 * Run the full CI preflight, or throw `PreflightError` with a clear, secret-free message:
 *   1. the committed CI flow manifest parses (every flow exists + parses to a FlowPlan);
 *   2. `ANTHROPIC_API_KEY` is present (the only repository secret);
 *   3. the executor model is RESOLVED via the production hook and is priceable;
 *   4. the verifier model is RESOLVED via the production hook and is priceable.
 * Returns the resolved, validated configuration (no secret is included or printed).
 */
export function runPreflight(opts: RunPreflightOptions = {}): PreflightResult {
  const env = opts.env ?? process.env;

  // 1. Manifest must parse (reuses Task 2's loud loader — never falls back to a default set).
  let flowCount: number;
  try {
    const manifest = loadCiFlowManifest(opts.manifest ?? {});
    flowCount = manifest.flows.length;
  } catch (e) {
    throw new PreflightError(`CI flow manifest failed preflight: ${(e as Error).message}`);
  }

  // 2–4. Resolve through the SAME production configuration path the CLIs use.
  const cfg = readEngineConfig(env);

  if (!cfg.anthropicApiKey || cfg.anthropicApiKey.trim() === "") {
    throw new PreflightError(
      "ANTHROPIC_API_KEY is not set — the tester cannot make a model call. " +
        "It is the only repository secret; configure it before running CI.",
    );
  }

  // The resolver RETURNS the executor model id; we validate exactly that id.
  const executorModel = cfg.model;

  // The resolver throws loudly if PROOFLOOP_VERIFIER_MODEL is unset (no default).
  let verifierModel: string;
  try {
    verifierModel = requireVerifierModel(cfg);
  } catch (e) {
    throw new PreflightError(`verifier model failed preflight: ${(e as Error).message}`);
  }

  // Validate BOTH resolved ids through the production pricing resolver. A typo / unsupported
  // override / unpriced model fails HERE, before the SUT boots or any model is called.
  let pricing;
  try {
    pricing = loadPricing(cfg.pricingConfigId);
  } catch (e) {
    throw new PreflightError(`pricing config failed preflight: ${(e as Error).message}`);
  }
  try {
    ratesFor(pricing, executorModel);
  } catch (e) {
    throw new PreflightError(`executor model is not priceable: ${(e as Error).message}`);
  }
  try {
    ratesFor(pricing, verifierModel);
  } catch (e) {
    throw new PreflightError(`verifier model is not priceable: ${(e as Error).message}`);
  }

  return {
    executorModel,
    verifierModel,
    pricingConfigId: cfg.pricingConfigId,
    flowCount,
  };
}
