/**
 * The deterministic criterion→evidence resolver (Phase 3 Task 3, D20/D21).
 *
 * Given a parsed `FlowPlan` and a finished run's directory, it returns — per criterion —
 * the bounded evidence window the verifier is allowed to see, OR a short-circuit
 * `InconclusiveDetail` when no gradeable evidence exists. It is PURE STRUCTURE: the
 * window is a function of the criterion's *position* (`after` step id, or terminal) and
 * the run's snapshot/event stream. It NEVER reads `criterion.text` — interpreting
 * criterion meaning here would re-import the verifier's non-determinism into the
 * deterministic layer (the D8 mistake, one phase later).
 *
 * It also re-verifies every snapshot it hands out (the `verifyAuditChain` idiom:
 * recompute the blob digest, compare to the snapshot event's `snapshotDigest`) so a
 * tampered/corrupt blob is SURFACED (thrown), never silently fed to the verifier.
 *
 * Post-hoc only (D20): it reads frozen artifacts; it drives no browser and re-executes
 * nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FlowPlan } from "../flow-plan";
import { digestSnapshot } from "../mcp/snapshot";
import { readEvents } from "../run/audit";
import type {
  ActionEvent,
  ErrorEvent,
  SnapshotEvent,
  SnapshotKind,
  StepEndEvent,
  StepStartEvent,
  StoredSnapshot,
} from "../run/schema";
import { errorDetail, type InconclusiveDetail } from "./evaluation";

/** Which D21 window a criterion resolved to. */
export type EvidenceWindowKind = "pinned" | "terminal" | "non_completing";

/** A snapshot handed to the verifier, with its stored-blob integrity already re-verified. */
export interface ProvidedSnapshot {
  snapshotId: string;
  kind: SnapshotKind;
  stepId?: string;
  /** The snapshot event's digest, which the stored blob has been confirmed to recompute to. */
  digest: string;
  yaml: string;
  refs: string[];
  elements: { ref: string; role: string; name?: string }[];
  pageUrl?: string;
  pageTitle?: string;
}

export interface EvidenceWindow {
  windowKind: EvidenceWindowKind;
  snapshots: ProvidedSnapshot[];
  /** Non-empty ONLY for the non-completing window: the step's failed actions + error events. */
  events: (ActionEvent | ErrorEvent)[];
}

export interface ResolvedCriterion {
  criterionId: string;
  /** Exactly one of `evidence` / `shortCircuit` is set. */
  evidence?: EvidenceWindow;
  shortCircuit?: InconclusiveDetail;
}

/** Thrown when a stored snapshot blob the resolver would provide fails its digest check. */
export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

/**
 * Resolve the evidence window for every criterion in `plan` against the run at `runDir`.
 * Structural only — `criterion.after` is the sole criterion field read.
 */
