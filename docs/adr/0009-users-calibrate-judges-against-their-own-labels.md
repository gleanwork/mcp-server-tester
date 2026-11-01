---
status: accepted
---

# Users calibrate judges against their own labels

MST grades with judges, but it can't say how far to trust one.

- The built-in `rubric` judge gives a holistic score on a five-point scale (0, 0.25, 0.5, 0.75, 1). It reads only the final answer (`trial.response`), not the tool calls and tool results that led to it.
- Nothing in MST compares a judge's verdicts with a person's. `docs/assertions.md` calls the built-in rubrics "calibrated", but no one has measured them.
- `run.json` records each judge's `optionsHash`. That hash covers the options an eval config sets, such as `"rubric": "correctness"`, not the rubric text, the prompt or MST's version. When a built-in rubric changes, the hash stays the same.

Three facts shape what MST should do instead:

- **A judge's accuracy depends on the task.** A judge that agrees with people on one server's answers can disagree on another's. Arize Phoenix publishes its judges' accuracy and still tells users to check them on their own data. MLflow's judge alignment and Hamel Husain's guide start from the user's own labels. An audit of four tool-use benchmarks found that their evaluators disagreed with experts on 18.5% of tasks. The failures it names are rubric drift, judges that believe an agent's claim that it finished, judges that read only the answer, and run-to-run variance.
- **Who wrote a judge, and which model runs it, can change the result.** Judges favour answers from their own model family, and a rubric reduces this but doesn't remove it. When one judge model is replaced with another, model rankings change. A user who compares models or servers from several vendors needs a way to check the judge without trusting its author. That includes MST's authors and any organization whose judges come in a plugin.
- **Yes-or-no questions agree with people more than scales do.** Narrow binary checks are more stable than holistic scores. Holistic scores bunch up, so variants stop separating.

## Decision

