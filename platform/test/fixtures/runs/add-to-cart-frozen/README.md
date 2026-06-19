# Frozen evidence fixture — `add-to-cart-frozen`

**Do not edit the snapshot blobs.** Their digests are computed over the exact `yaml`
bytes; any edit breaks the audit-chain / resolver digest re-verification.

This is a **byte-exact, trimmed slice** of the approved Phase 2 Task 7 exit run
`add-to-cart-2026-06-18T21-34-32-463Z-d1908fac` (`executionStatus: completed`, run-log
`"1.0"`). It exists so the Phase 3 resolver tests read committed frozen evidence rather
than the gitignored live `platform/runs/` dir.

Trimming rule (D21 Task 3): whole unreferenced events/blobs were dropped; **no retained
blob's `yaml` was modified**. Retained:

- structural events: `flow_start`, `step_start`×5, `step_end`×5, `flow_end` (verbatim);
- the 5 `step_boundary` snapshots (`snapshot-005/008/013/018/021`, stepIds S1–S5) and the
  1 `terminal` snapshot (`snapshot-022`), with their original `snapshotDigest`s.

Dropped: all `pre_action` snapshots and their blobs, and the `llm_decision` / `action` /
`retry` / `error` events. Original `seq` numbers are preserved (so there are gaps).

`run.json` is the original full-run manifest copied verbatim; its `totals` describe the
original run, not this slice.
