<!-- Written by scripts/calibrate-judges.ts. Run `npm run calibrate-judges` to update it. -->

# Built-in judges on the calibration set

MST measures its built-in judges on a small calibration set, the way [`mst judges check`](./cli.md#judges-check---measure-a-judge-against-labels) measures any judge against labels ([ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md)). The numbers show whether a built-in judge is a reasonable judge of agent traces. They are not a calibration for your data: label some of your own trials and run `mst judges check` on them.

## The set

The set has 128 traces. A scripted client (`scripts/calibration/plugin.ts`) makes real tool calls against MST's mock server and the filesystem reference server (`@modelcontextprotocol/server-filesystem@2.1.0`, over a small made-up project in `scripts/calibration/files/`). Then it gives an answer written to be right or wrong in one way. There are 16 tasks (settings and history of the project, arithmetic, weather), each in 8 kinds of trace.

**No person reviewed these labels.** Each trace's label comes from its kind, by the table below, so the labels are only as right as the table and the traces that `scripts/calibration/cases.ts` builds. The labels are stored with the labeler `constructed`. The answers are short and written to be clearly right or wrong, so the set is easier than real traces.

| Trace kind        | `correctness` | `task-completion` | `grounded-in-tools` | `tool-use` |
| ----------------- | ------------- | ----------------- | ------------------- | ---------- |
| sound             | pass          | pass              | pass                | pass       |
| recovered         | pass          | pass              | pass                | pass       |
| wrong-fact        | fail          | fail              | fail                | pass       |
| unsupported-claim | no label      | pass              | fail                | pass       |
| false-success     | pass          | fail              | fail                | fail       |
| wrong-tool        | fail          | fail              | pass                | fail       |
| extra-calls       | pass          | pass              | pass                | fail       |
| gave-up           | fail          | fail              | pass                | fail       |

A label is `pass` or `fail` for the judge's question. "No label" means the kind has no single right answer to the question. One exception to the table: an arithmetic `false-success` trace has no `correctness` label. Arithmetic needs no tool, so a bare right number after a failed call would claim nothing; its answer credits the calculator instead ("The calculator gives 444."), a claim the trace contradicts, and like an `unsupported-claim` answer it has no single right answer on correctness. Half the cases, by a hash of the case ID, are in the `test` split, and the numbers below use only those.

## Results

Measured on 2026-10-31. TPR is the share of the failing traces the judge failed; TNR is the share of the passing traces it passed. Each has a 95% Wilson interval. A judge is usable when it gave a verdict on at least 15 failing and 15 passing labels, the lower bound of both TPR and TNR is at least 80%, and it answered `unknown` on at most 10% of them. The identity changes when the judge's prompt, version, model or settings do; a different identity needs measuring again. Each judge graded each trace once, and its verdicts can vary from run to run, so a judge near the 80% bound can change from usable to not.

| Judge             | Model                   | Identity       | Labels (fail / pass) | TPR             | TNR             | Kappa | Unknown | Usable                                  |
| ----------------- | ----------------------- | -------------- | -------------------- | --------------- | --------------- | ----- | ------- | --------------------------------------- |
| `correctness`     | claude-sonnet-4-6       | `5af9f52b7848` | 18 / 26              | 100% (82%–100%) | 92% (76%–98%)   | 0.91  | 0%      | no: TNR's lower bound 0.76 is below 0.8 |
| `task-completion` | claude-sonnet-4-6       | `0b5e9007515a` | 28 / 27              | 100% (88%–100%) | 100% (88%–100%) | 1.00  | 0%      | yes                                     |
| `correctness`     | claude-haiku-4-5        | `bc7efe8d92c6` | 18 / 26              | 100% (82%–100%) | 88% (71%–96%)   | 0.86  | 0%      | no: TNR's lower bound 0.71 is below 0.8 |
| `task-completion` | claude-haiku-4-5        | `6453609e4d0c` | 28 / 27              | 100% (88%–100%) | 100% (88%–100%) | 1.00  | 0%      | yes                                     |
| `correctness`     | gpt-5-mini (effort low) | `76a53d312c37` | 18 / 26              | 100% (82%–100%) | 100% (87%–100%) | 1.00  | 0%      | yes                                     |
| `task-completion` | gpt-5-mini (effort low) | `ca5c4eafb495` | 28 / 27              | 96% (82%–99%)   | 100% (88%–100%) | 0.96  | 0%      | yes                                     |

`correctness` is the `rubric` judge with its built-in `correctness` rubric, which asks whether the answer is correct against the reference. It gets the trial's response as JSON, tool calls included, so it can fail a right answer because a tool call failed: that is a disagreement with the `false-success` labels, which pass a right answer on this question.

`task-completion` reads the trace and asks whether the assistant did what the user asked. A `false-success` trace's answer claims a result that no tool result shows, so it fails.

## Disagreements

The `test` traces where a judge's verdict and the label differ. Read a case's trace in `scripts/calibration/cases.ts` to see why.

- `correctness` on claude-sonnet-4-6: `weather-lima--false-success`, judged fail, labeled pass.
- `correctness` on claude-sonnet-4-6: `weather-oslo--false-success`, judged fail, labeled pass.
- `correctness` on claude-haiku-4-5: `changelog-dead-letter--false-success`, judged fail, labeled pass.
- `correctness` on claude-haiku-4-5: `weather-lima--false-success`, judged fail, labeled pass.
- `correctness` on claude-haiku-4-5: `weather-oslo--false-success`, judged fail, labeled pass.
- `task-completion` on gpt-5-mini (effort low): `incident-cause--false-success`, judged pass, labeled fail.
