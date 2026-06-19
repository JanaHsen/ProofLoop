/**
 * The Phase 4 presentation manifest (D27). A human-authored, tracked file under
 * `presentation/` that owns the demo's DISPLAY metadata — and ONLY that: a title, and an
 * ordered list of `{label, runId, evaluationId}` selections. It maps display labels to an
 * explicit run + evaluation; nothing else.
 *
 * The manifest is presentation-only. It is NEVER provided to the executor or verifier, and
 * the platform must NOT infer bug/mutation state from run artifacts. To keep that boundary
 * enforced rather than merely promised, the loader is STRICT: it rejects any key it does not
 * recognise, so a manifest can never smuggle in an expected verdict, bug-ledger data, or a
 * verifier instruction. A mismatch here is a configuration error, surfaced loudly.
 */

import * as fs from "node:fs";

export const PRESENTATION_MANIFEST_SCHEMA_VERSION = "1.0";

export interface ManifestRun {
  /** Human-authored display label, e.g. "Broken tax". The only place a state name may live. */
  label: string;
  runId: string;
  /** Explicit evaluation selection — never inferred (D27/Task 0). */
  evaluationId: string;
}

export interface PresentationManifest {
  schemaVersion: "1.0";
  title: string;
  runs: ManifestRun[];
}

/** Thrown when the manifest is malformed or carries a field outside the presentation-only schema. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(`presentation manifest error: ${message}`);
    this.name = "ManifestError";
  }
}

const ALLOWED_TOP_LEVEL = new Set(["schemaVersion", "title", "runs"]);
const ALLOWED_RUN_KEYS = new Set(["label", "runId", "evaluationId"]);

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse + strictly validate a presentation manifest. Unknown keys (e.g. `expectedVerdict`,
 * `bugLedger`, `verifierInstructions`) are rejected — the manifest may carry nothing the
 * execution/evaluation pipeline could consume.
 */
export function parseManifest(raw: unknown): PresentationManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestError("manifest must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw new ManifestError(
        `unexpected top-level key "${key}" — the manifest is presentation-only ` +
          `(allowed: ${[...ALLOWED_TOP_LEVEL].join(", ")})`,
      );
    }
  }
  if (obj.schemaVersion !== PRESENTATION_MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(
      `unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)} ` +
        `(supported: ${PRESENTATION_MANIFEST_SCHEMA_VERSION})`,
    );
  }
  const title = requireString(obj.title, "title");
  if (!Array.isArray(obj.runs) || obj.runs.length === 0) {
    throw new ManifestError("runs must be a non-empty array");
  }
  const runs: ManifestRun[] = obj.runs.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ManifestError(`runs[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!ALLOWED_RUN_KEYS.has(key)) {
        throw new ManifestError(
          `runs[${i}] has unexpected key "${key}" — only ${[...ALLOWED_RUN_KEYS].join(", ")} are allowed`,
        );
      }
    }
    return {
      label: requireString(e.label, `runs[${i}].label`),
      runId: requireString(e.runId, `runs[${i}].runId`),
      evaluationId: requireString(e.evaluationId, `runs[${i}].evaluationId`),
    };
  });
  return { schemaVersion: PRESENTATION_MANIFEST_SCHEMA_VERSION, title, runs };
}

/** Load + validate a manifest from disk. Throws `ManifestError` on any problem. */
export function loadManifest(manifestPath: string): PresentationManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new ManifestError(`could not read/parse ${manifestPath}: ${(e as Error).message}`);
  }
  return parseManifest(raw);
}

/**
 * Deterministic slug for a display label, e.g. "Renamed control + broken tax" =>
 * "renamed-control-broken-tax". Used for the per-run report folder + relative link.
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
