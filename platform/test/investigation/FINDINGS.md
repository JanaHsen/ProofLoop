# Phase 5 · Task 2 — Mode-delta characterization findings (investigation-only)

> **Status:** evidence for Task 4. This document is the **sole authorized basis** for the
> Task 4 snapshot-parity normalizer's dropped-field allow-list (D37). It records what was
> *observed*, not a normalizer. No normalization was performed in Task 2.
>
> **Headline result:** at every mandatory checkpoint, the headed and headless scrubbed
> canonical snapshots are **byte-identical** with **identical digests**, and the same-mode
> control is byte-identical too. **Zero cross-mode differences were observed.** Per the Task 2
> instruction, no volatility allow-list is invented from the absence of deltas.

---

## 1. Method

A clearly-marked **investigation-only / test-only** launcher
([`mode-delta.ts`](./mode-delta.ts), runner [`run-capture.ts`](./run-capture.ts)) drives the
pinned `@playwright/mcp` server in both browser modes and captures the accessibility snapshot
through the **production** path. It controls **only** browser mode; it is not wired into the
CLI, the run path, the run-log schema, or the manifest.

- **Mode mechanism (confirmed against the pinned package).** `@playwright/mcp@0.0.76` is
  *headed by default*; headless is opt-in via `--headless`. Verified in the package's own
  README option table: `| --headless | run browser in headless mode, headed by default | …`.
  The launcher therefore produces:
  - **headed** = the production argv, byte-for-byte (`buildServerArgs`, no mode flag);
  - **headless** = the production argv **plus exactly one trailing `--headless`**.
  Because `--headless` is a recognized, documented option and every headless launch
  **succeeded**, the headless captures genuinely ran headless — there was **no silent
  fallback to headed** (Risk 5).

- **Production infrastructure reused verbatim** (no alternate implementation of any of these):
  - MCP init / lifecycle / navigation / snapshot capture — inherited from
    `PlaywrightMcpClient` (the launcher overrides **only** the `buildLaunchArgs` seam);
  - snapshot parsing — production `parseSnapshot` (via the inherited `snapshot()`);
  - run-scoped redaction — production `redactValuesInText`;
  - canonical digest — production `digestSnapshot`.
  The scrub→digest order mirrors `RunLogger.recordSnapshot` exactly: redact first, then digest
  the scrubbed bytes.

- **Production seam added (behavior-preserving).** `PlaywrightMcpClient.launch()` now calls a
  new `protected buildLaunchArgs()` whose default returns `buildServerArgs(this.opts)` —
  identical to before. `buildServerArgs` itself is unchanged. No mode parameter was introduced
  into the production options/CLI/manifest surface (that is Task 3).

### Constants held fixed across the pair (mode is the sole variable)

| Input | Value (both modes) |
|---|---|
| MCP server | `@playwright/mcp@0.0.76` (pinned), Playwright `1.61.0-alpha-1781023400000` |
| Browser engine | `chromium` (build 1226) |
| Viewport | `desktop` = `1280x720` |
| Isolation | `--isolated` (fresh in-memory profile per capture) |
| Snapshot mode | `--snapshot-mode full`, `--output-mode stdout` |
| SUT state | clean (`PROOFLOOP_BUGS` empty; server logged `bugs:[]`) |
| Navigation | single harness `browser_navigate` to the checkpoint URL; identical sequence |
| Session | fresh isolated subprocess per (mode, checkpoint, repeat) |
| LLM | none (no decider / verifier / summarizer — zero API spend) |

### Checkpoints

Auth-free, deterministic, server-rendered pages where each mode reaches the same page state by
navigation alone (removes D18 path divergence): **`/login`** and **`/form`**.

### Captures per checkpoint

Three isolated sessions: `headed-1`, `headed-2` (same-mode control), `headless-1`. The
same-mode control distinguishes ordinary temporal instability from a true cross-mode delta
(requirement 10).

---

## 2. Results

Source record: `report.json` produced by the runner.

### Checkpoint `/login`

