/**
 * Phase 5 Task 7 — the DETERMINISTIC parity artifact generator.
 *
 * Two explicitly separated layers (never conflated):
 *   1. STRUCTURAL PROOF — the committed Task 6 production-launcher checkpoint result
 *      (`/login`, `/form` byte-identical across modes, empty frozen allow-list, LLM-free).
 *   2. LIVE DEMONSTRATION — one fresh headed + one fresh headless execution of the SAME
 *      clean flow, each post-hoc verified once. Verdict agreement is a single-run
 *      demonstration, NOT a statistical proof (D18). The verbatim caveat states this.
 *
 * The generator READS stored verdicts/evidence only. It NEVER runs or reproduces execution
 * or verification logic, launches no browser, and imports no decider/verifier/summarizer/LLM
 * client. It fails loudly (writing no success artifact) unless every integrity rule holds,
 * and serializes with stable key ordering and no timestamp / random id / machine path / raw
 * subprocess arguments — so repeated generation is byte-identical.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readManifest, verifyAuditChain } from "../run/audit";
import {
  BrowserConfig,
  RunManifest,
  computePlanHash,
  isBrowserConfig,
} from "../run/schema";
import { parseFlowFile } from "../parser";
import {
  EVALUATION_RECORD_SCHEMA_VERSION,
  type EvaluationRecord,
  type Verdict,
} from "../verify/evaluation";
import { PARITY_DROPPED_FIELDS } from "./snapshot-parity";

export const PARITY_REPORT_SCHEMA_VERSION = "1.0";

/** The verbatim Phase 5 caveat. Never paraphrased or shortened. */
export const PARITY_CAVEAT =
  "This is a single-run cross-mode demonstration, not a statistical proof of deterministic " +
  "parity. Both the executor and the verifier contain intentional LLM non-determinism (D18). " +
  "Verdict agreement here shows the same flow ran headed and headless to the same recorded " +
  "verdict on this run; repeated cross-mode verdict stability is measured in Phase 8.";

export interface CheckpointProof {
  path: string;
  headedDigest: string;
  headlessDigest: string;
  yamlByteEqual: boolean;
  normalizedEqual: boolean;
  differences: readonly unknown[];
}

/**
 * The committed Task 6 deterministic checkpoint result (production `PlaywrightMcpClient`,
 * clean SUT, harness-navigated, LLM-free). Both digests per checkpoint are equal ⇒
 * byte-identical scrubbed canonical YAML across modes. Reproducible via the gated live test
 * `platform/test/checkpoint-parity-live.test.ts`.
 */
export const TASK6_CHECKPOINTS: readonly CheckpointProof[] = Object.freeze([
  Object.freeze({
    path: "/login",
    headedDigest: "sha256:dad365c470af0f71d5dc00b36fa9772b0e264a9e4220fe778c209e80d9f10626",
    headlessDigest: "sha256:dad365c470af0f71d5dc00b36fa9772b0e264a9e4220fe778c209e80d9f10626",
    yamlByteEqual: true,
    normalizedEqual: true,
    differences: Object.freeze([]),
  }),
  Object.freeze({
    path: "/form",
    headedDigest: "sha256:291973ef276b530d9f5f27b094d05a638d8d7ad7f5a0669cb526c63cd7b77725",
    headlessDigest: "sha256:291973ef276b530d9f5f27b094d05a638d8d7ad7f5a0669cb526c63cd7b77725",
    yamlByteEqual: true,
    normalizedEqual: true,
    differences: Object.freeze([]),
  }),
]) as readonly CheckpointProof[];

const MANDATORY_CHECKPOINTS = ["/login", "/form"];

export interface ParityReportInputs {
  headedRunId: string;
  headedEvaluationId: string;
  headlessRunId: string;
  headlessEvaluationId: string;
}

/** Injectable I/O — defaults to the production readers; tests pass frozen artifacts. */
export interface ParityReportSources {
  runsRoot: string;
  flowsDir: string;
  loadManifest?: (runDir: string) => RunManifest;
  loadEvaluation?: (runDir: string, evaluationId: string) => EvaluationRecord;
  auditChain?: (runDir: string) => { ok: boolean };
  reparsePlanHash?: (flowsDir: string, flowId: string) => string;
  checkpointProof?: readonly CheckpointProof[];
  droppedFields?: readonly string[];
}

export interface ParityDemoRun {
  runId: string;
  evaluationId: string;
  requestedMode: "headed" | "headless";
  effectiveMode: "headed" | "headless";
  browser: BrowserConfig;
  executionStatus: string;
  auditVerified: boolean;
  flowVerdict: Verdict;
}

