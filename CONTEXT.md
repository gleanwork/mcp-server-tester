# MCP Server Tester

Tests and evaluates MCP servers. Tests check a server's tools and protocol directly; evals have a client act on cases and grade what it did, comparing variants of the setup. The vocabulary follows common eval usage ([ADR 0002](docs/adr/0002-common-eval-vocabulary.md)). Extension follows ESLint's plugin model.

## Language

### Evals

**Eval**:
A definition of what to evaluate and how: its datasets, variants, graders and metrics.
_Avoid_: suite, manifest, task, benchmark

**Eval config**:
The JSON file that defines one eval. `mst run` runs one.
_Avoid_: manifest, suite file, config (unqualified)

**Dataset**:
A named list of cases. An eval names datasets by source: a file, a directory, a GCS object, or a plugin's dataset source.
_Avoid_: eval set, test file

**Case**:
One input for a client to act on, with what is expected of the result.
_Avoid_: example, sample, task, test, scenario

**Input**:
What a case gives the client to act on: the user's request, sent to the client as its prompt.
_Avoid_: scenario, query

**Expected**:
A case's ground truth that graders check against: an answer, rubric criteria, or the tool calls it should trigger.
_Avoid_: canonical answer, golden, target, reference

**Client**:
The MCP client application an eval tests, named canonically: `claude-code`, `cowork`, `chatgpt`, or `mst` (MST's own client, which gives the model the servers' tools and nothing else). How MST drives it (a CLI, desktop automation, an SDK) is not part of its name. A client returns a trace, never a score.
_Avoid_: host, harness, agent, runner, solver, provider

**Model**:
The LLM a client runs a case with, set beside the client (for example `claude-sonnet-4-6`); without it, the client's default.
_Avoid_: provider, engine

**MCP connection**:
MST's own connection to an MCP server, through which tests call tools directly.
_Avoid_: client (that is the application under test)

**Variant**:
One setup an eval tests: the client, its model and options (such as a system prompt), the MCP servers, and the tool metadata the client sees. Every variant runs the same cases.
_Avoid_: arm, treatment, experiment, configuration

**Baseline**:
The variant the others are compared against.
_Avoid_: control, reference

**Tool metadata**:
The tool names, descriptions and input schemas a variant shows the client instead of the servers' own. Calls are still recorded under the tools' original names.
_Avoid_: tool variant, tool overrides, override set

**Trial**:
One attempt at a case by one variant. A case runs a set number of trials; attempts that failed on infrastructure aren't trials.
_Avoid_: iteration, attempt, epoch, repetition, sample

**Trace**:
What a client did in one trial, in order: tool calls (MCP or the client's own), skill loads, commands, subagents and tool searches, with usage and the final answer.
_Avoid_: transcript, trajectory, log, response

**Evidence**:
How far a client's trace can be trusted for tool assertions: `structured` (protocol or the client's own records), `observed` (best effort) or `none`. Only `structured` evidence can pass tool-call assertions; a client that declares nothing counts as unverified.
_Avoid_: confidence, fidelity

### Grading

**Grader**:
Logic that scores a trial: an assertion or a judge.
_Avoid_: scorer, evaluator, checker

**Assertion**:
A code grader: a deterministic check of a trial's trace or answer, such as the tools it triggered or text the answer contains.
_Avoid_: expectation, check, validator

**Judge**:
A model grader: an LLM that scores a trial against the case's expected result or a rubric.
_Avoid_: LLM grader, evaluator, rater

**Pairwise judge**:
A judge that compares two variants' trials of the same case and says which is better, instead of scoring one alone.
_Avoid_: comparator, preference model

**Score**:
A grader's result for one trial: a value from 0 to 1, whether it passed, and why.
_Avoid_: verdict, grade, rating

**Pass threshold**:
The share of a case's trials that must pass for the case to pass; all of them by default.
_Avoid_: accuracy threshold

**Pass**:
Whether a case's trials met its pass threshold, decided by MST from the graders' scores, never by the client.
_Avoid_: verdict, success

**Metric**:
An aggregate over a run's trials or cases, such as pass rate, pass^k, tool recall, tokens, cost or latency.
_Avoid_: KPI, stat

### Runs and comparisons

**Run**:
One execution of an eval: every variant on every case, for the case's number of trials.
_Avoid_: experiment, suite run, execution

**Comparison**:
How a variant differs from the baseline, or a run from an earlier run: metric changes with confidence intervals, an assessment of each change (better, worse or unclear, from a paired test), and the cases that improved or regressed.
_Avoid_: diff, A/B result, verdict

**Regression case**:
A case that works today, which a variant must keep passing. Declared with the `regression` tag; when no case has the tag, the cases that pass a separate grouping run of the baseline. Never chosen from the baseline run variants are compared with, which would build in regression to the mean.
_Avoid_: keep-working case, guard case

**Capability case**:
Any case that isn't a regression case: one a variant should improve on.
_Avoid_: should-work case, target case

**Held-out case**:
A case tagged `held-out`, kept out of view while a variant was written, so its results show whether the variant generalizes.
_Avoid_: unseen case, test split

**Tool optimization**:
A run of tool-metadata variants, proposed up front or round by round, compared with the baseline, ending in a recommendation to apply one or none.
_Avoid_: variant experiment, tool experiment

### Tests

**Test**:
A direct check of a server, with no client: a Playwright test that calls tools or sends requests through MST's fixtures and checks the results with its matchers. Tests aren't evals and aren't graded.
_Avoid_: direct case, unit eval

### Extending MST

**Plugin**:
A plain object, the default export of a module or package, that contributes named extensions to MST under one namespace. A plugin is data that core reads; it does not call into core to register itself.
_Avoid_: register hook, extension module

**Namespace**:
The prefix a plugin's extensions are referenced by, as `namespace/name` (for example `acme/legacy`). Declared by the plugin's `meta.namespace`.
_Avoid_: scope, prefix

**Extension**:
One named thing a plugin contributes: a dataset source, client, judge, pairwise judge, metric or result store.
_Avoid_: contribution, registration, capability

**Built-in**:
An extension that ships with MST and is referenced by a bare name (for example `file` or `correctness`).
_Avoid_: core plugin, default

**Shared config**:
A named, reusable fragment of an eval config that a plugin offers (for example `recommended`), which an eval opts into; a plugin cannot impose it.
_Avoid_: preset, profile

**Endpoint source**:
(Planned.) An extension that supplies the base URL and credentials MST's own LLM calls use. A run uses exactly one; the built-in `env` source reads environment variables.
_Avoid_: gateway config, LLM provider

**Marketplace plugin**:
A Claude or Codex plugin installed into a desktop client under test. Unrelated to an MST plugin.
_Avoid_: plugin (unqualified)
