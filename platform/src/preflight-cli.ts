// CLI for the Phase 6 CI preflight (Task 4, §7).
//
// Usage: node --require ts-node/register/transpile-only src/preflight-cli.ts
//
// Reads the tester environment (ANTHROPIC_API_KEY, PROOFLOOP_MODEL, PROOFLOOP_VERIFIER_MODEL,
// PROOFLOOP_PRICING_CONFIG) and validates everything CI needs before the SUT boots or any model
// is called. Exits 0 on success (printing the RESOLVED model ids — never the secret), 1 on any
// preflight failure, 2 on invalid arguments. No model call is made.

import { PreflightError, runPreflight } from "./ci/preflight";

export interface PreflightCliDeps {
  preflight: typeof runPreflight;
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

function defaultDeps(): PreflightCliDeps {
  return { preflight: runPreflight, out: process.stdout, err: process.stderr };
}

export function preflightCli(argv: readonly string[], deps: Partial<PreflightCliDeps> = {}): number {
  const d: PreflightCliDeps = { ...defaultDeps(), ...deps };

  // No flags accepted — env is the input. Reject stray args loudly.
  const extra = Array.from(argv).slice(2);
  if (extra.length > 0) {
    d.err.write("usage: preflight-cli (no arguments; configuration is read from the environment)\n");
    return 2;
  }

  try {
    const r = d.preflight();
    d.out.write(
      `■ preflight ok — executor=${r.executorModel} verifier=${r.verifierModel} ` +
        `pricing=${r.pricingConfigId} flows=${r.flowCount}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PreflightError) {
      d.err.write(`preflight failed: ${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exit(preflightCli(process.argv));
}