export function resolveEvidence(plan: FlowPlan, runDir: string): ResolvedCriterion[] {
  const { events } = readEvents(path.join(runDir, "events.jsonl"));

  const snapshotEvents = events.filter((e): e is SnapshotEvent => e.type === "snapshot");
  const started = new Set(
    events.filter((e): e is StepStartEvent => e.type === "step_start").map((e) => e.stepId),
  );
  const completed = new Set(
    events.filter((e): e is StepEndEvent => e.type === "step_end").map((e) => e.stepId),
  );
  const boundaryByStepId = new Map<string, SnapshotEvent>();
  for (const s of snapshotEvents) {
    if (s.kind === "step_boundary" && s.stepId !== undefined) boundaryByStepId.set(s.stepId, s);
  }
  const terminalEvent = snapshotEvents.find((s) => s.kind === "terminal");
  const ordinalByStepId = new Map(plan.steps.map((s) => [s.id, s.ordinal] as const));

  // Load + integrity-check each blob once; surface a digest mismatch rather than use it.
  const cache = new Map<string, ProvidedSnapshot>();
  const provide = (ev: SnapshotEvent): ProvidedSnapshot => {
    const cached = cache.get(ev.snapshotId);
    if (cached) return cached;
    let blob: StoredSnapshot;
    try {
      blob = JSON.parse(fs.readFileSync(path.join(runDir, ev.path), "utf8")) as StoredSnapshot;
    } catch {
      throw new EvidenceIntegrityError(`snapshot blob ${ev.path} (${ev.snapshotId}) is unreadable`);
    }
    const recomputed = digestSnapshot(blob.yaml);
    if (recomputed !== ev.snapshotDigest) {
      throw new EvidenceIntegrityError(
        `snapshot ${ev.snapshotId} digest mismatch (recomputed ${recomputed} != event ${ev.snapshotDigest})`,
      );
    }
    const provided: ProvidedSnapshot = {
      snapshotId: ev.snapshotId,
      kind: ev.kind,
      ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}),
      digest: ev.snapshotDigest,
      yaml: blob.yaml,
      refs: [...blob.refs],
      elements: blob.elements.map((e) => ({ ref: e.ref, role: e.role, ...(e.name !== undefined ? { name: e.name } : {}) })),
      ...(blob.pageUrl !== undefined ? { pageUrl: blob.pageUrl } : {}),
      ...(blob.pageTitle !== undefined ? { pageTitle: blob.pageTitle } : {}),
    };
    cache.set(ev.snapshotId, provided);
    return provided;
  };

  // step_boundary snapshots whose step ordinal is ≤ maxOrdinal, in step order — the
  // ≤-checkpoint window. Future boundaries (and the terminal) are never included.
  const boundariesUpTo = (maxOrdinal: number): ProvidedSnapshot[] =>
    snapshotEvents
      .filter(
        (s) =>
          s.kind === "step_boundary" &&
          s.stepId !== undefined &&
          (ordinalByStepId.get(s.stepId) ?? Infinity) <= maxOrdinal,
      )
      .sort((a, b) => (ordinalByStepId.get(a.stepId!)! - ordinalByStepId.get(b.stepId!)!))
      .map(provide);

  const results: ResolvedCriterion[] = [];
  for (const c of plan.criteria) {
    // ----- terminal criterion: terminal snapshot + all step boundaries -----
    if (c.after === undefined) {
      if (!terminalEvent) {
        results.push({
          criterionId: c.id,
          shortCircuit: errorDetail("MISSING_TERMINAL_SNAPSHOT", `no terminal snapshot captured for terminal criterion ${c.id}`),
        });
        continue;
      }
      results.push({
        criterionId: c.id,
        evidence: { windowKind: "terminal", snapshots: [provide(terminalEvent), ...boundariesUpTo(Infinity)], events: [] },
      });
      continue;
    }

    const stepId = c.after;

    // ----- never-reached: the pinned step never ran -----
    if (!started.has(stepId)) {
      results.push({
        criterionId: c.id,
        shortCircuit: errorDetail("COULD_NOT_EXECUTE", `pinned step ${stepId} never ran (criterion ${c.id})`),
      });
      continue;
    }

    // ----- completed step: ≤-checkpoint window ending at its boundary -----
    if (completed.has(stepId)) {
      const boundary = boundaryByStepId.get(stepId);
      if (!boundary) {
        results.push({
          criterionId: c.id,
          shortCircuit: errorDetail("MISSING_BOUNDARY_SNAPSHOT", `step ${stepId} completed but its step_boundary snapshot is missing (criterion ${c.id})`),
        });
        continue;
      }
      const ordinal = ordinalByStepId.get(stepId) ?? Infinity;
      results.push({
        criterionId: c.id,
        evidence: { windowKind: "pinned", snapshots: boundariesUpTo(ordinal), events: [] },
      });
      continue;
    }

    // ----- non-completing: step ran but never reached step_complete -----
    if (!terminalEvent) {
      results.push({
        criterionId: c.id,
        shortCircuit: errorDetail("MISSING_TERMINAL_SNAPSHOT", `step ${stepId} did not complete and no terminal snapshot was captured (criterion ${c.id})`),
      });
      continue;
    }
    const failedActions = events.filter(
      (e): e is ActionEvent => e.type === "action" && e.stepId === stepId && e.status === "failed",
    );
    const stepErrors = events.filter((e): e is ErrorEvent => e.type === "error" && e.stepId === stepId);
    results.push({
      criterionId: c.id,
      evidence: { windowKind: "non_completing", snapshots: [provide(terminalEvent)], events: [...failedActions, ...stepErrors] },
    });
  }

  return results;
}
