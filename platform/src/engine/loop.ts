/**
 * The deterministic harness-controlled execution loop (Task 5, D13). The LLM proposes
 * one decision; everything else here is deterministic: snapshot timing, schema
 * validation, ref validation, dispatch, guards, logging, cleanup. This is what makes
 * the Exit criterion provable from the logs.
 *
 * Per step: step_start → { fresh snapshot → one decision → schema-validate →
 * validate ref against THIS snapshot → execute one allowed action → record → repeat }
 * until step_complete / blocked / guard trip / execution error. step_complete means an
 * action happened and a response was observed — NOT that the app behaved correctly.
 * NO criterion evaluation, NO PASS/FAIL/INCONCLUSIVE, NO verdict logic lives here.
 */

import type { FlowPlan } from "../flow-plan";
import {
  ParsedSnapshot,
  ValidatedRef,
  parseSnapshot,
  validateRef,
} from "../mcp/snapshot";
import type { ToolResult } from "../mcp/client";
import {
  DecisionFailure,
  INVALID_SNAPSHOT_REF,
  REPEATED_NO_EFFECT,
  StepDecision,
  parseDecision,
} from "./protocol";
import {
  DEFAULT_GUARDS,
  GuardConfig,
  GuardTracker,
  GuardTrip,
  progressKey,
} from "./guards";
import type { AttemptSummary, Decider } from "./decider";
import { RunLogger } from "../run/logger";
import { BrowserConfig, BrowserMode, computePlanHash, ExecutionStatus, FAILURE_DETAIL_MAX_LEN, LoggedDecision, LoggedValue, RunManifest, hashStepText } from "../run/schema";
import { computeCostUsd, loadPricing, ratesFor, usageTotals } from "../run/pricing";
import { SensitivitySignal, extractSecretLiterals, isSensitive, redactValuesInText } from "../run/redaction";

