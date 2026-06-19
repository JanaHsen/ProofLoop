// CI flow manifest loader/validator (Phase 6, D40).
//
// The set of flows CI runs lives in committed PLATFORM execution config —
// `platform/config/ci-flows.json` — not in `.github/`, so it can be validated and run
// locally. The manifest carries ONLY a `schemaVersion` and an ordered list of
// repo-root-relative flow paths — no expected verdicts, bug IDs, selectors, labels, model
// config, CI env, or ledger data (D12 stays intact).
//
// This loader is the single trusted gate between that committed config and the platform
// CLIs. It fails LOUD on any defect (never silently skips, reorders, infers from the
// filesystem, or falls back to a default), resolves every path against the REPO ROOT (never
// the caller's cwd), refuses anything outside `fixtures/flows/`, and parses every entry
// through the existing deterministic Phase 1 parser. It reuses that parser verbatim — it
// neither duplicates nor modifies the flow grammar.

import * as fs from "node:fs";
import * as path from "node:path";

import { parseFlowFile } from "../parser";
import type { FlowPlan } from "../flow-plan";

/** The only supported manifest schema version. */
export const CI_FLOWS_SCHEMA_VERSION = "1.0";

/** Raised on any CI-flow-manifest defect. Distinct, catchable, and never swallowed. */
export class CiFlowManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiFlowManifestError";
  }
}

/** One validated, resolved flow from the manifest. */
export interface CiFlow {
  /** Path EXACTLY as written in the manifest — repo-root-relative (matches CiFlowResult.flowPath, D43). */
  flowPath: string;
  /** Absolute path on this machine, resolved from the repo root (NEVER process.cwd()). */
  absolutePath: string;
  /** Flow id from the deterministic Phase 1 parse of the file (e.g. "login"). */
  flowId: string;
}

/** The loaded manifest: schema version + the flows in MANIFEST ORDER (never reordered). */
export interface CiFlowManifest {
  schemaVersion: typeof CI_FLOWS_SCHEMA_VERSION;
  flows: CiFlow[];
}

export interface LoadCiFlowManifestOptions {
  /** Absolute path to the manifest JSON. Defaults to `platform/config/ci-flows.json`. */
  manifestPath?: string;
  /** Absolute path to the repository root. Defaults to the repo root above `platform/`. */
  repoRoot?: string;
}

// Defaults derive from THIS module's location, not process.cwd(), so resolution is identical
// regardless of where the process was launched (e.g. CI runs the CLIs from `platform/`).
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "..", "..", "config", "ci-flows.json");
const DEFAULT_REPO_ROOT = path.join(__dirname, "..", "..", "..");

const ALLOWED_TOP_LEVEL_KEYS = new Set(["schemaVersion", "flows"]);
const FLOW_SUFFIX = ".flow.md";

/**
 * Load + fully validate the CI flow manifest. Returns the flows in manifest order, each with
 * its original repo-relative path and resolved absolute path. Throws `CiFlowManifestError` on
 * any structural defect and surfaces a parser failure with the offending flow's context.
 */
export function loadCiFlowManifest(opts: LoadCiFlowManifestOptions = {}): CiFlowManifest {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  // The single in-tree directory any flow may live in. Resolved the same way as the entries,
  // so the direct-child comparison below is a reliable string equality.
  const flowsDir = path.resolve(repoRoot, "fixtures", "flows");

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new CiFlowManifestError(
      `cannot read CI flow manifest at ${manifestPath}: ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw); // strict by construction: no comments, no trailing commas
  } catch (e) {
    throw new CiFlowManifestError(
      `CI flow manifest is not valid JSON (${manifestPath}): ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CiFlowManifestError(
      'CI flow manifest must be a JSON object with "schemaVersion" and "flows".',
    );
  }
  const obj = parsed as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new CiFlowManifestError(
      `CI flow manifest has unknown top-level field(s): ${unknownKeys.join(", ")} ` +
        `(allowed: schemaVersion, flows).`,
    );
  }

  if (obj.schemaVersion !== CI_FLOWS_SCHEMA_VERSION) {
    throw new CiFlowManifestError(
      `CI flow manifest schemaVersion must be "${CI_FLOWS_SCHEMA_VERSION}", ` +
        `got ${JSON.stringify(obj.schemaVersion)}.`,
    );
  }

  const flowsRaw = obj.flows;
  if (!Array.isArray(flowsRaw) || flowsRaw.length === 0) {
    throw new CiFlowManifestError('CI flow manifest "flows" must be a non-empty array.');
  }

  const seen = new Set<string>();
  const flows: CiFlow[] = [];
  for (const entry of flowsRaw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new CiFlowManifestError(
        `CI flow manifest "flows" must contain only non-empty strings (got ${JSON.stringify(entry)}).`,
      );
    }
    const flowPath = entry;

    // Reject absolute paths on EITHER platform's rules (e.g. "/etc/x", "C:\\x", "\\\\server").
    if (path.posix.isAbsolute(flowPath) || path.win32.isAbsolute(flowPath)) {
      throw new CiFlowManifestError(
        `CI flow path must be repo-root-relative, not absolute: ${flowPath}`,
      );
    }

    // Resolve against the REPO ROOT — never process.cwd(). This also normalizes "." / "..".
    const absolutePath = path.resolve(repoRoot, flowPath);

    // Must be a DIRECT child of fixtures/flows/ — this single check rejects traversal
    // ("fixtures/flows/../x"), sibling directories ("fixtures/other/x"), and nested
    // subdirectories ("fixtures/flows/sub/x"), all of which resolve to a different dirname.
    if (path.dirname(absolutePath) !== flowsDir) {
      throw new CiFlowManifestError(
        `CI flow path must live directly in fixtures/flows/: ${flowPath} ` +
          `(resolved to ${absolutePath}, outside ${flowsDir}).`,
      );
    }

    // Enforce the .flow.md filename convention (and a non-empty stem).
    const base = path.basename(absolutePath);
    if (!base.endsWith(FLOW_SUFFIX) || base.length === FLOW_SUFFIX.length) {
      throw new CiFlowManifestError(
        `CI flow path must name a *${FLOW_SUFFIX} file: ${flowPath}`,
      );
    }

    // Reject duplicates by NORMALIZED absolute path (catches "x" vs "./x" as well).
    if (seen.has(absolutePath)) {
      throw new CiFlowManifestError(`CI flow manifest lists a duplicate flow: ${flowPath}`);
    }
    seen.add(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      throw new CiFlowManifestError(
        `CI flow file does not exist: ${flowPath} (resolved to ${absolutePath}).`,
      );
    }

    // Parse through the existing deterministic Phase 1 parser (validation; grammar untouched).
    let plan: FlowPlan;
    try {
      plan = parseFlowFile(absolutePath);
    } catch (e) {
      throw new CiFlowManifestError(
        `CI flow ${flowPath} failed to parse as a FlowPlan: ${(e as Error).message}`,
      );
    }

    flows.push({ flowPath, absolutePath, flowId: plan.id });
  }

  return { schemaVersion: CI_FLOWS_SCHEMA_VERSION, flows };
}
