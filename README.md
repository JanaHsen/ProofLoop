# ProofLoop

ProofLoop is an LLM-based, intent-driven end-to-end testing platform.

Instead of writing brittle browser scripts with hardcoded selectors, users describe a business flow in plain English. ProofLoop interprets the flow, navigates a real web application, collects structured evidence, verifies the expected outcomes, and produces an auditable test report.

The platform is designed to adapt to harmless interface changes while remaining strict about actual application behaviour.

## Why ProofLoop?

Traditional end-to-end tests often depend on fixed selectors, DOM structure, and carefully scripted interaction sequences. Small interface changes can break these tests even when the application still behaves correctly.

ProofLoop separates **test intent** from **page structure**:

```text
Plain-English flow
        ↓
Deterministic flow parser
        ↓
LLM-guided browser execution
        ↓
Stored snapshots and execution evidence
        ↓
Evidence-backed verification
        ↓
Structured report and CI verdict
```

The LLM handles interpretation and navigation, while deterministic components enforce schemas, evidence integrity, citation validity, cost limits, and final verdict rules.

## Key Features

### Natural-language test flows

Business flows and acceptance criteria are written in readable Markdown rather than browser automation code.

Example:

```text
Log in as a valid user.
Add two products to the cart.
Open the cart.

Acceptance criteria:
- Both products appear in the cart.
- Each line total equals price multiplied by quantity.
- The final total is calculated correctly.
```

### Adaptive browser execution

Before acting, ProofLoop examines the current page snapshot and selects an element according to its role and purpose.

This allows execution to tolerate non-behavioural changes such as:

* elements moving on the page;
* additional wrapper elements;
* changed generated references;
* altered layout or styling;
* minor wording changes where intent remains clear.

### Snapshot-then-act safety

Every browser action is based on a fresh page snapshot. ProofLoop does not rely on stale element references from earlier states.

### Evidence-backed verification

After execution, a separate verification stage evaluates every acceptance criterion using stored evidence.

Each criterion receives one of the following outcomes:

* `PASS` — the evidence proves the expected behaviour;
* `FAIL` — the evidence proves the behaviour is incorrect;
* `INCONCLUSIVE` — the available evidence cannot support a trustworthy decision.

Verifier citations are checked deterministically before a result is accepted.

### Self-healing without hiding real failures

ProofLoop can adapt when the interface structure changes, but it does not reinterpret broken business behaviour as success.

For example:

* a moved checkout button should not break the test;
* an incorrect tax calculation must still fail;
* missing or unsupported evidence must remain inconclusive.

### Headed and headless execution

The same flow can run in:

* **headed mode** for observation and debugging;
* **headless mode** for faster automated execution.

Both modes follow the same execution and evidence contracts.

### Structured reports

ProofLoop produces machine-readable and human-readable artifacts, including:

* execution events;
* page snapshots;
* verification results;
* JSON reports;
* HTML reports;
* CI summaries;
* model cost and latency information.

### CI integration

ProofLoop can run its configured flow suite through GitHub Actions.

The CI pipeline:

* starts the System Under Test;
* waits for application health;
* executes flows serially;
* verifies acceptance criteria;
* aggregates results;
* uploads evidence and logs;
* fails the job unless every flow is cleared.

## Architecture

ProofLoop is divided into several responsibilities:

| Component          | Responsibility                                                                       |
| ------------------ | ------------------------------------------------------------------------------------ |
| Flow parser        | Converts Markdown flow definitions into a validated deterministic plan               |
| Executor           | Uses an LLM and browser tools to perform the planned steps                           |
| Snapshot system    | Captures structured page state before browser actions                                |
| Evidence resolver  | Selects the stored evidence relevant to each criterion                               |
| Verifier           | Uses an LLM to evaluate acceptance criteria from stored evidence                     |
| Citation validator | Deterministically confirms that verifier observations belong to their cited evidence |
| Reporter           | Produces JSON and HTML test reports                                                  |
| CI aggregator      | Combines multiple flow reports into one enforceable CI result                        |

## Repository Layout

| Path                       | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `app/`                     | Controlled demonstration application used as the System Under Test  |
| `fixtures/flows/`          | Plain-English ProofLoop flow definitions                            |
| `fixtures/bug-ledger.yaml` | Seeded application defects and expected behavioural outcomes        |
| `platform/`                | Parser, executor, verifier, evidence, reporting, and CI tooling     |
| `presentation/`            | Curated deterministic demonstration artifacts                       |
| `.github/workflows/`       | GitHub Actions integration                                          |
| `phases/`                  | Dependency-ordered project specifications and engineering decisions |
| `CLAUDE.md`                | Repository-level engineering rules and constraints                  |

