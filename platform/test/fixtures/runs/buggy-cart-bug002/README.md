# Frozen evidence fixture — `buggy-cart-bug002` (SYNTHETIC, BUG-002-style)

**Do not edit the snapshot blobs.** Digests are computed over the exact `yaml`; editing
breaks the resolver's integrity check.

A **synthetic** buggy-cart run for the Task 4 verifier replay. It is the real final-cart
accessibility snapshot with the **BUG-002 mutation injected**: the tax line is dropped to
`$0.00` and the Total collapses to equal the Subtotal.

```
Subtotal $58.97   Tax $0.00   Total $58.97
```

So `Subtotal + Tax == Total` still holds — the *reconcile* criterion PASSES this buggy
cart (the trap). The real catcher is the proportional rule "Tax equals 10% of the
Subtotal" ($0.00 ≠ $5.90), which must FAIL. No real BUG-002 run exists until the Task 6
matrix; this fixture exists only to replay candidate verifier models against a known-FAIL
case before the model is chosen.

Built from `add-to-cart-frozen/snapshots/snapshot-022.json` by string-substituting the tax
and total figures, re-parsing the yaml (so refs/elements stay consistent), and letting
`RunLogger` recompute the digest. `executionStatus: completed`; the buggy cart is both the
S1 `step_boundary` and the `terminal` snapshot (mirroring the real run, where the final
cart boundary and terminal share one digest).