/** The browser surface the loop drives. PlaywrightMcpClient satisfies it structurally. */
export interface BrowserActuator {
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  snapshot(): Promise<ParsedSnapshot>;
  clickRef(ref: ValidatedRef, element: string): Promise<ToolResult>;
  typeRef(
    ref: ValidatedRef,
    element: string,
    text: string,
    submit?: boolean,
  ): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface RunFlowOptions {
  plan: FlowPlan;
  baseUrl: string;
  runId: string;
  runsRoot: string;
  model: string;
  pricingConfigId: string;
  decider: Decider;
  actuator: BrowserActuator;
  guards?: GuardConfig;
  signal?: AbortSignal;
  now?: () => Date;
  /**
   * (run-log 1.2) REQUIRED mode metadata to RECORD in the manifest — forwarded to the
   * logger and never read by the loop (D32: no execution-loop logic may branch on mode).
   * The CLI resolves these (default headless) and threads them in; the logger validates.
   */
  mode: BrowserMode;
  requestedMode: BrowserMode;
  browser: BrowserConfig;
}

type FinalStatus = Exclude<ExecutionStatus, "running" | "crashed">;

interface Terminal {
  status: FinalStatus;
  guardTrip?: GuardTrip;
}

export async function runFlow(opts: RunFlowOptions): Promise<RunManifest> {
  const guardsCfg = opts.guards ?? DEFAULT_GUARDS;
  const rates = ratesFor(loadPricing(opts.pricingConfigId), opts.model);
  const planHash = computePlanHash(opts.plan);
  const logger = new RunLogger({
    runsRoot: opts.runsRoot,
    runId: opts.runId,
    flowId: opts.plan.id,
    planHash,
    model: opts.model,
    pricingConfigId: opts.pricingConfigId,
    // Mode metadata is RECORDED only — forwarded verbatim, never branched on (D32).
    mode: opts.mode,
    requestedMode: opts.requestedMode,
    browser: opts.browser,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const guard = new GuardTracker(
    guardsCfg,
    opts.now ? () => opts.now!().getTime() : undefined,
  );
  // Run-scoped secret set, seeded BEFORE the first snapshot from the flow's
  // secret-bearing phrases (values adjacent to password/passcode/secret/token). Every
  // artifact written under the run dir is masked against this set; only the in-flight
  // model prompt (the step text) carries the real value, so the model can type it.
  const sensitiveValues = new Set<string>(
    extractSecretLiterals([
      ...opts.plan.steps.map((s) => s.text),
      ...opts.plan.criteria.map((c) => c.text),
    ]),
  );
  const scrub = (s: string): string => redactValuesInText(s, [...sensitiveValues]);
  const entryUrl = joinUrl(opts.baseUrl, opts.plan.entry);
  let decisionSeq = 0;

  try {
    logger.append({
      type: "flow_start",
      flowId: opts.plan.id,
      planHash,
      model: opts.model,
      entryUrl,
    });
    await opts.actuator.launch();
    await opts.actuator.navigate(entryUrl);
    guard.beginFlow();

    let terminal: Terminal | null = null;
    const attempts: AttemptSummary[] = [];

    stepsLoop: for (const step of opts.plan.steps) {
      guard.beginStep();
      attempts.length = 0;
      logger.append({
        type: "step_start",
        stepId: step.id,
        ordinal: step.ordinal,
        stepTextHash: hashStepText(step.text),
      });

      let pendingCorrection: DecisionFailure | undefined;
      // The exact failure we last requested a correction for. One correction per
      // distinct failure (MAX_CORRECTIONS_PER_DECISION); if the SAME failure recurs,
      // stop. Different failures in a row each get their own shot (e.g. fix the
      // schema, then redirect off a no-effect repeat).
      let lastCorrectionSig: string | null = null;
      let progressBaseline: string | null = null;
      let lastActionKey: string | null = null;
      // The last EXECUTED action's signature + the progress key it acted on, for the
      // deterministic repeated-no-effect backstop.
      let lastExecutedAction: { sig: string; preKey: string } | null = null;

      decisionLoop: while (true) {
        if (opts.signal?.aborted) guard.cancel();
        const preTrip = guard.beforeDecision();
        if (preTrip) {
          terminal = mapTrip(preTrip);
          break stepsLoop;
        }

        let snap: ParsedSnapshot;
        try {
          // Mask ONCE at the capture point, before the snapshot forks into store /
          // digest / send-to-model — all three consume the identical masked snapshot,
          // so verifyAuditChain still passes (refs/roles/names untouched).
          snap = maskSnapshot(await opts.actuator.snapshot(), [...sensitiveValues]);
        } catch (e) {
          logger.append({ type: "error", code: "SNAPSHOT_FAILED", detail: scrub(errMsg(e)), stepId: step.id });
          terminal = { status: "error" };
          break stepsLoop;
        }

        if (progressBaseline !== null) {
          const trip = guard.recordProgress(progressBaseline, progressKey(snap.yaml));
          progressBaseline = null;
          if (trip) {
            terminal = mapTrip(trip);
            break stepsLoop;
          }
        }

        // snap is already masked at capture; recordSnapshot stores it as-is.
        const { snapshotId, digest } = logger.recordSnapshot(
          snap,
          "pre_action",
          [],
          step.id,
        );

        const pageChangedSinceAction =
          attempts.length > 0 &&
          lastActionKey !== null &&
          progressKey(snap.yaml) !== lastActionKey;
        // resolve the previous attempt's observable effect now that we have the next
        // snapshot — gives the model role + effect history to recognize a stuck input.
        if (attempts.length > 0 && lastActionKey !== null) {
          attempts[attempts.length - 1].observableEffect = pageChangedSinceAction;
        }
        let res;
        try {
          res = await opts.decider.decide({
            step,
            snapshot: snap,
            attemptsInStep: attempts.slice(-8),
            ...(pageChangedSinceAction ? { pageChangedSinceAction: true } : {}),
            ...(pendingCorrection ? { correction: pendingCorrection } : {}),
          });
        } catch (e) {
          logger.append({ type: "error", code: "DECIDER_FAILED", detail: scrub(errMsg(e)), stepId: step.id });
          terminal = { status: "error" };
          break stepsLoop;
        }

        const costUsd = computeCostUsd(res.usage, rates);
        guard.recordDecision(usageTotals(res.usage), costUsd);
        const decisionId = `decision-${pad(++decisionSeq)}`;
        const wasCorrection = pendingCorrection !== undefined;

        const parsed = parseDecision(res.rawDecision);
        if (!parsed.ok) {
          // schema-invalid: account tokens (no valid LoggedDecision to emit), error + retry
          logger.addTotals({
            promptTokens: num(res.usage.input_tokens),
            completionTokens: num(res.usage.output_tokens),
            costUsd,
            latencyMs: res.latencyMs,
          });
          logger.append({ type: "error", code: "SCHEMA_INVALID", detail: scrub(parsed.error), decisionId, stepId: step.id });
          const failure: DecisionFailure = { kind: "schema", detail: parsed.error };
          if (failureSig(failure) === lastCorrectionSig) {
            terminal = { status: "error" };
            break stepsLoop;
          }
          lastCorrectionSig = failureSig(failure);
          pendingCorrection = failure;
          logger.append({ type: "retry", ofDecisionId: decisionId, reason: scrub(`schema-invalid: ${parsed.error}`), stepId: step.id });
          continue decisionLoop;
        }

        const decision = parsed.decision;
        const elem = decision.kind === "action" ? snap.elements.find((e) => e.ref === decision.ref) : undefined;
        const signal: SensitivitySignal = { accessibleName: elem?.name };

        // Seed the sensitive set from a sensitive type value BEFORE logging, so the
        // decision's own rationale (and all later rationale/reason/snapshots) are
        // scrubbed of the secret — complementary to the literal seed and the
        // structural password-field redaction.
        if (
          decision.kind === "action" &&
          decision.action === "type" &&
          decision.value &&
          isSensitive(signal)
        ) {
          sensitiveValues.add(decision.value);
        }

        const loggedValue: LoggedValue | undefined =
          decision.kind === "action" && decision.action === "type"
            ? maskLoggedValue(decision.value ?? "", signal, sensitiveValues)
            : undefined;

        logger.append({
          type: "llm_decision",
          decisionId,
          snapshotId,
          snapshotDigest: digest,
          decision: toLoggedDecision(decision, [...sensitiveValues], loggedValue),
          usage: res.usage,
          costUsd,
          latencyMs: res.latencyMs,
          stepId: step.id,
          ...(wasCorrection ? { correction: true } : {}),
        });

        if (decision.kind === "blocked") {
          terminal = { status: "blocked" };
          break stepsLoop;
        }
        if (decision.kind === "step_complete") {
          await captureSnapshot(opts.actuator, logger, "step_boundary", [...sensitiveValues], step.id);
          logger.append({ type: "step_end", stepId: step.id });
          break decisionLoop;
        }

        // kind === "action"
        // Deterministic backstop: reject — BEFORE MCP — a repeat of the immediately
        // previous action ({action, ref, value}) when the page has not meaningfully
        // changed since (i.e. that action had no observable effect). Legitimate
        // repeats (e.g. clicking the same "Add" twice) are allowed because each
        // successful one changes the page/app state, so the keys differ.
        const actSig = actionSignature(decision.action, decision.ref, decision.value ?? "");
        if (
          lastExecutedAction !== null &&
          actSig === lastExecutedAction.sig &&
          progressKey(snap.yaml) === lastExecutedAction.preKey
        ) {
          const failure: DecisionFailure = {
            kind: "repeated_no_effect",
            detail: `${decision.action} on ${decision.ref} had no observable effect; do not repeat it`,
            attemptedRef: decision.ref,
          };
          logger.append({ type: "error", code: REPEATED_NO_EFFECT, detail: scrub(failure.detail), decisionId, stepId: step.id });
          if (failureSig(failure) === lastCorrectionSig) {
            terminal = { status: "error" };
            break stepsLoop;
          }
          lastCorrectionSig = failureSig(failure);
          pendingCorrection = failure;
          logger.append({ type: "retry", ofDecisionId: decisionId, reason: scrub(failure.detail), stepId: step.id });
          continue decisionLoop;
        }

        const v = validateRef(snap, decision.ref);
        if (!v.valid) {
          logger.append({
            type: "action",
            decisionId,
            snapshotId,
            snapshotDigest: digest,
            ref: decision.ref,
            action: decision.action,
            ...(loggedValue !== undefined ? { value: loggedValue } : {}),
            refValidation: { valid: false, validatedBy: "harness", reason: v.reason },
            resolvedFrom: snapshotId,
            status: "rejected",
            stepId: step.id,
          });
          logger.append({ type: "error", code: INVALID_SNAPSHOT_REF, detail: scrub(v.detail), decisionId, stepId: step.id });
          const failure: DecisionFailure = { kind: "invalid_ref", reason: v.reason, detail: v.detail, attemptedRef: decision.ref };
          if (failureSig(failure) === lastCorrectionSig) {
            terminal = { status: "error" };
            break stepsLoop;
          }
          lastCorrectionSig = failureSig(failure);
          pendingCorrection = failure;
          logger.append({ type: "retry", ofDecisionId: decisionId, reason: scrub(`invalid ref: ${v.detail}`), stepId: step.id });
          continue decisionLoop;
        }

        const actTrip = guard.beforeAction();
        if (actTrip) {
          terminal = mapTrip(actTrip);
          break stepsLoop;
        }

        const elementDesc = describeElement(elem?.role, elem?.name, decision.ref);
        let result: ToolResult;
        try {
          if (decision.action === "type") {
            result = await opts.actuator.typeRef(v.ref, elementDesc, decision.value ?? "");
          } else {
            result = await opts.actuator.clickRef(v.ref, elementDesc);
          }
        } catch (e) {
          logger.append({ type: "error", code: "ACTION_FAILED", detail: scrub(errMsg(e)), decisionId, stepId: step.id });
          terminal = { status: "error" };
          break stepsLoop;
        }

        guard.recordAction();
        // (run-log 1.1, D25) On an isError result, capture failed-action evidence:
        // scrub FIRST (run-scoped redaction), THEN truncate from the end. No control-flow
        // change — a failed action is still recorded and the loop still continues.
        const failure = result.isError
          ? truncateFailureDetail(scrub(result.text))
          : undefined;
        logger.append({
          type: "action",
          decisionId,
          snapshotId,
          snapshotDigest: digest,
          ref: decision.ref,
          action: decision.action,
          ...(loggedValue !== undefined ? { value: loggedValue } : {}),
          refValidation: { valid: true, validatedBy: "harness" },
          resolvedFrom: snapshotId,
          status: result.isError ? "failed" : "executed",
          ...(result.isError ? { isError: true } : {}),
          ...(failure ?? {}),
          stepId: step.id,
        });
        const attemptValue =
          decision.action === "type"
            ? typeof loggedValue === "string"
              ? loggedValue
              : "[REDACTED]"
            : undefined;
        attempts.push({
          action: decision.action,
          ref: decision.ref,
          ...(elem?.role ? { role: elem.role } : {}),
          ...(elem?.name ? { name: elem.name } : {}),
          ...(attemptValue !== undefined ? { value: attemptValue } : {}),
        });
        const actedKey = progressKey(snap.yaml);
        progressBaseline = actedKey;
        lastActionKey = actedKey;
        lastExecutedAction = { sig: actSig, preKey: actedKey };
        lastCorrectionSig = null;
        pendingCorrection = undefined;
      } // decisionLoop
    } // stepsLoop

    const status: FinalStatus = terminal ? terminal.status : "completed";
    if (terminal?.guardTrip) {
      logger.append({ type: "guard_tripped", reason: terminal.guardTrip.reason, detail: scrub(terminal.guardTrip.detail) });
    }
    // terminal snapshot (best effort) for criteria with no `after` (Phase 3)
    await captureSnapshot(opts.actuator, logger, "terminal", [...sensitiveValues]);
    logger.append({ type: "flow_end", executionStatus: status });
    return logger.finalize(status);
  } catch (e) {
    safeAppend(logger, { type: "error", code: "EXECUTION_ERROR", detail: scrub(errMsg(e)) });
    safeAppend(logger, { type: "flow_end", executionStatus: "error" });
    return logger.finalize("error");
  } finally {
    try {
      await opts.actuator.close();
    } catch {
      /* teardown is best-effort */
    }
  }
}

function mapTrip(trip: GuardTrip): Terminal {
  return {
    status: trip.reason === "CANCELLED" ? "cancelled" : "guard_tripped",
    guardTrip: trip,
  };
}

/** Stable signature of an element-targeted action, for repeat detection. */
function actionSignature(action: string, ref: string, value: string): string {
  return `${action}:${ref}:${value}`;
}

/** Stable signature of a decision failure — one correction per distinct failure. */
function failureSig(f: DecisionFailure): string {
  switch (f.kind) {
    case "schema":
      return `schema:${f.detail}`;
    case "invalid_ref":
      return `invalid_ref:${f.attemptedRef}:${f.reason}`;
    case "repeated_no_effect":
      return `repeat:${f.attemptedRef}:${f.detail}`;
  }
}

function toLoggedDecision(
  decision: StepDecision,
  sensitive: string[],
  loggedValue: LoggedValue | undefined,
): LoggedDecision {
  // Scrub the model's free text of any known sensitive typed values — the rationale
  // can echo the secret even when the dedicated `value` field is redacted.
  const scrub = (s: string): string => redactValuesInText(s, sensitive);
  if (decision.kind === "action") {
    return {
      kind: "action",
      action: decision.action,
      ref: decision.ref,
      ...(loggedValue !== undefined ? { value: loggedValue } : {}),
      rationale: scrub(decision.rationale),
    };
  }
  if (decision.kind === "step_complete") {
    return { kind: "step_complete", rationale: scrub(decision.rationale) };
  }
  return { kind: "blocked", reason: scrub(decision.reason) };
}

/**
 * Redact a typed value for logging when it is sensitive — either structurally (the
 * field is a password/sensitive field) or because it matches a run-scoped secret
 * literal. Complementary to the snapshot/text masking.
 */
function maskLoggedValue(
  value: string,
  signal: SensitivitySignal,
  sensitive: Set<string>,
): LoggedValue {
  return isSensitive(signal) || sensitive.has(value)
    ? { value: "[REDACTED]", valueLength: value.length, sensitive: true }
    : value;
}

/**
 * Mask all run-scoped secret literals out of a snapshot ONCE, re-deriving refs,
 * roles, names, and digest from the masked YAML. Refs/roles/names are untouched
 * (secrets live in element content/values), so the audit chain still verifies.
 */
function maskSnapshot(snap: ParsedSnapshot, values: string[]): ParsedSnapshot {
  if (values.length === 0) return snap;
  const yaml = redactValuesInText(snap.yaml, values);
  if (yaml === snap.yaml && !snap.pageUrl && !snap.pageTitle) return snap;
  const reparsed = parseSnapshot(yaml);
  const pageUrl = snap.pageUrl ? redactValuesInText(snap.pageUrl, values) : undefined;
  const pageTitle = snap.pageTitle ? redactValuesInText(snap.pageTitle, values) : undefined;
  return {
    ...reparsed,
    ...(pageUrl !== undefined ? { pageUrl } : {}),
    ...(pageTitle !== undefined ? { pageTitle } : {}),
  };
}

async function captureSnapshot(
  actuator: BrowserActuator,
  logger: RunLogger,
  kind: "step_boundary" | "terminal",
  sensitiveValues: string[],
  stepId?: string,
): Promise<void> {
  try {
    // mask at capture (same as the main loop), then store the masked snapshot
    const snap = maskSnapshot(await actuator.snapshot(), sensitiveValues);
    logger.recordSnapshot(snap, kind, [], stepId);
  } catch {
    /* boundary/terminal snapshot is best-effort */
  }
}

function describeElement(role: string | undefined, name: string | undefined, ref: string): string {
  if (!role) return `element ${ref}`;
  return name ? `${role} "${name}"` : role;
}

function joinUrl(base: string, entry: string): string {
  return base.replace(/\/+$/, "") + (entry.startsWith("/") ? entry : `/${entry}`);
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * (run-log 1.1, D25) Bound an ALREADY-SCRUBBED failure detail. Truncate from the END so
 * the leading Playwright actionability diagnostic survives. Scrub-before-truncate is the
 * caller's responsibility and is load-bearing: truncating first could sever a secret
 * across the cut and leave a fragment the literal-based redaction would no longer match.
 */
function truncateFailureDetail(scrubbed: string): {
  failureDetail: string;
  failureDetailTruncated?: true;
} {
  if (scrubbed.length <= FAILURE_DETAIL_MAX_LEN) return { failureDetail: scrubbed };
  return {
    failureDetail: scrubbed.slice(0, FAILURE_DETAIL_MAX_LEN),
    failureDetailTruncated: true,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeAppend(logger: RunLogger, input: Parameters<RunLogger["append"]>[0]): void {
  try {
    logger.append(input);
  } catch {
    /* already finalized or unwritable */
  }
}