## Development Phases

The project is organized into dependency-ordered phases so that each capability is proven before later features depend on it.

The phases cover:

1. controlled System Under Test and bug seeding;
2. deterministic natural-language flow parsing;
3. LLM-guided browser execution;
4. evidence-backed post-execution verification;
5. resilience to structural UI mutations;
6. headed and headless execution parity;
7. CI/CD integration.

The phase documents record technical contracts, design decisions, validation requirements, and completed work.

## Setup

### Requirements

* Node.js 24
* npm
* Chromium through Playwright
* an Anthropic API key

### Environment configuration

Create a local environment file from the example:

```bash
cp .env.example .env
```

Add the required local values:

```env
ANTHROPIC_API_KEY=your_key_here
BASE_URL=http://localhost:3000
```

The `.env` file is gitignored and must never be committed.

### Install dependencies

Install the System Under Test dependencies:

```bash
cd app
npm ci
```

Install the ProofLoop platform dependencies and Chromium:

```bash
cd ../platform
npm ci
npx playwright install chromium
```

## Running the Demonstration Application

From the `app/` directory:

```bash
npm run dev
```

The application runs locally on:

```text
http://localhost:3000
```

Application defects can be enabled through the supported bug-toggle configuration to test whether ProofLoop detects real behavioural failures.

## Running a Flow

From the `platform/` directory:

```bash
npm run run -- ../fixtures/flows/login.flow.md --id-file run-id.txt
```

The command writes the generated run ID to `run-id.txt`.

Verify the completed run:

```bash
npm run verify -- --run <RUN_ID> --id-file evaluation-id.txt
```

Generate its report:

```bash
npm run report -- --run <RUN_ID> --evaluation <EVALUATION_ID>
```

Run artifacts are stored under:

```text
platform/runs/<RUN_ID>/
```

A completed run may contain:

```text
run.json
events.jsonl
snapshots/
evaluations/
reports/
```

## CI Execution

ProofLoop runs its configured five-flow suite through GitHub Actions in two ways:

* **Automatically** on a **same-repository** pull request that changes a watched path —
  `app/**`, `platform/**`, `fixtures/flows/**`, or `.github/workflows/proofloop.yml`. A pull
  request that touches only other paths (for example documentation) does **not** trigger a run.
* **Manually** at any time from `Actions → ProofLoop → Run workflow`.

On a pull request the outcome is posted as a single sticky comment that is updated in place on
re-runs, and the job is red unless every flow is cleared.

### Secrets and the System Under Test

* `ANTHROPIC_API_KEY` is the **only** repository Actions secret ProofLoop requires.
* `SESSION_SECRET` for the System Under Test is **generated ephemerally per run** — it is never
  stored as a secret and never committed.

### Seeded-bug demonstration

To watch ProofLoop detect a real behavioural defect, start a manual run and set the optional
`bugs` input to a seeded defect toggle (for example `BUG-002`). The toggle is applied to the
System Under Test only; an empty value runs the suite against the clean application. A seeded run
turns the job red on the affected acceptance criterion.

The workflow uploads two artifact bundles, `proofloop-runs` and `proofloop-ci-summary`, and the
final job succeeds only when the generated CI summary reports `{"allPass": true}`.

### Limitations and scope

* CI runs on **same-repository** pull requests only. Fork pull requests are skipped (secrets are
  withheld and the token is read-only) with a notice and no comment.
* A single CI run is a **clean-app gate, not a reliability measurement** — treat one green run as
  "this change cleared once", not as a guaranteed pass rate.
* Accuracy against the seeded bug ledger is evaluated in **Phase 7**; repeated-run reliability and
  verdict variance are **Phase 8**; richer trace/video evidence is **Phase 9**.
* ProofLoop is **not** intended to be a required branch-protection merge check. Enforcement is the
  visible red/green check, the sticky comment, and a human merge decision.

## Design Principles

ProofLoop follows several core rules:

* natural language expresses intent;
* deterministic schemas control execution boundaries;
* every action uses a fresh snapshot;
* verification happens after execution;
* claims require attributable evidence;
* unsupported conclusions become `INCONCLUSIVE`;
* harmless structural changes should not cause false failures;
* real behavioural defects must not be self-healed away;
* model cost, iteration count, and execution time are bounded;
* reports and CI verdicts are derived from stored artifacts.

## Project Goal

ProofLoop explores a practical balance between autonomous browser testing and deterministic engineering controls.

The objective is not to let an LLM freely decide whether software works. The objective is to use LLM reasoning where flexibility is valuable, while keeping execution, evidence integrity, and final test enforcement reproducible and auditable.