export interface ParityReport {
  parityReportSchemaVersion: string;
  claim: { structuralProof: string; liveResult: string };
  flow: { flowId: string; planHash: string };
  structuralProof: {
    sourceTask: string;
    launcher: string;
    method: string;
    droppedFields: string[];
    checkpoints: CheckpointProof[];
  };
  demonstration: {
    headed: ParityDemoRun;
    headless: ParityDemoRun;
    sameFlowId: boolean;
    samePlanHash: boolean;
    sameVerdict: boolean;
  };
  caveat: string;
}

/** Thrown when any artifact-integrity rule fails. No success artifact is written. */
export class ParityIntegrityError extends Error {
  constructor(message: string) {
    super(`parity artifact integrity: ${message}`);
    this.name = "ParityIntegrityError";
  }
}

function defaultLoadEvaluation(runDir: string, evaluationId: string): EvaluationRecord {
  const evalPath = path.join(runDir, "evaluations", evaluationId, "evaluation.json");
  if (!fs.existsSync(evalPath)) {
    throw new ParityIntegrityError(`evaluation ${evaluationId} not found at ${evalPath}`);
  }
  return JSON.parse(fs.readFileSync(evalPath, "utf8")) as EvaluationRecord;
}

function defaultReparsePlanHash(flowsDir: string, flowId: string): string {
  return computePlanHash(parseFlowFile(path.join(flowsDir, `${flowId}.flow.md`)));
}

/** A BrowserConfig rebuilt in a fixed key order — guarantees stable serialization. */
function stableBrowser(b: BrowserConfig): BrowserConfig {
  return {
    engine: b.engine,
    isolated: b.isolated,
    viewport: { width: b.viewport.width, height: b.viewport.height },
    accessibilitySnapshots: b.accessibilitySnapshots,
    visionEnabled: b.visionEnabled,
  };
}

interface LoadedRun {
  manifest: RunManifest;
  evaluation: EvaluationRecord;
  auditOk: boolean;
  reparsedPlanHash: string;
}

function loadAndValidateRun(
  label: "headed" | "headless",
  runId: string,
  evaluationId: string,
  s: Required<Pick<ParityReportSources, "runsRoot" | "flowsDir">> & ParityReportSources,
): LoadedRun {
  const loadManifest = s.loadManifest ?? readManifest;
  const loadEvaluation = s.loadEvaluation ?? defaultLoadEvaluation;
  const auditChain = s.auditChain ?? verifyAuditChain;
  const reparse = s.reparsePlanHash ?? defaultReparsePlanHash;

  const runDir = path.join(s.runsRoot, runId);
  if (!fs.existsSync(runDir)) {
    throw new ParityIntegrityError(`${label} run directory does not exist: ${runId}`);
  }
  const manifest = loadManifest(runDir);
  const evaluation = loadEvaluation(runDir, evaluationId);

  if (manifest.runLogSchemaVersion !== "1.2") {
    throw new ParityIntegrityError(`${label} run ${runId} is runLogSchemaVersion ${manifest.runLogSchemaVersion}, not 1.2`);
  }
  if (!isBrowserConfig(manifest.browser)) {
    throw new ParityIntegrityError(`${label} run ${runId} has an incomplete typed browser config`);
  }
  if (manifest.requestedMode !== manifest.mode) {
    throw new ParityIntegrityError(`${label} run ${runId}: requestedMode ${manifest.requestedMode} !== effective mode ${manifest.mode}`);
  }
  if (manifest.mode !== label) {
    throw new ParityIntegrityError(`${label} run ${runId} records mode ${manifest.mode}, expected ${label}`);
  }
  if (manifest.executionStatus !== "completed") {
    throw new ParityIntegrityError(`${label} run ${runId} executionStatus is ${manifest.executionStatus}, not completed`);
  }

  const reparsedPlanHash = reparse(s.flowsDir, manifest.flowId);
  if (reparsedPlanHash !== manifest.planHash) {
    throw new ParityIntegrityError(`${label} run ${runId}: current flow reparses to ${reparsedPlanHash}, not the executed ${manifest.planHash}`);
  }

  if (evaluation.evaluationRecordSchemaVersion !== EVALUATION_RECORD_SCHEMA_VERSION) {
    throw new ParityIntegrityError(`${label} evaluation ${evaluationId} schema ${evaluation.evaluationRecordSchemaVersion} != ${EVALUATION_RECORD_SCHEMA_VERSION}`);
  }
  if (evaluation.runId !== manifest.runId) {
    throw new ParityIntegrityError(`${label} evaluation ${evaluationId}.runId ${evaluation.runId} != run ${manifest.runId}`);
  }
  if (evaluation.flowId !== manifest.flowId) {
    throw new ParityIntegrityError(`${label} evaluation ${evaluationId}.flowId ${evaluation.flowId} != run ${manifest.flowId}`);
  }
  if (evaluation.planHash !== manifest.planHash) {
    throw new ParityIntegrityError(`${label} evaluation ${evaluationId}.planHash != run planHash`);
  }

  const audit = auditChain(runDir);
  if (!audit.ok) {
    throw new ParityIntegrityError(`${label} run ${runId} audit chain did not verify`);
  }

  return { manifest, evaluation, auditOk: true, reparsedPlanHash };
}

