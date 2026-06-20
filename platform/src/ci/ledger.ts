// The CI runtime ledger (Phase 6, D43). One entry per configured flow, mutated by the
// workflow as each flow advances run → verify → report → complete (or stops at an error).
// `report:ci` consumes the FINAL ledger.
//
// These are the pure, deterministic transition helpers (tested locally — the workflow's bash
// is just a thin caller). Every produced entry is a TERMINAL shape that satisfies report:ci's
// own validation, so a ledger built here cannot desync from what the aggregator accepts:
//
//   complete  → runId + evaluationId + reportPath, NO errorClass
//   run       → errorClass only            (failed before run-cli produced a runId)
//   verify    → errorClass + runId         (run ok, verify failed)
//   report    → errorClass + runId + evaluationId  (run+verify ok, report failed)
//
// `errorMessage`, when present, is a HARNESS-AUTHORED safe string (never raw stderr / secrets);
// report:ci never forwards it to summary.json / summary.md regardless.

export type CiStage = "run" | "verify" | "report" | "complete";

export interface LedgerEntry {
  flowPath: string;
  stage: CiStage;
  runId?: string;
  evaluationId?: string;
  reportPath?: string;
  errorClass?: string;
  errorMessage?: string;
}

/** Raised on any ledger construction/transition defect. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/**
 * Build the initial ledger from the ordered flow paths (one `stage:"run"` entry each, no ids,
 * no error). Order is preserved verbatim. Rejects an empty list or duplicate paths.
 */
export function initialLedger(flowPaths: readonly string[]): LedgerEntry[] {
  if (flowPaths.length === 0) {
    throw new LedgerError("cannot initialize a ledger from an empty flow list.");
  }
  const seen = new Set<string>();
  for (const fp of flowPaths) {
    if (typeof fp !== "string" || fp.trim() === "") {
      throw new LedgerError(`flow path must be a non-empty string (got ${JSON.stringify(fp)}).`);
    }
    if (seen.has(fp)) throw new LedgerError(`duplicate flow path: ${fp}`);
    seen.add(fp);
  }
  return flowPaths.map((flowPath) => ({ flowPath, stage: "run" as const }));
}

export interface RecordInput {
  flowPath: string;
  stage: CiStage;
  runId?: string;
  evaluationId?: string;
  reportPath?: string;
  errorClass?: string;
  errorMessage?: string;
}

/** Build a validated TERMINAL entry for `stage`, or throw if the field combination is wrong. */
function buildTerminalEntry(input: RecordInput): LedgerEntry {
  const { flowPath, stage } = input;
  const runId = input.runId?.trim() || undefined;
  const evaluationId = input.evaluationId?.trim() || undefined;
  const reportPath = input.reportPath?.trim() || undefined;
  const errorClass = input.errorClass?.trim() || undefined;
  const errorMessage = input.errorMessage?.trim() || undefined;

  const entry: LedgerEntry = { flowPath, stage };

  if (stage === "complete") {
    if (!runId || !evaluationId || !reportPath) {
      throw new LedgerError(
        `${flowPath}: stage "complete" requires runId, evaluationId, and reportPath.`,
      );
    }
    if (errorClass) {
      throw new LedgerError(`${flowPath}: stage "complete" must not carry an errorClass.`);
    }
    entry.runId = runId;
    entry.evaluationId = evaluationId;
    entry.reportPath = reportPath;
    return entry;
  }

  // Non-complete (failed) terminal states require an errorClass.
  if (!errorClass) {
    throw new LedgerError(`${flowPath}: failed stage "${stage}" requires an errorClass.`);
  }
  if (stage === "run") {
    if (runId || evaluationId || reportPath) {
      throw new LedgerError(
        `${flowPath}: failed stage "run" must not carry runId / evaluationId / reportPath.`,
      );
    }
  } else if (stage === "verify") {
    if (!runId) throw new LedgerError(`${flowPath}: failed stage "verify" requires runId.`);
    if (evaluationId || reportPath) {
      throw new LedgerError(
        `${flowPath}: failed stage "verify" must not carry evaluationId / reportPath.`,
      );
    }
    entry.runId = runId;
  } else if (stage === "report") {
    if (!runId || !evaluationId) {
      throw new LedgerError(`${flowPath}: failed stage "report" requires runId and evaluationId.`);
    }
    if (reportPath) {
      throw new LedgerError(`${flowPath}: failed stage "report" must not carry reportPath.`);
    }
    entry.runId = runId;
    entry.evaluationId = evaluationId;
  }
  entry.errorClass = errorClass;
  if (errorMessage) entry.errorMessage = errorMessage;
  return entry;
}

/**
 * Replace the entry for `input.flowPath` with its validated terminal state. The flow must exist
 * in the ledger exactly once. Returns a NEW ledger (input not mutated); order is preserved.
 */
export function recordEntry(ledger: readonly LedgerEntry[], input: RecordInput): LedgerEntry[] {
  const idx = ledger.findIndex((e) => e.flowPath === input.flowPath);
  if (idx === -1) {
    throw new LedgerError(`flow ${input.flowPath} is not in the ledger.`);
  }
  const terminal = buildTerminalEntry(input);
  const next = ledger.map((e) => ({ ...e }));
  next[idx] = terminal;
  return next;
}

/**
 * Set EVERY entry to the same failed terminal state — used when the SUT never became healthy
 * (every flow is `ERROR(APP_NOT_READY)`). Clears any ids. Returns a new ledger; order preserved.
 */
export function markAllError(
  ledger: readonly LedgerEntry[],
  opts: { stage: CiStage; errorClass: string; errorMessage?: string },
): LedgerEntry[] {
  if (opts.stage === "complete") {
    throw new LedgerError('markAllError cannot set stage "complete" (that is a success state).');
  }
  return ledger.map((e) =>
    buildTerminalEntry({
      flowPath: e.flowPath,
      stage: opts.stage,
      // For verify/report the run/eval ids would be required; APP_NOT_READY uses stage "run".
      errorClass: opts.errorClass,
      errorMessage: opts.errorMessage,
    }),
  );
}

/** Serialize the ledger deterministically (stable 2-space JSON + trailing newline). */
export function serializeLedger(ledger: readonly LedgerEntry[]): string {
  return JSON.stringify(ledger, null, 2) + "\n";
}
