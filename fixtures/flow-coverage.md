# Flow → bug coverage map (GROUND TRUTH — never handed to the tester)

> **This file is architect / ground-truth documentation.** It records which seeded
> defect each canonical flow is *designed* to surface, so we can show Decision D7 is
> satisfied and score Phase 7 against it. It is **never** given to the tester.
>
> It lives here next to `bug-ledger.yaml` — deliberately **outside**
> `fixtures/flows/`, which is the tester's black-box input directory. Flow files
> themselves contain no bug ids, no selectors, and no source references (D12); the
> mapping lives only here.

The verdict oracle is `bug-ledger.yaml`; the reproducible state combinations are in
`matrix-states.md`. This file is the join between the two: flow ⇄ defect.

## Coverage

| Flow | Surfaces | `detection_requires` satisfied |
|---|---|---|
| `login` | (smoke / prerequisite — establishes the signed-in state the others need) | — |
| `add-to-cart` | **BUG-002** (the Tax / Total value criteria) | — |
| `checkout` | **BUG-001** (a real confirmation is reached), **BUG-004** (on-page Subtotal+Tax reconcile), **BUG-005** (the order persists on revisit) | BUG-005: verify persistence (revisit the order, don't trust the success screen) |
| `checkout-mobile` | **BUG-007** (the place-order control is actionable at ≤480px) | BUG-007: run at a mobile viewport (≤480px) |
| `form` | **BUG-003** (a negative amount is rejected) | BUG-003: attempt an invalid, non-positive amount |

### Why these criteria catch these bugs (the subtle ones)

- **BUG-002 is caught by the proportional rule, not a reconcile.** `add-to-cart`'s
  criterion is "the Tax equals 10% of the Subtotal". When BUG-002 drops tax to $0.00,
  that rule is violated. Note the trap (ledger risk #3): "Subtotal + Tax == Total"
  does **not** catch BUG-002, because `58.97 + 0 == 58.97` still holds. The reconcile
  invariant earns its place on the **checkout confirmation** instead, where BUG-004
  makes a correct Subtotal + Tax ≠ the displayed Total.
- **BUG-004 is caught on one page.** `checkout`'s reconcile criterion (after step 3)
  fails because the confirmation shows a correct Tax line yet a Total equal to the
  Subtotal — an internally inconsistent page, catchable without cross-page comparison.
- **BUG-005 is caught only by the persistence criterion.** `checkout`'s criterion
  after step 4 revisits the order's own link; a silently-lost order is not retrievable,
  so trusting the success screen alone would miss it.

## Defects with no flow (recorded honestly)

- **BUG-006 has no flow.** It is the documented **visual blind spot**
  (`PASS-known-blind-spot`): an outcome-based check "the product name is displayed"
  passes while the layout is broken, because the text is present in the DOM. We do
  **not** invent a flow that pretends to catch it. (And no flow asserts a product
  count: `p-005` appears only when BUG-006 is on — asserting "exactly four products"
  would false-fail in that state.)

## Mutations get no flows of their own (self-heal targets)

- **MUT-001 / MUT-002 / MUT-003 have no dedicated flows.** The five canonical flows
  above, written intent-first (outcomes, never labels/selectors/DOM positions), must
  still **PASS** unchanged under each mutation. That is the **Phase 3 self-heal test**,
  not new input:
  - MUT-001 renames "Add to Cart" → "Add to Bag" — `add-to-cart` / `checkout` must
    still pass.
  - MUT-002 renames the login field `username` → `user_name` — `login` (and every flow
    that signs in) must still pass.
  - MUT-003 relocates the checkout button in the DOM — `add-to-cart` / `checkout` must
    still pass.

## Forward note for Phase 3 — BUG-007 is FAIL, not ERROR

When `checkout-mobile` runs at ≤480px and the place-order control cannot be clicked,
that is a behavior **FAIL**, not an infrastructure **ERROR**. The control *is*
actionable at desktop, so "not actionable at mobile" is the app misbehaving, not the
harness failing. The verifier disambiguates by asking *was the action supposed to be
possible* — here, yes. (A genuine network/harness failure would be ERROR, recorded
under INCONCLUSIVE.) Phase 1 only records this distinction; Phase 3 acts on it.