function validateCheckpointProof(checkpoints: readonly CheckpointProof[], droppedFields: readonly string[]): void {
  if (droppedFields.length !== 0) {
    throw new ParityIntegrityError(`dropped-field allow-list must be empty, has ${droppedFields.length}`);
  }
  if (checkpoints.length === 0) {
    throw new ParityIntegrityError("Task 6 checkpoint proof is missing (no checkpoints)");
  }
  for (const cp of checkpoints) {
    if (!cp.yamlByteEqual || !cp.normalizedEqual || cp.differences.length > 0 || cp.headedDigest !== cp.headlessDigest) {
      throw new ParityIntegrityError(`Task 6 checkpoint ${cp.path} is not green`);
    }
  }
  const paths = new Set(checkpoints.map((c) => c.path));
  for (const required of MANDATORY_CHECKPOINTS) {
    if (!paths.has(required)) {
      throw new ParityIntegrityError(`Task 6 checkpoint proof is missing the mandatory checkpoint ${required}`);
    }
  }
}

/** Build the validated parity report. Throws `ParityIntegrityError` on any violation. */
export function buildParityReport(inputs: ParityReportInputs, sources: ParityReportSources): ParityReport {
  const s = { ...sources, runsRoot: sources.runsRoot, flowsDir: sources.flowsDir };
  const checkpoints = (sources.checkpointProof ?? TASK6_CHECKPOINTS).map((c) => ({
    path: c.path,
    headedDigest: c.headedDigest,
    headlessDigest: c.headlessDigest,
    yamlByteEqual: c.yamlByteEqual,
    normalizedEqual: c.normalizedEqual,
    differences: [...c.differences],
  }));
  const droppedFields = [...(sources.droppedFields ?? PARITY_DROPPED_FIELDS)];

  validateCheckpointProof(checkpoints, droppedFields);

  const headed = loadAndValidateRun("headed", inputs.headedRunId, inputs.headedEvaluationId, s);
  const headless = loadAndValidateRun("headless", inputs.headlessRunId, inputs.headlessEvaluationId, s);

  const sameFlowId = headed.manifest.flowId === headless.manifest.flowId;
  const samePlanHash = headed.manifest.planHash === headless.manifest.planHash;
  if (!sameFlowId) {
    throw new ParityIntegrityError(`flowId mismatch: ${headed.manifest.flowId} vs ${headless.manifest.flowId}`);
  }
  if (!samePlanHash) {
    throw new ParityIntegrityError(`planHash mismatch across the two runs`);
  }
  const sameVerdict = headed.evaluation.flowVerdict === headless.evaluation.flowVerdict;
  if (!sameVerdict) {
    throw new ParityIntegrityError(`verdict mismatch: headed=${headed.evaluation.flowVerdict} headless=${headless.evaluation.flowVerdict}`);
  }

  const demoRun = (label: "headed" | "headless", r: LoadedRun): ParityDemoRun => ({
    runId: r.manifest.runId,
    evaluationId: r.evaluation.evaluationId,
    requestedMode: label,
    effectiveMode: label,
    browser: stableBrowser(r.manifest.browser as BrowserConfig),
    executionStatus: r.manifest.executionStatus,
    auditVerified: r.auditOk,
    flowVerdict: r.evaluation.flowVerdict,
  });

  return {
    parityReportSchemaVersion: PARITY_REPORT_SCHEMA_VERSION,
    claim: {
      structuralProof: "deterministic checkpoint parity",
      liveResult: "single-run cross-mode demonstration",
    },
    flow: {
      flowId: headed.manifest.flowId,
      planHash: headed.manifest.planHash,
    },
    structuralProof: {
      sourceTask: "Phase 5 Task 6",
      launcher: "production PlaywrightMcpClient",
      method: "harness-navigated, LLM-free controlled checkpoints",
      droppedFields,
      checkpoints,
    },
    demonstration: {
      headed: demoRun("headed", headed),
      headless: demoRun("headless", headless),
      sameFlowId,
      samePlanHash,
      sameVerdict,
    },
    caveat: PARITY_CAVEAT,
  };
}

/** Canonical serialization (stable insertion order; trailing newline). */
export function serializeParityReport(report: ParityReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Build + write the artifact atomically (temp then rename). Writes nothing on any failure. */
export function writeParityReport(
  outPath: string,
  inputs: ParityReportInputs,
  sources: ParityReportSources,
): ParityReport {
  const report = buildParityReport(inputs, sources);
  const json = serializeParityReport(report);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, outPath);
  return report;
}
