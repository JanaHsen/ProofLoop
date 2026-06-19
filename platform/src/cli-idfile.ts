// Machine-readable id emission for the CI loop (Phase 6, D39).
//
// `run-cli` and `verify-cli` accept an optional `--id-file <path>` and write ONLY the
// generated id (the `runId` / `evaluationId`) here — no decoration, no human-facing text.
// CI threads ids through these files instead of scraping the human-facing stdout lines
// (which are unchanged and back-compatible). Chosen over `--github-output` to stay
// CI-provider-neutral.
//
// Contract: the file holds exactly the id plus a single trailing newline and nothing else.
// A write failure THROWS so the caller can exit non-zero — an id the consumer cannot read
// is a real failure, never a silently-swallowed false success.

import * as fs from "node:fs";

/** Write ONLY `id` (plus one trailing newline) to `filePath`. Throws on any write failure. */
export function writeIdFile(filePath: string, id: string): void {
  fs.writeFileSync(filePath, `${id}\n`, "utf8");
}
