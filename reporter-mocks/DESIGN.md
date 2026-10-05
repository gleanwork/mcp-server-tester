# Reporter redesign mocks

Static HTML mocks for an eval-focused redesign of the MCP reporter (June 2026). Not wired to data. Open any `.html` file directly in a browser.

These notes are reconstructed from the mocks and fragments of the original design discussion. Decisions marked as open were not settled, or the reasoning was lost.

## Direction

- **Evals only.** The MCP reporter should report eval results only. Regular (direct-mode) Playwright tests go to Playwright's built-in reporter instead of being mixed in.
- **Lead with the answer.** The current reporter shows many metrics up front without telling you at a glance whether the run was good. Each mock opens with a single verdict: the headline number, which way it moved against the baseline, and one sentence on what changed.
- **Failures first, passes quiet.** Scenarios that need attention are listed with a one-line diagnosis. Passing scenarios are collapsed into a short list.
- **Read the sample.** Any failing scenario expands into its trace: the prompt, what the model called, what was expected, and why it matters.
- **Secondary detail is out of the way.** Trend, by-tool, conformance and raw data sit behind a single "Details" disclosure.

## Mocks

| File                | Layout                                                                 | Screenshot                                 |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `answer-sheet.html` | Single run: verdict hero, needs attention, passing list                | `answer-sheet.png`                         |
| `matrix.html`       | Comparison: scenarios × variants grid with per-column recall           | `matrix.png`                               |
| `unified.html`      | One adaptive shell that switches between the two (preferred direction) | `unified-matrix.png`, `unified-single.png` |

### Unified adaptive report

- The header, hero, trace drill-down and footer stay the same in both views. Only the results region changes:
  - **Comparison** (more than one column, such as a variant experiment): the matrix grid, plus a hero showing the climb, e.g. `0% → 83% → 100%`.
  - **Single run:** the verdict, then needs attention, then the passing list, plus a hero like `83% ▲ vs baseline`.
- The view toggle exists only in the mock. The real UI should pick the view from the number of columns being compared.
- The choice of unified layout was based on which is clearer for the reader, not on preference (there was a mild preference for the matrix).

## Open questions

- How direct-mode results are routed to Playwright's reporter, and whether conformance stays in the MCP reporter.
- Which metric heads a run when tool recall doesn't apply, e.g. direct-mode evals or judge scores.
- How this fits the current `main`, which has changed the reporter since these mocks (reporter channel, arm/suite comparison). Arms could map naturally onto matrix columns.
