/**
 * Trusted observed-URL navigation (D48) — the deterministic safety contract for the
 * `navigate_to_observed_url` executor decision.
 *
 * The model never supplies a URL. It names the id of a snapshot captured EARLIER in the
 * SAME run; the harness reads that snapshot's stored `pageUrl` and re-validates it before
 * any navigation. This module is PURE (no filesystem in the resolver, no clock, no
 * randomness) so the contract is independently re-verifiable and exhaustively unit-tested.
 * The one fs helper (`verifyStoredSnapshotDigest`) is isolated and only re-reads + re-digests
 * an already-stored blob — the `verifyAuditChain` idiom — so the resolver core stays pure.
 *
 * There is deliberately NO `goto(url)` capability anywhere: a destination can only ever be
 * the origin-checked `pageUrl` of a same-run snapshot. A model-invented, reconstructed, or
 * directly-supplied URL has no path into a navigation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { digestSnapshot } from "../mcp/snapshot";
import type { StoredSnapshot } from "../run/schema";

/** Stable reason a trusted-destination resolution was refused. */
export type NavigationRejectCode =
  | "BAD_SNAPSHOT_ID" // the model did not name a string snapshot id
  | "SNAPSHOT_NOT_FOUND" // no snapshot with that id was captured in this run
  | "SNAPSHOT_FOREIGN_RUN" // the snapshot belongs to a different run
  | "SNAPSHOT_DIGEST_MISMATCH" // the stored blob no longer recomputes to its recorded digest
  | "NO_PAGE_URL" // the snapshot carried no usable page URL
  | "MALFORMED_URL" // the stored URL does not parse
  | "UNSUPPORTED_PROTOCOL" // not http/https (e.g. javascript:, data:, file:)
  | "URL_HAS_CREDENTIALS" // the URL embeds a username/password
  | "CROSS_ORIGIN"; // the URL is not on the configured SUT origin

/** The minimal record of a same-run snapshot the resolver reasons about. */
export interface ObservedSnapshotRecord {
  snapshotId: string;
  /** The run that captured this snapshot — must equal the current run. */
  runId: string;
  /** The digest recorded when the snapshot was stored. */
  digest: string;
  /** The stored page URL, if the snapshot carried one. */
  pageUrl?: string;
}

export type TrustedDestination =
  | { ok: true; url: string; origin: string; sourceSnapshotId: string }
  | { ok: false; code: NavigationRejectCode; detail: string };

/**
 * The canonical SUT origin derived from `BASE_URL` — the ONLY origin a navigation may ever
 * reach. Throws on a malformed `BASE_URL` (a hard misconfiguration that must fail loudly,
 * never silently widen what counts as "same origin").
 */
export function deriveSutOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/**
 * Resolve `pageUrl` against the SUT origin and confirm it is a same-origin http(s) URL with
 * no embedded credentials. Resolving with the origin as the base supports both an absolute
 * stored URL (the base is ignored) and a relative one (resolved onto the SUT origin) — the
 * post-resolution origin check is what actually enforces safety, so a stored absolute
 * `http://evil.example/...` still fails CROSS_ORIGIN and a `javascript:`/`data:`/`file:`
 * scheme still fails UNSUPPORTED_PROTOCOL. Returns the fully-qualified href to navigate to,
 * or a typed rejection.
 */
function checkUrlAgainstOrigin(
  pageUrl: string,
  sutOrigin: string,
):
  | { ok: true; href: string; origin: string }
  | { ok: false; code: NavigationRejectCode; detail: string } {
  let u: URL;
  try {
    u = new URL(pageUrl, sutOrigin);
  } catch {
    return { ok: false, code: "MALFORMED_URL", detail: `stored page URL ${JSON.stringify(pageUrl)} does not parse` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, code: "UNSUPPORTED_PROTOCOL", detail: `protocol ${JSON.stringify(u.protocol)} is not http/https` };
  }
  if (u.username !== "" || u.password !== "") {
    return { ok: false, code: "URL_HAS_CREDENTIALS", detail: "the URL embeds a username/password component" };
  }
  if (u.origin !== sutOrigin) {
    return { ok: false, code: "CROSS_ORIGIN", detail: `origin ${u.origin} is not the SUT origin ${sutOrigin}` };
  }
  return { ok: true, href: u.href, origin: u.origin };
}