- **MST ships the tools to calibrate a judge, and a small set of general judges. It doesn't claim that any judge is calibrated for a user's data.** Every judge is checked the same way: a built-in, a plugin's, or one hosted by a vendor and reached through a plugin.
- **A label is a person's answer to a judge's question for one trial.** For a pointwise judge, it is pass or fail. For a pairwise judge, it is a preference for one case, in the pairwise contract's words: `baseline`, `candidate` or `tie`.
  - A label belongs to the question, not to a judge version: the judge's name in results (its rubric for a `rubric` judge, otherwise its reference), plus the criterion ID for the `criteria` judge. Two `rubric` judges ask different questions, so the reference alone isn't enough. A new prompt or a new judge model reuses the same labels.
  - Labels live in the run directory, under `labels/<judge>/<variant>/<case-id>/<trial>.json` (a pairwise judge's under `labels/<judge>/<variant>/<case-id>/vs/<baseline>.json`, so a candidate compared with two baselines has a label for each). Each one records who gave it, when, and whether it is in the `dev` or the `test` split. A regrade (`.g2`) or a resume carries the run's labels over with its traces.
  - A label that gives no split gets its case's: half the cases, by a hash of the case ID, are `test`. Every trial and variant of a case shares the split, so a case a person reads while changing a judge never measures it.
  - Labeling needs the trial's answer, so a run stored with `redactStoredResponses` can't be labeled from its own files. `mst label export` says so, and `mst label` refuses such a run. Imported labels need no answers.
  - `mst label <run-id> --judge <ref>` serves a local page that shows one trial at a time, without the judge's verdict, and writes the labels. The run report stays a static file.
  - `mst label import` and `mst label export` read and write labels as CSV, JSONL or judgekeeper's records, so labels can come from another tool or go to one. An export has a row for every verdict, so a sheet filled in and imported back is a way to label without the page. An import checks every label against the run's verdicts and writes none if any fails.
- **`mst judges check` measures a judge against labels.** It takes one or more runs and the judge's name as its labels have it, and reports on the `test` split by default. `--split dev` or `--split all` is for reading while changing a judge, and isn't recorded.
  - For a pointwise judge, it reports the true positive rate (TPR: how many of the trials people failed the judge also failed), the true negative rate (TNR: how many of the trials people passed the judge also passed), Cohen's kappa, and how often the judge answered `unknown`. Each rate has a 95% Wilson interval.
  - A judge is **usable** when it has at least 15 failing and 15 passing labels on which it gave a verdict, the lower bound of both TPR and TNR is at least 0.8, and it answered `unknown` on at most 10% of the labeled trials. The gate follows judgekeeper's, with the cap on `unknown` added so that a judge can't pass by declining the hard trials. Each number can be changed (`--min-labels`, `--min-rate`, `--max-unknown`).
  - For a pairwise judge, it reports agreement with people and how often each side called a tie. A pairwise judge has no usable gate yet, because the report's corrected rate is for pointwise judges.
  - It checks each judge identity in the runs on its own. For each, it writes a calibration record to `calibrations/<judge>/<identity>.json` in the eval's directory, replacing an earlier one, and shows the disagreements so that a person can read them.
- **A judge's identity is a hash of everything that decides its verdict.** It covers the judge's reference, its `version`, its options as its schema parses them, so the provider, the model and the model settings count whether they are written out or left to defaults, and the pass threshold and repetitions that turn its answers into a verdict. Each verdict records the identity that gave it, so a regrade that keeps an older judge's verdicts doesn't credit them to the current one.
  - A built-in judge's `version` covers its prompts (system prompt, template, and rubric or criteria text) and the defaults it falls back on, such as each provider's default model.
  - A plugin judge may declare a `version`. Without one, its plugin's package version takes its place.
  - A judge with neither, such as one in a plugin loaded from a path, has no version that MST can see change. `mst judges check` still measures it, but marks the calibration **unversioned**: the report can't tell when it goes stale, says so, and tells the user to set the judge's `version`. MST doesn't hash the plugin's files instead, because a judge's behavior also depends on the modules they import.
  - `run.json` records the identity of each eval config, variant and pairwise judge beside its `optionsHash`. Every score records the identity of the judge that gave it, so a case's own judges have one too.
  - A calibration record applies only to the identity it measured. When the identity changes, the report marks the calibration stale and the user runs `mst judges check` again.
- **When a run's judge has a current calibration, the report shows a corrected pass rate beside the raw one.** The correction uses the judge's TPR and TNR (the Rogan-Gladen estimator, as Lee et al. describe for LLM judges). Its interval includes the uncertainty from both the run's sample and the calibration sample (Lang and Reiczigel's interval, which keeps its coverage at small samples and at rates of 0 or 1, where the plain delta method's shrinks to nothing). The raw rate is always shown, and is never replaced.
  - The report's _Judges_ table gives each pointwise judge's status for each variant: _calibrated_ (a usable calibration of the identity that graded it), _not usable_ (a calibration that failed the gate, with its reasons), _stale_ (calibrations of the judge, none of this identity), _not calibrated_, or _mixed versions_ (more than one identity graded the variant). Unversioned judges are marked.
  - Only a usable calibration corrects a rate. A judge that failed the gate can be close to chance, where the correction swings widely.
  - `mst judges check` rebuilds the reports of the runs it read.
- **The new built-in judges ask yes-or-no questions, read the trace, and may answer `unknown`.**
  - Each judge asks one question per model call. A judge that checks several things makes one call for each.
  - A judge gets the trace: the input, each tool call with its arguments and result (cut to `maxToolOutputSize`), and the final answer.
  - `unknown` means the trace can't support a verdict. It is recorded and not scored. Unlike today's skip, it doesn't count as a pass: the judge's pass rate leaves the trial out, the report shows how many trials it left out, and `mst judges check` counts them.
  - Each built-in judge's prompt is a file in the repository, so a change to it shows in review and changes the judge's identity.
- **The default set is four pointwise judges and one pairwise judge:**
  - `criteria`: a case lists its own criteria (`{ "id", "text", "required"? }`) in its `judges` entry, and the judge checks each one separately. The case passes when every required criterion passes. The report shows a pass rate for each criterion. The idea comes from rubric benchmarks such as HealthBench and MCP-Atlas.
  - `task-completion`: was the user's goal met? A claim of success that no tool result supports fails.
  - `grounded-in-tools`: is every claim in the answer supported by a tool result in the trace?
  - `tool-use`: did the client choose the right tools, pass valid arguments, avoid calls it didn't need, and recover from errors? It goes beside `toolsTriggered` and `toolCallCount` and doesn't replace them.
  - `preference` (pairwise): which variant's trials are better for this case? It runs in both orders (`swapPositions`), and ties are allowed.
- **The `rubric` judge stays, and its behaviour doesn't change.** Its five built-in rubrics stay available, but the docs stop calling them calibrated and point to the new judges.
- **The judge model stays the user's choice, and MST makes it visible.** The built-in judges, new ones included, keep a default provider and model so that a first run works; the user doesn't have to pick one first. The default is part of the judge's identity, so a calibration of it goes stale when the default changes. The run output and the report name every judge's model. MST warns when a judge's model family is the same as the client's model family. It knows the families by model ID (Anthropic, OpenAI, Google, Mistral, xAI, DeepSeek, Meta and Qwen) and doesn't warn about a model it can't place.
- **A judge can run on several models, as a jury.** A judge entry's `jury` lists at least two members, each the options it changes, such as `{ "model": "gpt-5-mini" }`. The members are merged over the entry's options, and each runs as its own judge, with the entry's threshold and repetitions. Any pointwise judge whose options choose its model can be a jury: a built-in, or a plugin's.
  - The verdict is the majority of the members that passed or failed. A tie between the models is `unknown`, and so is a jury whose members all answered `unknown`. A member that skips is left out, and a jury whose members all skip is skipped. A member that fails to run fails the jury's score, so a resume runs it again.
  - A `criteria` judge's criteria each take the members' majority too, and its required criteria decide its verdict, as they do over repetitions.
  - A jury's identity is the set of its members' identities, so the members' order doesn't change it, and two members may not be the same judge. A criterion's identity in a jury is the set of the members' identities for that criterion.
  - Each score records every member's verdict. The report shows each model's verdict on a trial, and, for each jury and variant, each member's pass and fail counts and the agreement between them (Krippendorff's α, nominal, over the trials, with a member that gave no verdict on a trial left out of it). The report gives no α for a `criteria` jury's criteria, or when α can't be computed: no trial with two verdicts, or every verdict the same.
  - Pairwise judges don't run as juries yet. A pairwise judge already compares both orders, and a jury of preferences needs its own rule for ties.
