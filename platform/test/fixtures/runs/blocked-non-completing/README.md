# Frozen evidence fixture — `blocked-non-completing` (synthetic)

**Do not edit the snapshot blobs.** Their digests are computed over the exact `yaml`
bytes; any edit breaks the resolver's digest re-verification.

A **synthetic** frozen run for the Phase 3 resolver's failure paths. Flow `frozen-demo`
(steps S1, S2, S3); `executionStatus: error`:

- **S1** completes cleanly — `step_start` → `step_boundary` snapshot → `step_end`.
- **S2** starts, an element action returns `isError` (recorded `status:"failed"` with a
  `failureDetail` describing an actionability failure) followed by an `error` event, and
  the step **never reaches `step_complete`** (no `step_end`). This is the *non-completing*
  case: a criterion pinned `after step 2` resolves to the `terminal` snapshot + S2's
  failed-action/error events.
- **S3** never runs — a criterion pinned `after step 3` is *never-reached* ⇒
  `COULD_NOT_EXECUTE`.
- A best-effort `terminal` snapshot is captured at termination.

Generated once via `RunLogger` (fixed clock `2026-06-19T00:00:00Z`) so every blob digest
is valid; the generator script was not committed.
