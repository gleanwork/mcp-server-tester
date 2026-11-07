---
name: calibrate-mcp-judge
description: Decide how far to trust an LLM judge in an MST eval by measuring it against your own labels. Covers choosing a judge that can be checked, collecting a run to label, labeling trials with mst label, measuring the judge with mst judges check, reading TPR, TNR, kappa and unknown, improving a judge without fitting it to the labels, and when a calibration goes stale. Use when asked whether a judge is accurate or can be trusted, to calibrate or validate a judge, to label trials, to check judge agreement, or when judge scores look wrong.
---

# Calibrate an MCP Judge

A judge's accuracy depends on the answers it grades. A judge that agrees with people on one server's answers can disagree on another's, so MST doesn't claim any judge is calibrated for your data. You measure it: label some trials yourself, then run `mst judges check` to compare the judge's verdicts with your labels.

A judge that passes the check is **usable**. The run report then shows its pass rate corrected for the judge's errors, beside the raw rate. A judge that is not usable still runs, but treat its pass rate as a guess.

To run evals, use `run-mcp-eval`. To add judges to a dataset or eval config, use `write-mcp-eval`.

## Step 1: Choose a judge you can check

Prefer a judge that asks one yes-or-no question. People agree on "did the answer give the port from the config?" more than on "rate this answer from 0 to 1", and so do judges.

| Judge               | Asks                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `criteria`          | Does the trial meet each criterion the case lists? One question per criterion.               |
| `task-completion`   | Did the assistant do what the user asked, as the trace shows?                                |
| `grounded-in-tools` | Is every claim in the answer supported by a tool result?                                     |
| `tool-use`          | Right tools, fitting arguments, no needless calls, errors recovered? Four questions.         |
| `rubric`            | A 0-to-1 score against a rubric (`correctness`, ...). Harder to label: you decide pass/fail. |

The yes-or-no judges read the whole trace and may answer `unknown` when the trace can't settle the question. `unknown` is not a pass.

`criteria` is the easiest to calibrate, because each criterion is one thing a person can check in the trial:

```json
{
  "id": "deploy-port",
  "input": "What port does the service listen on in production?",
  "judges": [
    {
      "type": "criteria",
      "criteria": [
        { "id": "deployed-port", "text": "The answer gives port 7341." },
        {
          "id": "names-source",
          "text": "The answer says which file the port came from.",
          "required": false
        }
      ]
    }
  ]
}
```

Pick the judge's model from a different family than the client's model, when you can. Judges favor answers from their own family, and MST warns when the two match. The built-in judges take `provider` and `model`.

## Step 2: Collect a run to label

Labeling needs the trials' answers, which MST redacts by default. Set this in the eval config before the run:

```json
"redactStoredResponses": false
```

Run the eval with the judge in it (`mst run --config eval.json`). The run needs both kinds of trial:

- **Failures and passes.** The check needs at least 16 failing and 16 passing labels, and that many only when the judge agrees with every one. Plan on about 40 of each. When nearly every trial passes, add harder cases or a weaker variant, such as a smaller model or worse tool descriptions.
- **Many cases.** Half the cases are `test`, chosen by a hash of the case ID, and only `test` labels measure the judge. All trials of a case share its split. So label across many cases, not many trials of a few, and expect to label about twice the `test` count.

Labels from several runs of the same eval count together, so you can label over time.

## Step 3: Label the trials

```bash
npx mst label page 7f3c2a --judge task-completion
```

The page opens in a browser on this machine. It shows one trial at a time: the input, the reference answer, the tool calls and the answer. It hides the judge's verdict and the variant, so neither sways you. Press `P` or `F`, add a note if you like, and press Ctrl+C in the terminal when you're done. Labels are saved as you give them.

- **Answer the question the page shows**, not your overall opinion of the trial. A wrong answer that a tool result supports is grounded: it passes `grounded-in-tools` and fails `task-completion`.
- **`--judge`** is the judge's name in results: a `rubric` judge's rubric (`correctness`), else its reference (`task-completion`, `acme/judge/completeness`). One criterion is `criteria#<id>`, such as `criteria#deployed-port`. `tool-use` shows its four questions together.
- **A plugin judge's question** is unknown to MST. Pass it with `--question "Did the answer ...?"`, so your labels answer what the judge answers.
- **Two people labeling** give their names with `--labeler`.

To label in a spreadsheet instead, export a row per verdict, fill in the `label` column with `pass` or `fail`, and import it back:

```bash
npx mst label export 7f3c2a --judge task-completion -o labels.csv
npx mst label import 7f3c2a labels.csv
```

`import` checks every row against the run and writes nothing if one is wrong.

## Step 4: Measure the judge

```bash
npx mst judges check 7f3c2a --judge task-completion
npx mst judges check 7f3c2a 9b1d04 --judge criteria#deployed-port
```

A failing trial is the positive class:

- **TPR**: of the trials people failed, the share the judge failed too. A low TPR means the judge passes bad answers.
- **TNR**: of the trials people passed, the share the judge passed too. A low TNR means the judge fails good answers.
- **kappa**: agreement beyond chance (Cohen's). Near 0 is a coin flip.
- **unknown**: labeled trials the judge couldn't decide.

Each rate has a 95% range. The judge is **usable** when it gave a verdict on at least 15 failing and 15 passing `test` labels, the low end of both TPR's and TNR's range is at least 0.8, and it answered `unknown` on at most 10%. The output says which part failed, and lists the disagreements. Read every disagreement: sometimes the judge is right and the label is wrong.

The check writes a calibration record to the eval's `calibrations/` directory and rebuilds the reports of the runs it read. `mst open` then shows the judge as _calibrated_ or _not usable_ in the report's _Judges_ table.

## Step 5: Improve a judge that isn't usable

| What the check says | Likely cause and fix                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Too few labels      | Label more cases, and add cases that fail.                                                                                             |
| Low TPR             | The judge believes the assistant's claims. Use `task-completion` or `grounded-in-tools`, or write a criterion that names the evidence. |
| Low TNR             | The judge is too strict, or its question asks more than your labels do. Narrow the criterion or the rubric.                            |
| High `unknown`      | The client doesn't report its tool calls, or long tool results are cut. Raise the judge's `maxToolOutputSize`.                         |
| Low kappa, both low | The question is vague. Split it into criteria a person can check one at a time.                                                        |

Change the judge, its model or its criterion text, then grade the run again. `mst grade` runs no client, and the regrade keeps the labels:

```bash
npx mst grade 7f3c2a --config eval.json
npx mst judges check 7f3c2a.g2 --judge task-completion --split dev
```

While you change the judge, read only `dev` labels (`--split dev`, which isn't recorded). Check the `test` split once, when you're done. A judge tuned until it matches the `test` labels has learned those labels, not your standard: if you tuned against `test`, label new cases before you trust the check.

## Step 6: Keep the calibration current

A calibration applies to one judge **identity**: a hash of the judge, its version, its model and options, its threshold and its repetitions. Change any of them and the report marks the calibration _stale_. Your labels still apply, because a label belongs to the question, not the judge version. Grade a run with the changed judge and run `mst judges check` again.

- **A changed criterion text** is a new identity. When the criterion's meaning changes, give it a new `id`, so old labels don't answer the new question.
- **An _unversioned_ judge**, from a plugin with no version, can't go stale as far as MST can see. Set the judge's `version` in the plugin.
- **Another server or dataset** may need its own labels. A judge usable on one server's answers is not usable on another's until you check it.

## Pairwise judges

A pairwise judge, such as the built-in `preference`, compares a variant's trial with the baseline's. Label it the same way: `mst label page 7f3c2a --judge preference` shows each case's two sides as A and B, and you press `A`, `B` or `T` (tie). `mst judges check` reports how often the judge's preference matches yours and how often each of you called a tie. Pairwise judges have no usable gate yet.

## Common mistakes

- **Trusting MST's published numbers for your data.** [Built-in judges on the calibration set](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/judges.md) is MST's own set, with constructed labels. It is not a calibration of your server.
- **Labeling a redacted run.** `mst label` refuses it. Set `"redactStoredResponses": false` and run again.
- **Labeling only passing trials.** The check needs failures as much as passes.
- **Tuning on the `test` split.** Use `--split dev` while changing the judge.
- **Labeling your opinion of the answer instead of the judge's question.** Read the question on the page first.

## References

- [`mst judges check`](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/cli.md#judges-check---measure-a-judge-against-labels) and [`mst label`](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/cli.md#label---label-judge-verdicts): every option
- [Judges](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/evaluation-framework.md#judges): built-in judges, juries and where judges are listed
- [ADR 0009](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/adr/0009-users-calibrate-judges-against-their-own-labels.md): why users calibrate judges against their own labels
