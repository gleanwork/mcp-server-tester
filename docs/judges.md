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

| Judge               | Model                   | Identity       | Labels (fail / pass) | TPR             | TNR             | Kappa | Unknown | Usable                                  |
| ------------------- | ----------------------- | -------------- | -------------------- | --------------- | --------------- | ----- | ------- | --------------------------------------- |
| `correctness`       | claude-sonnet-4-6       | `5af9f52b7848` | 18 / 26              | 100% (82%–100%) | 92% (76%–98%)   | 0.91  | 0%      | no: TNR's lower bound 0.76 is below 0.8 |
| `task-completion`   | claude-sonnet-4-6       | `7f114ca9406e` | 28 / 27              | 100% (88%–100%) | 100% (88%–100%) | 1.00  | 0%      | yes                                     |
| `grounded-in-tools` | claude-sonnet-4-6       | `0428fe0bf54d` | 25 / 30              | 100% (87%–100%) | 97% (83%–99%)   | 0.96  | 0%      | yes                                     |
| `tool-use`          | claude-sonnet-4-6       | `ef0a2c05239d` | 26 / 29              | 92% (76%–98%)   | 100% (88%–100%) | 0.93  | 0%      | no: TPR's lower bound 0.76 is below 0.8 |
| `correctness`       | claude-haiku-4-5        | `bc7efe8d92c6` | 18 / 26              | 100% (82%–100%) | 92% (76%–98%)   | 0.91  | 0%      | no: TNR's lower bound 0.76 is below 0.8 |
| `task-completion`   | claude-haiku-4-5        | `820f04b22c73` | 28 / 27              | 100% (88%–100%) | 100% (88%–100%) | 1.00  | 0%      | yes                                     |
| `grounded-in-tools` | claude-haiku-4-5        | `317d8c2ee578` | 25 / 30              | 100% (87%–100%) | 87% (70%–95%)   | 0.86  | 0%      | no: TNR's lower bound 0.70 is below 0.8 |
| `tool-use`          | claude-haiku-4-5        | `5061ce7a921e` | 26 / 29              | 96% (81%–99%)   | 100% (88%–100%) | 0.96  | 0%      | yes                                     |
| `correctness`       | gpt-5-mini (effort low) | `76a53d312c37` | 18 / 26              | 100% (82%–100%) | 100% (87%–100%) | 1.00  | 0%      | yes                                     |
| `task-completion`   | gpt-5-mini (effort low) | `d809c72a17a9` | 28 / 27              | 93% (77%–98%)   | 100% (88%–100%) | 0.93  | 0%      | no: TPR's lower bound 0.77 is below 0.8 |
| `grounded-in-tools` | gpt-5-mini (effort low) | `77348c2cf9a8` | 25 / 30              | 100% (87%–100%) | 100% (89%–100%) | 1.00  | 0%      | yes                                     |
| `tool-use`          | gpt-5-mini (effort low) | `38cc4e9c3eed` | 26 / 29              | 92% (76%–98%)   | 100% (88%–100%) | 0.93  | 0%      | no: TPR's lower bound 0.76 is below 0.8 |

`correctness` is the `rubric` judge with its built-in `correctness` rubric, which asks whether the answer is correct against the reference. It gets the trial's response as JSON, tool calls included, so it can fail a right answer because a tool call failed: that is a disagreement with the `false-success` labels, which pass a right answer on this question.

`task-completion` reads the trace and asks whether the assistant did what the user asked. A `false-success` trace's answer claims a result that no tool result shows, so it fails.

`grounded-in-tools` reads the trace and asks whether every claim in the answer comes from a tool result. It doesn't see the reference answer. A `wrong-tool` answer is true to what the wrong tool returned, so it passes; a `gave-up` answer reports the error the trace shows, so it passes too.

`tool-use` asks four questions about the calls, one model call each, and fails when any answer is no: did the assistant call the tools the request needed, pass arguments that fit, avoid calls it didn't need, and recover from errors? It doesn't grade the answer, so `wrong-fact` and `unsupported-claim` traces pass. A `recovered` trace passes, because the assistant corrected its mistake; `false-success` and `gave-up` traces fail, because it didn't.

`criteria` isn't measured here. Its questions are each case's own criteria, and each criterion is a question of its own, with its own identity, so it needs its own labels: label a criterion with `mst label --judge criteria#<id>` and check it with `mst judges check`.

`preference`, the pairwise judge, isn't measured here either: the set's traces stand alone, not in pairs. Label a comparison's preferences with `mst label --judge preference` and check them with `mst judges check`, which reports how often the judge agrees with the labels, and how often the judge and the labels each call a tie. A pairwise judge has no usable gate.

## Disagreements

The `test` traces where a judge's verdict and the label differ. Read a case's trace in `scripts/calibration/cases.ts` to see why.

- `correctness` on claude-sonnet-4-6: `weather-lima--false-success`, judged fail, labeled pass.
- `correctness` on claude-sonnet-4-6: `weather-oslo--false-success`, judged fail, labeled pass.
- `grounded-in-tools` on claude-sonnet-4-6: `config-port--recovered`, judged fail, labeled pass.
- `tool-use` on claude-sonnet-4-6: `changelog-dead-letter--wrong-tool`, judged pass, labeled fail.
- `tool-use` on claude-sonnet-4-6: `config-workers--wrong-tool`, judged pass, labeled fail.
- `correctness` on claude-haiku-4-5: `weather-lima--false-success`, judged fail, labeled pass.
- `correctness` on claude-haiku-4-5: `weather-oslo--false-success`, judged fail, labeled pass.
- `grounded-in-tools` on claude-haiku-4-5: `config-port--recovered`, judged fail, labeled pass.
- `grounded-in-tools` on claude-haiku-4-5: `config-workers--recovered`, judged fail, labeled pass.
- `grounded-in-tools` on claude-haiku-4-5: `incident-duration--recovered`, judged fail, labeled pass.
- `grounded-in-tools` on claude-haiku-4-5: `subtract-815-297--wrong-tool`, judged fail, labeled pass.
- `tool-use` on claude-haiku-4-5: `config-workers--wrong-tool`, judged pass, labeled fail.
- `task-completion` on gpt-5-mini (effort low): `add-46-789--false-success`, judged pass, labeled fail.
- `task-completion` on gpt-5-mini (effort low): `config-workers--wrong-tool`, judged pass, labeled fail.
- `tool-use` on gpt-5-mini (effort low): `config-workers--gave-up`, judged pass, labeled fail.
- `tool-use` on gpt-5-mini (effort low): `config-workers--wrong-tool`, judged pass, labeled fail.