- **MST publishes a calibration set for its built-in judges.** The set has 128 traces: 16 tasks, each in 8 kinds of trace, from a scripted client that calls MST's mock server and the filesystem reference server. Each trace's label comes from its kind, not from a person, and the docs say so. It labels the `correctness`, `task-completion`, `grounded-in-tools` and `tool-use` questions; `criteria` asks each case's own questions, and `preference` is pairwise, so neither has labels in it. A script runs `mst judges check` on it for each judge model, refuses to publish when a judge has no verdict on a trace, and `docs/judges.md` publishes the results. The numbers show whether the built-ins are reasonable judges. They are not a calibration for a user's data.
- **Agentic and staged judges are calibrated like any other.** Their verdicts record an identity, take the same labels, and `mst judges check` measures them. MST doesn't run a check for them: a check costs minutes per trial, and the user chooses how many trials to label.
- **A judge can run on an open-weight model** through an OpenAI-compatible endpoint (`OPENAI_BASE_URL`), so it needs no vendor. MST doesn't bundle or recommend an open-weight judge until one passes on the calibration set. Judge models such as Prometheus 2, Selene Mini and Flow Judge were trained on chat and question answering, not on agent traces.

## Considered

- **One judge that MST calibrates and users trust.** This is simpler for users, but the accuracy wouldn't carry over to their servers, and users who compare vendors would have to trust MST's authors.
- **Prompt optimization against labels** (MLflow's `align()` with MemAlign, SIMBA or GEPA). It can raise agreement, but it needs a check first, and it can fit the labels too closely. It can come later, as a plugin or a command that writes a new prompt, which `mst judges check` then measures on the `test` split.
- **Using judgekeeper for the check.** It reads promptfoo, DeepEval, Inspect and MLflow results, and its gate is sound. But one person maintains it, it runs on Python, and MST would still need labels, identities and the report. MST uses its gate, and `mst label export` can write its format.
- **Keeping five-point scales and making the descriptions more precise.** Binary checks agree with people more, and holistic scores bunch up.
- **An open-weight judge as the default.** It would need no API key, but it needs local hardware, and no open-weight judge has been measured on agent traces.

## Left for later

- A usable gate for pairwise judges, and a corrected preference rate.
- Pairwise juries.
- A calibration set with labels people reviewed, and traces from more public servers.

## Consequences

- `mst.run/v1` gets a `labels/` directory, a calibration record, and a judge identity in `run.json`. All three are additions, so earlier runs stay valid.
- `JudgeDefinition` gets an optional `version`. Plugin judges keep working without one.
- Labels cost a person's time: at least 30 per judge question, and more for a tight interval. The docs should say this plainly, and `mst label` should make it fast.
- The report's headline pass rate can have two numbers. The report must say which is which.

## References

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [Bloom](https://www.anthropic.com/news/bloom)
- OpenAI, [HealthBench](https://openai.com/index/healthbench) and [GDPval](https://cdn.openai.com/pdf/d5eb7428-c4e9-4a33-bd86-86dd4bcf12ce/GDPval.pdf)
- Lee et al., [How to Correctly Report LLM-as-a-Judge Evaluations](https://arxiv.org/abs/2511.21140)
- [Benchmarking the Benchmarks](https://arxiv.org/abs/2607.02577), an audit of evaluators in tool-use benchmarks
- Hamel Husain, [How do I know if I can trust my automated eval?](https://hamel.dev/blog/posts/evals-faq/how-do-i-know-if-i-can-trust-my-automated-eval.html)
- [judgekeeper](https://github.com/judgekeeper/judgekeeper)
- Arize Phoenix, [pre-built metrics](https://www.arize.com/docs/phoenix/evaluation/pre-built-metrics); MLflow, [judge alignment](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/llm-judge/alignment/)
- Scale, [MCP-Atlas](https://labs.scale.com/leaderboard/mcp_atlas)