| Capture id | Mode | refs | lines | digest |
|---|---|---|---|---|
| `login.headed-1` | headed | 19 | 29 | `sha256:dad365c470af0f71d5dc00b36fa9772b0e264a9e4220fe778c209e80d9f10626` |
| `login.headed-2` | headed | 19 | 29 | `sha256:dad365c470af0f71d5dc00b36fa9772b0e264a9e4220fe778c209e80d9f10626` |
| `login.headless-1` | headless | 19 | 29 | `sha256:dad365c470af0f71d5dc00b36fa9772b0e264a9e4220fe778c209e80d9f10626` |

- **Same-mode control** (`headed-1` vs `headed-2`): byte-identical = **true**, digest match = **true**, differences = **0**.
- **Cross-mode** (`headed-1` vs `headless-1`): byte-identical = **true**, digest match = **true**, differences = **0**.

### Checkpoint `/form`

| Capture id | Mode | refs | lines | digest |
|---|---|---|---|---|
| `form.headed-1` | headed | 18 | 26 | `sha256:291973ef276b530d9f5f27b094d05a638d8d7ad7f5a0669cb526c63cd7b77725` |
| `form.headed-2` | headed | 18 | 26 | `sha256:291973ef276b530d9f5f27b094d05a638d8d7ad7f5a0669cb526c63cd7b77725` |
| `form.headless-1` | headless | 18 | 26 | `sha256:291973ef276b530d9f5f27b094d05a638d8d7ad7f5a0669cb526c63cd7b77725` |

- **Same-mode control** (`headed-1` vs `headed-2`): byte-identical = **true**, digest match = **true**, differences = **0**.
- **Cross-mode** (`headed-1` vs `headless-1`): byte-identical = **true**, digest match = **true**, differences = **0**.

### Per-checkpoint delta ledger (the required table)

| Checkpoint | headed id | headless id | raw scrubbed YAML byte-identical? | raw digests match? | observed differences | field/path | headed value | headless value | classification | justification |
|---|---|---|---|---|---|---|---|---|---|---|
| `/login` | `login.headed-1` | `login.headless-1` | **yes** | **yes** | **none** | — | — | — | *n/a (no deltas)* | nothing to classify |
| `/form` | `form.headed-1` | `form.headless-1` | **yes** | **yes** | **none** | — | — | — | *n/a (no deltas)* | nothing to classify |

There were **no** observed differences at either checkpoint, so there is no field, path, value
pair, or classification to record.

---

## 3. The hypothesized volatile fields were present but invariant

The Phase 2 no-progress normalizer strips `[ref=eN]`, `[active]`, `[cursor=…]` as *within-run*
churn. Task 2 tested whether those are **cross-mode** volatile. They are **not** — they are
present in every capture yet identical across modes and across same-mode repeats:

| capture | `[ref=` count | `[active]` count | `[cursor=` count |
|---|---|---|---|
| every `/login` capture (×3) | 19 | 1 | 6 |
| every `/form` capture (×3) | 18 | 1 | 6 |

`[ref]` numbering is assigned in document order and is **deterministic** for the same DOM, so
fresh isolated sessions — headed or headless — reproduce `e1…eN` identically. `[active]` (the
focused root) and `[cursor=pointer]` hints are likewise position-stable here. **None of the
Phase 2 volatile fields qualifies as a cross-mode mode-incidental field on this evidence.**

> Consequence for Task 4: copying the Phase 2 `[ref]/[active]/[cursor]` set into the parity
> allow-list would be **unjustified by evidence** and would risk manufacturing false parity
> (Risk 1). The allow-list must stay **empty / closed by default** unless a future, gated
> observation produces a real cross-mode delta.

---

## 4. Evidence — captured snapshots

Digests above are over the exact captured bytes. The `/form` capture is reproduced verbatim;
the `/login` capture is reproduced with its two **page-rendered demo-account hints masked**
(`alice / password123`, `bob / hunter2` → masked) per the no-credentials commit rule — those
strings are not flow secrets and already live in committed SUT source
(`app/src/views/login.ejs`, `app/src/store.ts`); the stated `/login` digest is over the
**unmasked** capture.

