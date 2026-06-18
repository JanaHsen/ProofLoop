/**
 * Reader / verifier for run logs (Task 4). This is the proof that the Exit criterion
 * is *independently re-verifiable from the logs*: a later reader loads each referenced
 * snapshot, re-computes its digest, confirms the ref existed, and confirms the action
 * used the same snapshot + ref — using nothing but the stored artifacts.
 *
 * It also tolerates one truncated final line (a recoverable crash artifact, not
 * corruption) and infers `crashed` for a process that died mid-run.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { digestSnapshot } from "../mcp/snapshot";
import {
  ActionEvent,
  RunEvent,
  RunManifest,
  StoredSnapshot,
} from "./schema";

export interface ReadEventsResult {
  events: RunEvent[];
  /** True if the final line was truncated (a recoverable crash artifact). */
  truncatedFinalLine: boolean;
}

/** Parse events.jsonl, preserving every complete line and tolerating a truncated last one. */
export function readEvents(eventsPath: string): ReadEventsResult {
  const raw = fs.readFileSync(eventsPath, "utf8");
  if (raw.length === 0) return { events: [], truncatedFinalLine: false };
  const lines = raw.split("\n");
  // a trailing newline yields a final empty element — not a truncation
  if (lines[lines.length - 1] === "") lines.pop();

  const events: RunEvent[] = [];
  let truncatedFinalLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // only the final line may be a partial write; anything earlier is corruption
      if (i === lines.length - 1) {
        truncatedFinalLine = true;
      } else {
        throw new Error(`events.jsonl: malformed non-final line ${i + 1}`);
      }
    }
  }
  return { events, truncatedFinalLine };
}

export function readManifest(runDir: string): RunManifest {
  return JSON.parse(
    fs.readFileSync(path.join(runDir, "run.json"), "utf8"),
  ) as RunManifest;
}

/**
 * Reader-inferred crash classification: a manifest still `running` whose process is
 * gone is `crashed`. The harness never self-writes `crashed`; this is the only path
 * that produces it.
 */
export function inferCrashed(manifest: RunManifest): boolean {
  return manifest.executionStatus === "running";
}

export interface AuditFinding {
  decisionId: string;
  ref: string;
  ok: boolean;
  problems: string[];
}

export interface AuditReport {
  checked: number;
  ok: boolean;
  findings: AuditFinding[];
  truncatedFinalLine: boolean;
}

/**
 * Re-verify the snapshot→ref→action chain for every executed element-targeted action,
 * from stored artifacts only. For each action: the referenced snapshot loads, its
 * stored digest recomputes from its yaml and matches the action's snapshotDigest, the
 * ref is present in that snapshot, resolvedFrom names the same snapshot, and the
 * validation was harness-computed and valid.
 */
export function verifyAuditChain(runDir: string): AuditReport {
  const { events, truncatedFinalLine } = readEvents(
    path.join(runDir, "events.jsonl"),
  );

  const snapshotById = new Map<string, RunEvent>();
  for (const e of events) {
    if (e.type === "snapshot") snapshotById.set(e.snapshotId, e);
  }

  const findings: AuditFinding[] = [];
  for (const e of events) {
    if (e.type !== "action") continue;
    const a = e as ActionEvent;
    if (a.status !== "executed") continue;
    const problems: string[] = [];

    const snapEvent = snapshotById.get(a.snapshotId);
    if (!snapEvent || snapEvent.type !== "snapshot") {
      problems.push(`referenced snapshot ${a.snapshotId} not found`);
    } else {
      let blob: StoredSnapshot | undefined;
      try {
        blob = JSON.parse(
          fs.readFileSync(path.join(runDir, snapEvent.path), "utf8"),
        ) as StoredSnapshot;
      } catch {
        problems.push(`snapshot blob ${snapEvent.path} unreadable`);
      }
      if (blob) {
        const recomputed = digestSnapshot(blob.yaml);
        if (recomputed !== blob.digest) {
          problems.push(`stored blob digest mismatch (${recomputed} != ${blob.digest})`);
        }
        if (a.snapshotDigest !== blob.digest) {
          problems.push(`action digest ${a.snapshotDigest} != snapshot digest ${blob.digest}`);
        }
        if (!blob.refs.includes(a.ref)) {
          problems.push(`ref ${a.ref} not present in snapshot ${a.snapshotId}`);
        }
      }
    }

    if (a.resolvedFrom !== a.snapshotId) {
      problems.push(`resolvedFrom ${a.resolvedFrom} != snapshotId ${a.snapshotId}`);
    }
    if (!a.refValidation.valid || a.refValidation.validatedBy !== "harness") {
      problems.push("refValidation not harness-computed/valid");
    }

    findings.push({
      decisionId: a.decisionId,
      ref: a.ref,
      ok: problems.length === 0,
      problems,
    });
  }

  return {
    checked: findings.length,
    ok: findings.every((f) => f.ok),
    findings,
    truncatedFinalLine,
  };
}
