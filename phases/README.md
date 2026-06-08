# Phases

These are dependency-ordered build specs. **Execute in order.** Do not start a phase
until the previous phase's Exit Checklist is fully checked — the ordering exists
because each phase needs the one before it.

Each phase file is written to be executed by Claude Code:
- Tasks are checkboxes. Tick them as you complete them.
- `🚦 HUMAN GATE` = stop and wait for the human.
- `✅ COMMIT` = commit at this checkpoint with the suggested message.
- "Out of scope" sections are hard fences. Do not build ahead.

## Status

| Phase | File | Title | Status |
|---|---|---|---|
| 0 | `00-foundations.md` | Foundations & Ground Truth | 🟡 ready to execute |
| 1 | `01-...` | Natural-Language Flow Definition | ⬜ not written yet |
| 2 | `02-...` | Execution Engine: Snapshot-Then-Act | ⬜ not written yet |
| 3 | `03-...` | Outcome Verification & Self-Healing | ⬜ not written yet |
| 4 | `04-...` | Smart Summaries / Reporting | ⬜ not written yet |
| 5 | `05-...` | Flexible Execution | ⬜ not written yet |
| 6 | `06-...` | CI/CD Integration | ⬜ not written yet |
| 7 | `07-...` | The Evaluation Harness | ⬜ not written yet |
| 8 | `08-...` | Reliability & Determinism | ⬜ not written yet |
| (10) | `10-...` | Autonomous Fixer (optional extension) | ⬜ undecided |

Update the Status column as phases complete (⬜ → 🟡 in progress → ✅ done).

> We detail phases one at a time. Only `00-foundations.md` exists now; the rest are
> written when their turn comes, so each is informed by what we actually learned
> building the previous one.
