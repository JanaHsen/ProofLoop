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
  NAV_NO_EFFECT,
  NAV_REJECTED,
  NAV_WOULD_RESET,
  REPEATED_NO_EFFECT,
  StepDecision,
  parseDecision,
} from "./protocol";
import {
  auditUrl,
  deriveSutOrigin,
  isAllowedFinalUrl,
  observedDisplayPath,
  resolveTrustedDestination,
  sameDocumentUrlKey,
  verifyStoredSnapshotDigest,
} from "./navigation";
import {
  DEFAULT_GUARDS,
  GuardConfig,
  GuardTracker,
  GuardTrip,
  progressKey,
} from "./guards";
import type { AttemptSummary, Decider, ObservedPage } from "./decider";
import { RunLogger } from "../run/logger";
import { BrowserConfig, BrowserMode, computePlanHash, ExecutionStatus, FAILURE_DETAIL_MAX_LEN, LoggedDecision, LoggedValue, RunManifest, SnapshotKind, hashStepText } from "../run/schema";
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
  const clock = opts.now ?? ((): Date => new Date());
  const entryUrl = joinUrl(opts.baseUrl, opts.plan.entry);
  let decisionSeq = 0;

  // (D48) Index every snapshot this run records, so a later navigate_to_observed_url can be
  // resolved to that snapshot's STORED page URL — a destination only ever sourced from
  // evidence captured in THIS run, never from model free text. `recordSnap` is the single
  // path that stores a snapshot (it wraps the logger), so the index can never miss one.
  const observed = new Map<string, { digest: string; pageUrl?: string; pageTitle?: string }>();
  const recordSnap = (
    snap: ParsedSnapshot,
    kind: SnapshotKind,
    stepId?: string,
  ): { snapshotId: string; digest: string; path: string } => {
    // `snap` is already masked at capture; pass [] so the stored bytes and digest agree.
    const rec = logger.recordSnapshot(snap, kind, [], stepId);
    observed.set(rec.snapshotId, {
      digest: rec.digest,
      ...(snap.pageUrl !== undefined ? { pageUrl: snap.pageUrl } : {}),
      ...(snap.pageTitle !== undefined ? { pageTitle: snap.pageTitle } : {}),
    });
    return rec;
  };

  try {
    // (D48) The ONLY origin a trusted observed-URL navigation may ever reach. Derived once
    // from BASE_URL; a malformed BASE_URL throws here and is surfaced as EXECUTION_ERROR
    // rather than silently widening "same origin".
    const sutOrigin = deriveSutOrigin(opts.baseUrl);
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
    // (D48) Set when a navigation escaped the SUT origin: the browser is now on a foreign page,
    // so the best-effort terminal snapshot is suppressed — a foreign accessibility tree is never
    // persisted, not even as a terminal artifact.
    let foreignOriginEscape = false;
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
      // (D48) The last observed-URL navigation that produced NO page-state change: its
      // destination same-document key + the post-navigation progress key. A repeat of the same
      // effective navigation while the state is still unchanged is rejected before the browser
      // (the bounded-navigation guard). Cleared on any state-changing navigation.
      let lastNavNoEffect: { destKey: string; postKey: string } | null = null;

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

        // snap is already masked at capture; recordSnap stores it as-is and indexes it
        // (the index feeds observed-pages and trusted observed-URL navigation, D48).
        const { snapshotId, digest } = recordSnap(snap, "pre_action", step.id);

        const pageChangedSinceAction =
          attempts.length > 0 &&
          lastActionKey !== null &&
          progressKey(snap.yaml) !== lastActionKey;
        // resolve the previous attempt's observable effect now that we have the next
        // snapshot — gives the model role + effect history to recognize a stuck input.
        if (attempts.length > 0 && lastActionKey !== null) {
          attempts[attempts.length - 1].observableEffect = pageChangedSinceAction;
        }
        // (D48) Offer the distinct same-origin pages already observed this run as trusted
        // revisit targets, addressed by snapshot id and shown only as a sanitized path (never
        // the full internal URL the model could otherwise read or invent).
        const observedPages = buildObservedPages(observed, sutOrigin);
        let res;
        try {
          res = await opts.decider.decide({
            step,
            snapshot: snap,
            attemptsInStep: attempts.slice(-8),
            ...(pageChangedSinceAction ? { pageChangedSinceAction: true } : {}),
            ...(pendingCorrection ? { correction: pendingCorrection } : {}),
            ...(observedPages.length ? { observedPages } : {}),
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
          await captureSnapshot(opts.actuator, recordSnap, "step_boundary", [...sensitiveValues], step.id);
          logger.append({ type: "step_end", stepId: step.id });
          break decisionLoop;
        }

        if (decision.kind === "navigate_to_observed_url") {
          // (D48) Trusted observed-URL navigation. The model named a SOURCE snapshot id; the
          // destination is resolved deterministically from that snapshot's STORED page URL and
          // re-validated same-origin. No model-supplied URL ever reaches the browser.
          const startedAt = clock().toISOString();
          const idx = observed.get(decision.snapshotId);
          // Deterministic pre-navigation page-state key + same-document identity of the
          // destination and the current page (internal only; never logged).
          const preNavKey = progressKey(snap.yaml);
          const destDocKey = idx ? sameDocumentUrlKey(idx.pageUrl) : null;
          const curDocKey = sameDocumentUrlKey(snap.pageUrl);

          // Emit a "navigation rejected (no progress)" record + ONE informed correction, before
          // the browser is ever called, so a repeated/destructive navigation neither runs nor
          // consumes the action budget. `detail` carries no URL value.
          const rejectNavNoProgress = (code: string, detail: string): "stop" | "retry" => {
            logger.append({ type: "navigation", decisionId, sourceSnapshotId: decision.snapshotId, startedAt, resolvedUrl: "", status: "rejected", detail: scrub(detail), stepId: step.id });
            logger.append({ type: "error", code, detail: scrub(detail), decisionId, stepId: step.id });
            const failure: DecisionFailure = { kind: "nav_no_progress", detail, attemptedSnapshotId: decision.snapshotId };
            if (failureSig(failure) === lastCorrectionSig) return "stop";
            lastCorrectionSig = failureSig(failure);
            pendingCorrection = failure;
            logger.append({ type: "retry", ofDecisionId: decisionId, reason: scrub(`navigation produced no progress: ${detail}`), stepId: step.id });
            return "retry";
          };

          // (D48-C) Response preservation: refuse a same-document RELOAD that would discard a
          // page-state change an element action in THIS step just produced, before it is
          // accepted via step_complete. (Same document = same path+query, fragment ignored.)
          if (destDocKey !== null && curDocKey !== null && destDocKey === curDocKey && pageChangedSinceAction) {
            const r = rejectNavNoProgress(
              NAV_WOULD_RESET,
              "it would reload the page you are already on and discard the response your last action just produced — accept that response with step_complete instead",
            );
            if (r === "stop") { terminal = { status: "error" }; break stepsLoop; }
            continue decisionLoop;
          }

          // (D48-B) No-effect repeat: refuse a repeat of an observed-URL navigation that already
          // produced no page-state change while the state is still unchanged. The FIRST such
          // navigation was allowed and executed; this is the repeat.
          if (lastNavNoEffect !== null && destDocKey !== null && destDocKey === lastNavNoEffect.destKey && preNavKey === lastNavNoEffect.postKey) {
            const r = rejectNavNoProgress(
              NAV_NO_EFFECT,
              "an identical navigation a moment ago produced no observable page change and the page is still unchanged",
            );
            if (r === "stop") { terminal = { status: "error" }; break stepsLoop; }
            continue decisionLoop;
          }

          const record = idx
            ? {
                snapshotId: decision.snapshotId,
                runId: opts.runId,
                digest: idx.digest,
                ...(idx.pageUrl !== undefined ? { pageUrl: idx.pageUrl } : {}),
              }
            : undefined;
          // Re-verify the stored blob's digest from disk at navigation time (contract item 3).
          const digestValid = record
            ? verifyStoredSnapshotDigest(logger.runDir, decision.snapshotId, record.digest)
            : false;
          const dest = resolveTrustedDestination({
            snapshotId: decision.snapshotId,
            currentRunId: opts.runId,
            sutOrigin,
            record,
            digestValid,
          });

          if (!dest.ok) {
            // Rejected by the safety contract: audit it, then allow ONE informed correction.
            logger.append({
              type: "navigation",
              decisionId,
              sourceSnapshotId: decision.snapshotId,
              startedAt,
              resolvedUrl: "",
              status: "rejected",
              detail: scrub(dest.detail),
              stepId: step.id,
            });
            logger.append({ type: "error", code: NAV_REJECTED, detail: scrub(dest.detail), decisionId, stepId: step.id });
            const failure: DecisionFailure = {
              kind: "nav_rejected",
              detail: dest.detail,
              attemptedSnapshotId: decision.snapshotId,
            };
            if (failureSig(failure) === lastCorrectionSig) {
              terminal = { status: "error" };
              break stepsLoop;
            }
            lastCorrectionSig = failureSig(failure);
            pendingCorrection = failure;
            logger.append({ type: "retry", ofDecisionId: decisionId, reason: scrub(`navigation rejected: ${dest.detail}`), stepId: step.id });
            continue decisionLoop;
          }

          // Spend/iteration guards apply to a navigation exactly as to an element action.
          const navTrip = guard.beforeAction();
          if (navTrip) {
            terminal = mapTrip(navTrip);
            break stepsLoop;
          }

          // SANITIZED audit form of the trusted destination — origin+path+query-KEY names only,
          // never the full URL (which may carry a secret query value or fragment) in the log.
          const destAudit = auditUrl(dest.url);

          // Navigate through the SAME bounded browser/MCP abstraction the entry page uses.
          try {
            await opts.actuator.navigate(dest.url);
          } catch (e) {
            logger.append({
              type: "navigation",
              decisionId,
              sourceSnapshotId: dest.sourceSnapshotId,
              startedAt,
              resolvedUrl: destAudit.safe,
              resolvedUrlDigest: destAudit.digest,
              status: "failed",
              detail: scrub(errMsg(e)),
              stepId: step.id,
            });
            logger.append({ type: "error", code: "NAVIGATION_FAILED", detail: scrub(errMsg(e)), decisionId, stepId: step.id });
            terminal = { status: "error" };
            break stepsLoop;
          }
          guard.recordAction();

          // Fresh post-navigation snapshot — held IN MEMORY only; not yet persisted/indexed.
          let postSnap: ParsedSnapshot;
          try {
            postSnap = maskSnapshot(await opts.actuator.snapshot(), [...sensitiveValues]);
          } catch (e) {
            logger.append({
              type: "navigation",
              decisionId,
              sourceSnapshotId: dest.sourceSnapshotId,
              startedAt,
              resolvedUrl: destAudit.safe,
              resolvedUrlDigest: destAudit.digest,
              status: "failed",
              detail: scrub(`post-navigation snapshot failed: ${errMsg(e)}`),
              stepId: step.id,
            });
            logger.append({ type: "error", code: "SNAPSHOT_FAILED", detail: scrub(errMsg(e)), stepId: step.id });
            terminal = { status: "error" };
            break stepsLoop;
          }

          // Redirect-escape guard (contract item 9): validate the FINAL URL BEFORE persisting.
          // A cross-origin (or otherwise invalid) final URL is never stored or indexed as
          // trusted evidence — the foreign accessibility tree does not enter the run.
          if (!isAllowedFinalUrl(postSnap.pageUrl, sutOrigin)) {
            const finalAudit = postSnap.pageUrl !== undefined ? auditUrl(postSnap.pageUrl) : undefined;
            logger.append({
              type: "navigation",
              decisionId,
              sourceSnapshotId: dest.sourceSnapshotId,
              startedAt,
              resolvedUrl: destAudit.safe,
              resolvedUrlDigest: destAudit.digest,
              status: "failed",
              ...(finalAudit ? { finalUrl: finalAudit.safe, finalUrlDigest: finalAudit.digest } : {}),
              detail: "navigation left the allowed SUT origin",
              stepId: step.id,
            });
            logger.append({
              type: "error",
              code: "NAVIGATION_CROSS_ORIGIN",
              detail: scrub(`final URL ${finalAudit ? finalAudit.safe : "(unknown)"} is not on the allowed origin ${sutOrigin}`),
              decisionId,
              stepId: step.id,
            });
            foreignOriginEscape = true; // suppress the terminal capture of the foreign page
            terminal = { status: "error" };
            break stepsLoop;
          }

          // Final URL is same-origin: only NOW persist + index the post-navigation snapshot.
          const post = recordSnap(postSnap, "pre_action", step.id);
          const finalAudit = postSnap.pageUrl !== undefined ? auditUrl(postSnap.pageUrl) : undefined;
          logger.append({
            type: "navigation",
            decisionId,
            sourceSnapshotId: dest.sourceSnapshotId,
            startedAt,
            resolvedUrl: destAudit.safe,
            resolvedUrlDigest: destAudit.digest,
            status: "executed",
            resultingSnapshotId: post.snapshotId,
            ...(finalAudit ? { finalUrl: finalAudit.safe, finalUrlDigest: finalAudit.digest } : {}),
            stepId: step.id,
          });

          // (D48) Bounded-navigation state evaluation. Compare the post-navigation page-state
          // key to the pre-navigation key: an unchanged state (a reload or a redirect back to
          // the same page) is a NO-EFFECT navigation — the first is allowed and executed, but its
          // signature is remembered so an immediate identical repeat is rejected (guard B). A
          // state-CHANGING navigation clears that memory and proceeds normally.
          const postNavKey = progressKey(postSnap.yaml);
          if (postNavKey === preNavKey && destDocKey !== null) {
            lastNavNoEffect = { destKey: destDocKey, postKey: postNavKey };
          } else {
            lastNavNoEffect = null;
          }
          // The element-action no-progress streak and no-effect tracker are not armed across a
          // navigation (the bounded-navigation guard above governs repeated navigation instead);
          // click/type behaviour is unchanged. Corrections reset, like a real action.
          progressBaseline = null;
          lastActionKey = null;
          lastExecutedAction = null;
          lastCorrectionSig = null;
          pendingCorrection = undefined;
          continue decisionLoop;
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
    // terminal snapshot (best effort) for criteria with no `after` (Phase 3) — skipped after a
    // cross-origin escape so the foreign accessibility tree is never persisted (D48).
    if (!foreignOriginEscape) {
      await captureSnapshot(opts.actuator, recordSnap, "terminal", [...sensitiveValues]);
    }
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
    case "nav_rejected":
      return `nav_rejected:${f.attemptedSnapshotId}:${f.detail}`;
    case "nav_no_progress":
      return `nav_no_progress:${f.attemptedSnapshotId}:${f.detail}`;
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
  if (decision.kind === "navigate_to_observed_url") {
    return { kind: "navigate_to_observed_url", snapshotId: decision.snapshotId, rationale: scrub(decision.rationale) };
  }
  return { kind: "blocked", reason: scrub(decision.reason) };
}

/** Cap on how many distinct observed pages are offered to the decider per decision (D48). */
const OBSERVED_PAGES_MAX = 24;

/**
 * (D48) Distinct pages observed so far this run that pass the SAME-ORIGIN policy, presented to
 * the model as `{ snapshotId, displayPath, pageTitle? }` — a SANITIZED path (no origin,
 * credentials, query values, or fragment), never the full internal URL. URLs that are external,
 * non-http(s), credential-bearing, malformed, or missing are excluded entirely, so the model can
 * never be steered toward an off-policy destination. One entry per distinct stored URL — the
 * FIRST sighting (the original placement of a created resource) — capped to `OBSERVED_PAGES_MAX`.
 * The executor's internal `observed` index keeps the complete URL for deterministic navigation;
 * only this projection is model-facing.
 */
function buildObservedPages(
  observed: Map<string, { digest: string; pageUrl?: string; pageTitle?: string }>,
  sutOrigin: string,
): ObservedPage[] {
  const byUrl = new Map<string, ObservedPage>();
  for (const [snapshotId, rec] of observed) {
    if (typeof rec.pageUrl !== "string" || rec.pageUrl.length === 0) continue;
    if (!isAllowedFinalUrl(rec.pageUrl, sutOrigin)) continue; // same-origin http(s), no creds
    if (byUrl.has(rec.pageUrl)) continue; // first sighting of this URL wins
    byUrl.set(rec.pageUrl, {
      snapshotId,
      displayPath: observedDisplayPath(rec.pageUrl),
      ...(rec.pageTitle !== undefined ? { pageTitle: rec.pageTitle } : {}),
    });
  }
  return [...byUrl.values()].slice(-OBSERVED_PAGES_MAX);
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
  recordSnap: (snap: ParsedSnapshot, kind: SnapshotKind, stepId?: string) => unknown,
  kind: "step_boundary" | "terminal",
  sensitiveValues: string[],
  stepId?: string,
): Promise<void> {
  try {
    // mask at capture (same as the main loop), then store + index the masked snapshot
    const snap = maskSnapshot(await actuator.snapshot(), sensitiveValues);
    recordSnap(snap, kind, stepId);
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