/**
 * The deterministic safety contract for `navigate_to_observed_url`, as a pure function.
 * In order: the model named a string snapshot id (8 — the model supplied no URL, only an
 * id); the snapshot exists (1); it belongs to the current run (2); its stored digest still
 * verifies (3 — `digestValid`, computed by the caller from disk); it carries a page URL (4);
 * the URL parses (malformed → reject), is http/https (5), has no credentials (6), and is on
 * the SUT origin (7). Redirect-origin (9) and bounded navigation (10) are enforced at
 * execution time, not here, because they are properties of the live navigation.
 */
export function resolveTrustedDestination(args: {
  snapshotId: unknown;
  currentRunId: string;
  sutOrigin: string;
  record: ObservedSnapshotRecord | undefined;
  digestValid: boolean;
}): TrustedDestination {
  const { snapshotId, currentRunId, sutOrigin, record, digestValid } = args;
  if (typeof snapshotId !== "string" || snapshotId.length === 0) {
    return { ok: false, code: "BAD_SNAPSHOT_ID", detail: "navigate_to_observed_url requires a snapshotId string" };
  }
  if (!record) {
    return { ok: false, code: "SNAPSHOT_NOT_FOUND", detail: `no snapshot ${snapshotId} was observed earlier in this run` };
  }
  if (record.runId !== currentRunId) {
    return { ok: false, code: "SNAPSHOT_FOREIGN_RUN", detail: `snapshot ${snapshotId} belongs to run ${record.runId}, not ${currentRunId}` };
  }
  if (!digestValid) {
    return { ok: false, code: "SNAPSHOT_DIGEST_MISMATCH", detail: `snapshot ${snapshotId} failed its stored-digest re-check` };
  }
  if (typeof record.pageUrl !== "string" || record.pageUrl.trim() === "") {
    return { ok: false, code: "NO_PAGE_URL", detail: `snapshot ${snapshotId} carried no page URL to revisit` };
  }
  const checked = checkUrlAgainstOrigin(record.pageUrl, sutOrigin);
  if (!checked.ok) return checked;
  return { ok: true, url: checked.href, origin: checked.origin, sourceSnapshotId: snapshotId };
}

/**
 * Redirect-escape guard (contract item 9): the FINAL URL reached after a live navigation
 * (the post-navigation snapshot's `pageUrl`) must still be a same-origin http(s) URL. A
 * redirect that lands the browser on another origin is refused even though the requested
 * destination was same-origin. Absent/blank `finalUrl` is treated as not-allowed (we cannot
 * prove the browser stayed on the SUT).
 */
export function isAllowedFinalUrl(finalUrl: string | undefined, sutOrigin: string): boolean {
  if (typeof finalUrl !== "string" || finalUrl.trim() === "") return false;
  return checkUrlAgainstOrigin(finalUrl, sutOrigin).ok;
}

/**
 * Re-read a stored snapshot blob from disk and confirm it still recomputes to `expectedDigest`
 * (contract item 3 — "where the current architecture exposes that check"). This is the
 * `verifyAuditChain` integrity idiom applied at navigation time: a tampered or corrupt blob is
 * refused, never trusted. Any read/parse error is treated as a failed check (returns false).
 */
export function verifyStoredSnapshotDigest(
  runDir: string,
  snapshotId: string,
  expectedDigest: string,
): boolean {
  try {
    const blob = JSON.parse(
      fs.readFileSync(path.join(runDir, "snapshots", `${snapshotId}.json`), "utf8"),
    ) as StoredSnapshot;
    return digestSnapshot(blob.yaml) === expectedDigest && blob.digest === expectedDigest;
  } catch {
    return false;
  }
}