**`/form` (headed === headless, verbatim):**

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "ProofLoop SUT" [ref=e3] [cursor=pointer]:
      - /url: /
    - navigation [ref=e4]:
      - link "Products" [ref=e5] [cursor=pointer]:
        - /url: /products
      - link "Cart" [ref=e6] [cursor=pointer]:
        - /url: /cart
      - link "Form" [ref=e7] [cursor=pointer]:
        - /url: /form
      - link "Log in" [ref=e8] [cursor=pointer]:
        - /url: /login
  - main [ref=e9]:
    - heading "Submit a request" [level=1] [ref=e10]
    - generic [ref=e11]:
      - generic [ref=e12]:
        - text: Name
        - textbox "Name" [ref=e13]
      - generic [ref=e14]:
        - text: Email
        - textbox "Email" [ref=e15]
      - generic [ref=e16]:
        - text: Amount
        - textbox "Amount" [ref=e17]
      - button "Submit" [ref=e18] [cursor=pointer]
```

**`/login` (headed === headless; demo credentials masked for this doc only):**

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "ProofLoop SUT" [ref=e3] [cursor=pointer]:
      - /url: /
    - navigation [ref=e4]:
      - link "Products" [ref=e5] [cursor=pointer]:
        - /url: /products
      - link "Cart" [ref=e6] [cursor=pointer]:
        - /url: /cart
      - link "Form" [ref=e7] [cursor=pointer]:
        - /url: /form
      - link "Log in" [ref=e8] [cursor=pointer]:
        - /url: /login
  - main [ref=e9]:
    - heading "Log in" [level=1] [ref=e10]
    - generic [ref=e11]:
      - generic [ref=e12]:
        - text: Username
        - textbox "Username" [ref=e13]
      - generic [ref=e14]:
        - text: Password
        - textbox "Password" [ref=e15]
      - button "Log in" [ref=e16] [cursor=pointer]
    - paragraph [ref=e17]:
      - text: Try
      - code [ref=e18]: alice / ***********
      - text: or
      - code [ref=e19]: bob / *******
      - text: .
```

---

## 5. Same-mode stability and representativeness

- **Same-mode control was run and was clean.** `headed-1` vs `headed-2` is byte-identical at
  both checkpoints, so there is **no temporal instability** to disentangle from a cross-mode
  delta. The minimal control required by requirement 10 was performed and showed stability;
  no further control was needed.
- **Representativeness / replay-driver escalation.** The two mandatory static checkpoints show
  **perfect** headed/headless parity, including across the very fields hypothesized to be
  volatile. This is sufficient evidence to **start Task 4's normalizer closed (empty
  allow-list)**. These auth-free pages do not exercise post-action stateful surfaces (e.g.
  ref churn after dynamic DOM mutation), so they do **not** prove parity everywhere — but the
  Task 2 mandate is to characterize observed deltas, and the observed delta set is empty. The
  **deterministic replay driver was NOT built** (it is out-of-scope speculative work and
  requires a human gate); nothing in this evidence warrants escalation.

---

## 6. Directives carried into later tasks

1. **Task 4 allow-list starts EMPTY / closed-by-default.** No field — including
   `[ref]/[active]/[cursor]` — has evidence of being cross-mode mode-incidental. Any field is
   significant until a future gated observation shows otherwise.
2. **The negative-guard suite (Task 4) is what gives the normalizer teeth**, since the positive
   corpus here normalizes trivially (already byte-identical). The guards must prove real
   behavioral flips (role/name/value/checked/disabled/element add-remove) still mismatch.
3. **Task 6** will re-run these checkpoints through the **production** mode-capable launcher
   (Task 3) and assert the same equivalence; this investigation-only launcher is removed at
   that point (preferred) unless explicitly converted at the Task 4 gate.

---

## 7. Reproduce

With the clean SUT running (`PROOFLOOP_BUGS` empty, default port 3000):

```bash
# from platform/
node --require ts-node/register/transpile-only \
  test/investigation/run-capture.ts --base http://localhost:3000 --out <dir>
```

Non-live unit tests (no browser/SUT/API) covering the arg toggle, production-untouched
guarantees, and production-path reuse live in
[`test/investigation.test.ts`](../investigation.test.ts) and run under `npm test`.
