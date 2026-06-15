# Phase 0 — Ground-truth state matrix (frozen)

Reproducibility record for Phase 7: the exact `PROOFLOOP_BUGS` flag combinations
that produce each cell of the state matrix. Set the flag(s) in the environment
(`.env` line `PROOFLOOP_BUGS=`, comma-separated) and **restart** the app — flag
state is read once at startup. `fixtures/bug-ledger.yaml` is the verdict oracle;
this file is the *reproduction index*.

**Tags:**
- `v0-clean` — verified clean baseline (commit `131b98f`).
- `v0-ground-truth` — verified seeded state (this freeze).

## The matrix

| State | `PROOFLOOP_BUGS` | Expected verdict (affected flow) | Measures later |
|---|---|---|---|
| CLEAN | *(empty)* | PASS | false-fail |
| BUGGY | one `BUG-xxx` (below) | FAIL\* | false-pass |
| MUTATED | one `MUT-xxx` (below) | PASS | self-heal |
| BUGGY+MUTATED | one `BUG` + one `MUT` | FAIL\* | the regression trap |

\* BUG-006 is the documented blind spot (expected `PASS-known-blind-spot`); every
other bug expects FAIL on its named flow.

## CLEAN
```
PROOFLOOP_BUGS=
```
All four flows correct. This is the false-fail reference; identical to tag `v0-clean`.

## BUGGY — one bug at a time (seven single-flag states)

| Flag | Affected flow | Expected verdict |
|---|---|---|
| `PROOFLOOP_BUGS=BUG-001` | checkout | FAIL |
| `PROOFLOOP_BUGS=BUG-002` | add-to-cart | FAIL |
| `PROOFLOOP_BUGS=BUG-003` | form | FAIL |
| `PROOFLOOP_BUGS=BUG-004` | checkout | FAIL |
| `PROOFLOOP_BUGS=BUG-005` | checkout (state-dependent) | FAIL |
| `PROOFLOOP_BUGS=BUG-006` | product-page | PASS-known-blind-spot |
| `PROOFLOOP_BUGS=BUG-007` | checkout (≤480px viewport) | FAIL |

## MUTATED — one mutation at a time (three single-flag states)

| Flag | Affected flow | Expected verdict |
|---|---|---|
| `PROOFLOOP_BUGS=MUT-001` | add-to-cart | PASS |
| `PROOFLOOP_BUGS=MUT-002` | login | PASS |
| `PROOFLOOP_BUGS=MUT-003` | checkout (cart page) | PASS |

## BUGGY+MUTATED — a bug composed with a mutation (the regression trap)

Verified example (walked by the human at the Task 8 gate):
```
PROOFLOOP_BUGS=BUG-002,MUT-001
```
Both effects are visible simultaneously: the cart shows **Tax $0.00 / Total ==
Subtotal** (BUG-002) **and** the add-to-cart button reads **"Add to Bag"**
(MUT-001). Expected verdict: **FAIL** — the behaviour bug must still be caught
despite the benign structural change. Any single `BUG-xxx` + single `MUT-xxx`
pair is a valid cell of this kind.

## NOT a supported configuration

**Multiple bugs at once** (e.g. `PROOFLOOP_BUGS=BUG-001,BUG-002`) is **NOT**
supported. Bugs are designed and verified in isolation; enabling two behaviour
bugs together makes the expected verdict ambiguous and the matrix
uninterpretable. The only supported multi-flag states are: **one bug**, **one
mutation**, or **one bug + one mutation**.

## Notes

- The per-bug detection dependencies (`detection_requires` in the ledger) still
  apply inside each cell: BUG-003 needs an invalid-amount attempt, BUG-005 needs
  an order-persistence check (not just the success screen), BUG-006 needs visual
  regression (hence the blind spot), BUG-007 needs a ≤480px viewport. See
  Decision D7 in `phases/00-foundations.md`.
- `/debug/state` (token-gated, `X-Debug-Token` vs `PROOFLOOP_DEBUG_TOKEN`)
  mirrors the app's actual state for diagnosis — it reflects the wrong numbers
  when bugs are on and is **not** the oracle.
