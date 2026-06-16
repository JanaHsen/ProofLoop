# Flow file format (`*.flow.md`)

A **flow file** describes one user journey in plain English and states what
"correct" means for it. You write the English; ProofLoop drives a real browser to
carry it out and checks your acceptance criteria against what actually happened.

This document is the contract you write against. It is intentionally tiny: a small
fixed skeleton (front-matter + `## Steps` + `## Acceptance Criteria`) wrapped around
plain English. The parser that reads these files is **purely structural** — it
carves the file into metadata, a list of step lines, and a list of criterion lines,
and preserves your wording **verbatim**. It does not interpret what your words mean;
that happens later, when the browser is actually driven.

## File naming

- A flow file must be named `<id>.flow.md` (e.g. `checkout.flow.md`).
- The `<id>` (basename minus `.flow.md`) becomes the flow's id and the namespace for
  its step/criterion ids (e.g. `checkout:S1`, `checkout:C2`).

## 1. Front-matter (required block at the top)

A YAML block fenced by `---` lines. The schema is fixed and small:

| Key | Required | Default | Notes |
|---|---|---|---|
| `name` | **yes** | — | Human title of the flow. |
| `entry` | no | `/` | Relative path the run starts on, appended to `BASE_URL`. Never an absolute URL; never a filesystem path. |
| `viewport` | no | `desktop` | `desktop` or `mobile` only. `mobile` means the flow is run at a narrow (≤480px) screen. |
| `tags` | no | `[]` | Free-form labels of your choosing. |
| `description` | no | — | Optional one-line note. |

**Unknown keys are a hard error.** If you misspell a key (`viewpoort:`) or invent a
new one, parsing fails loudly rather than silently ignoring it. This is deliberate —
a typo must never be quietly dropped.

## 2. `## Steps` (required, at least one)

A numbered markdown list. Each item is **one action the user performs**, in plain
English. Order matters; the steps run top to bottom. Your wording is preserved
exactly.

```markdown
## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" to the cart twice.
3. Open the cart.
```

A step "succeeds" when its action was *performed and a response was observed* — not
when the response was favourable. Submitting a form that comes back with a validation
error is a **completed** step; whether that outcome was correct is judged by your
acceptance criteria, not by the step.

## 3. `## Acceptance Criteria` (required, at least one)

A markdown list. Each item is **one assertion about an outcome the user achieved**,
in plain English. **At least one criterion is mandatory** — a flow with zero criteria
is a hard error, because a flow that only lists steps can confirm a button was clicked
but can never catch a wrong total or a silently lost order.

```markdown
## Acceptance Criteria
- The Tax equals 10% of the Subtotal, rounded to the nearest cent.
- The Total equals the Subtotal plus the Tax.
```

### Pinning *when* a criterion is checked — the `(after step N)` suffix

By default a criterion is **terminal**: checked at the end of the flow. To check it at
a specific point instead, end the line with `(after step N)`, where `N` is an existing
step number:

```markdown
- Placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order. (after step 3)
```

`N` must reference a step that exists, or parsing fails. (Only step-association is
supported — there are no named checkpoints.)

## What criteria must NOT say

Criteria assert **what the user achieved**, never the mechanism. A criterion is a
defect if it mentions:

- **Element labels or button/link text** — "a button labelled 'Add to Cart' exists".
  (A renamed button must not change the verdict.)
- **Selectors, ids, or DOM structure/position** — "the element in the second row".
- **HTTP status codes** — "expect HTTP 422".
- **Bug ids or anything about ProofLoop's internals.** Flow files are pure black-box
  inputs; they contain no test-internal references.

Write the *outcome*: "the submission is rejected as invalid and is not accepted",
not "expect HTTP 400".

## Encode the rule, not the output

State the **relationship the app must honour**, not a memorised constant:

- ✅ "The Tax equals 10% of the Subtotal."
- ❌ "The Tax is $5.90."

A hardcoded figure breaks the moment a price or the catalogue changes, does not carry
to another app, and is indistinguishable from a dumb script's `assert text == "$5.90"`.
State the rule and let the verifier read the live figures and check it. (Knowing the
rule — "tax is 10%" — is knowing the product spec, which is what writing an acceptance
criterion *is*; it is not reading the app's source.)

## Full annotated example

```markdown
---
name: Complete checkout and confirm the order persists
entry: /login
viewport: desktop
tags: [checkout, persistence]
---

## Steps
1. Sign in as "alice" with password "password123".
2. Add the "Desk Lamp" twice and the "Coffee Mug" once.
3. Proceed to checkout and place the order.
4. Revisit the order's own link as a fresh visit.

## Acceptance Criteria
- Placing the order succeeds: the user reaches an order-confirmation page for a real, newly created order — not an error page and not a dead end. (after step 3)
- On the confirmation, the figures reconcile: the Subtotal plus the Tax equals the Total shown. (after step 3)
- When the order's own link is revisited, the same order is still retrievable and shows the same items and the same Total as when it was placed. (after step 4)
```

Notice the criteria name no button text, no element ids, no HTTP codes, no DOM
positions — only what the user accomplished. That is why the same file keeps passing
even if the checkout button is later renamed or moved.
