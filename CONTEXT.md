# MCP Server Tester

Tests and evaluates MCP servers. Tests check a server's tools and protocol directly; evals have a client act on cases and grade what it did, comparing variants of the setup. MST is an evaluation harness. The vocabulary follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) ([ADR 0013](docs/adr/0013-mst-uses-anthropics-eval-vocabulary.md)); [ADR 0002](docs/adr/0002-common-eval-vocabulary.md) maps it to other frameworks' terms. Extension follows ESLint's plugin model.

## Language

### Evals

**Eval**:
A definition of what to evaluate and how: its datasets, variants, graders and metrics. Anthropic's longer name is eval suite.
_Avoid_: manifest, task, benchmark

**Eval config**:
The JSON file that defines one eval. `mst run` runs one.
_Avoid_: manifest, suite file, config (unqualified)

**Dataset**:
A named list of cases. An eval names datasets by source: a file, a directory, a GCS object, or a plugin's dataset source.
_Avoid_: eval set, test file

**Snapshot**:
A frozen copy of a plugin's dataset, named by an id such as a date. A run uses the source's latest snapshot unless the declaration sets `snapshot`, or `source: "live"` for **live** data fetched when the run starts. A declaration that sets either is `{ "type": "acme/dataset/x", "snapshot"?, "source"? }`, and `run.json` records which copy the run read.
_Avoid_: version, release, frozen set

**Case**:
One input for a client to act on, with what is expected of the result.
_Avoid_: example, sample, task, test, scenario

**Input**:
What a case gives the client to act on: the user's request, sent to the client as its prompt unchanged. Dataset loading rejects empty or whitespace-only inputs for every client, including run-only plugins, before opening a session or submitting any trial.
_Avoid_: scenario, query

**Expected**:
A case's ground truth that graders check against: an answer, rubric criteria, or the tool calls it should trigger.
_Avoid_: canonical answer, golden, target, reference

**Client**:
The MCP client application an eval tests, named canonically: `claude-code`, `codex-cli` (the Codex CLI; it was `codex`), `cowork`, `chatgpt`, `codex-app` (the Codex surface of the ChatGPT desktop app; it was `chatgpt` with `surface: "codex"`), or `api` (the model alone, through its provider's API, with the servers' tools; it was `mst`). One client is one product: no option changes which product it is. How MST drives it (a CLI, desktop automation, an SDK) is not part of its name. Desktop execution uses the product's `macos.ts` or `linux.ts` entry point, selected on the machine running the trial. New results record no driver identity; old stored results keep theirs. A client returns a transcript, never a score. Built-in and plugin clients return the same `ClientRunResult`: a final answer, ordered events and optional usage, diagnostics and telemetry. MST derives the assertion/report view from it. `mst clients` lists each client's requirements, options and defaults from its definition and schema. It describes OS-dependent defaults without resolving them on the coordinator. A client with its model is an agent harness.
_Avoid_: host, harness (unqualified), agent, runner, solver, provider. One exception: **host telemetry**.

**Client auth cache**:
Authentication state a client application's own helper keeps, separate from MST connector grants and credential stores. The `codex-cli` option `authCacheDirectories` links dedicated private cache directories into otherwise fresh trial homes; it does not reuse operator configuration or import existing credentials.
_Avoid_: shared client home

**Host telemetry**:
The OpenTelemetry a client application sends about a trial. MST receives it when an eval config sets `telemetry.host`, and stores it in the trial's `transcript.hostTelemetry` (docs/telemetry.md). Its OpenTelemetry export uses `mst.host.*` attributes. The name keeps "host" on purpose: the MCP specification calls the application the host, and this is the application's own export. `clientTelemetry` is different: it holds numbers MST reads from the client's own records. 1.x used `hostTelemetry` for those, as a field of a case or trial result. 2.0 writes `hostTelemetry` only inside a transcript, so MST never mistakes it for the 1.x field.
_Avoid_: client telemetry (that is `clientTelemetry`)

**Client session**:
One client kept open with fixed options, model, servers and environment. Each trial supplies its identity and prompt. The session returns a `ClientRunResult` and says whether MST can continue, must reset, or must stop. MST owns the readiness, reset and diagnosis policy. Shared timeout enforcement and reset retry timings remain deferred in [ADR 0011](docs/adr/0011-a-client-is-a-product-and-how-it-runs-is-not-configuration.md). Built-in and plugin clients expose this through `open()`; local and worker dispatch use the same session loop. A client may supply `run`, `open`, or both. Run-only clients keep their concurrency and use one-shot sessions where needed. Different fixed settings get separate sessions.
_Avoid_: driver, capability pipeline

**Model**:
The LLM a client runs a case with, set beside the client (for example `claude-sonnet-4-6`); without it, the client's default.
_Avoid_: provider, engine

**MCP connection**:
MST's own connection to an MCP server, through which tests call tools directly.
_Avoid_: client (that is the application under test)

**Vendor MCP server**:
A third-party service's MCP server (Slack's, Jira's, GitHub's) that an eval config defines, usually through a connector, so MST hands it tokens and can put a proxy in front of it. The service may publish it, or someone else may.
_Avoid_: native server, external server

**Official MCP server**:
A vendor MCP server the service publishes itself, such as the one Slack runs for Slack, rather than a community server for the same service.
_Avoid_: native server, first-party server

**Client's own connector**:
A connector a user adds inside the client, such as one from Cowork's connector directory, hosted by the client's maker. In `third-party` Cowork, MST doesn't configure or observe it. In `first-party` mode it is the account connector MST selects, sets tool permissions on, restores, and records calls of. Unrelated to an MST connector.
_Avoid_: native connector, built-in connector

**First-party mode**:
A Cowork option (`clientOptions.mode: "first-party"`) that runs trials on HTTPS connectors already connected in the signed-in Claude account, selected by MST server label, instead of servers MST configures (the default `third-party` mode). It runs locally on macOS or in a plugin-prepared Linux runtime with attached macOS source control, one trial at a time on one shard with a dedicated account. It reuses the one `caseExecution` path. Unrelated to an official MCP server.
_Avoid_: claude-ai mode, account mode

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

**Environment**:
What the client acts on: the services behind the MCP servers and their data, such as a Slack workspace or a Jira project. Not where trials are collected, which is the runner, and not a process's environment variables.
_Avoid_: backend, system under test

**Outcome**:
The final state of the environment at the end of a trial, such as whether the reservation exists. It is not what the client says it did, which is in its transcript, and not how the attempt ended, which is its ending.
_Avoid_: result, end state

**Transcript**:
What a client did in one trial, in order: tool calls (MCP or the client's own), skill loads, commands, subagents and tool searches, with usage and the final answer. Stored in a run's `transcripts/` directory ([ADR 0013](docs/adr/0013-mst-uses-anthropics-eval-vocabulary.md)). "Trace" means only an OpenTelemetry trace, which MST builds from transcripts.
_Avoid_: trace, trajectory, log, response

**Client artifacts**:
A bounded copy of the files a client kept for one trial (such as Cowork's session folder, or the Codex CLI's rollout trace), taken from the paths the client names as evidence, for judges to read. A run that keeps full transcripts stores the copy at `artifacts/<variant>/<case-id>/<trial>/`.
_Avoid_: attachments, session dump

**Failure diagnosis**:
What a desktop client captured when a case failed and left the app in an unknown state, before the reset changed it: the screen, the controls it showed, the app's logs. For whoever runs the eval, not for judges; it is the failed trial's client artifacts, and kept only where those are.
_Avoid_: crash dump, debug bundle

**Evidence**:
How far a client's transcript can be trusted for tool assertions: `structured` (protocol or the client's own records), `observed` (best effort) or `none`. Only `structured` evidence can pass tool-call assertions; a client that declares nothing counts as unverified.
_Avoid_: confidence, fidelity

**Client-native**:
Kept by the client itself rather than observed by MST: its session records, transcripts and token counts. Used only for evidence.
_Avoid_: native (unqualified)

### Grading

**Grader**:
Logic that scores a trial. A code grader is deterministic: each key of a case's `assertions`, such as `toolsTriggered` or `containsText`, is one, and records its own score under the same name (`scores.containsText`, `scores/containsText/`). A model grader is a judge. A person who gives labels is a human grader.
_Avoid_: scorer, evaluator

**Assertion**:
One condition a code grader checks, such as one expected call in `toolsTriggered` or one string in `containsText`. A case's `assertions` lists them, grouped by grader.
_Avoid_: expectation, validator

**Judge**:
A model grader: an LLM that scores a trial against the case's expected result or a rubric. Anthropic uses the name too.
_Avoid_: LLM grader, evaluator, rater

**Unknown answer**:
A judge's answer when the transcript can't support a verdict, for example when the client didn't record its tool calls. Unlike a skip, the trial doesn't pass. It has no score, the judge's pass rate and score metrics leave it out, and a calibration counts it in the `unknown` rate, as it does a skip.
_Avoid_: abstain, no verdict, indeterminate

**Judge identity**:
A hash of what decides a judge's verdict besides the trial: the judge's reference, its `version` (or its plugin's), its options as its schema parses them, the threshold and repetitions that turn its answers into a verdict, and its plugin's settings when it has some. Every score and pairwise preference records it, and `run.json` records it for each eval config judge, so two scores with the same identity came from a judge that grades the same way.
_Avoid_: judge hash, judge fingerprint, judge version (the version is one part of the identity)

**Jury**:
One judge run on several models, its members, each with the options it changes (usually `model`). Its verdict is the majority of the members that passed or failed, and a tie is `unknown`. Its judge identity is the set of its members' identities. The report gives the members' agreement as Krippendorff's α.
_Avoid_: ensemble, panel, committee, multi-judge

**Label**:
A person's answer to a judge's question: pass or fail for one trial, or, for a pairwise judge, the side they prefer for one case. It belongs to the question (the judge's name in results), not to a judge identity, so a changed judge is measured against the same labels. Its split says whether it measures a judge (`test`) or may be read while changing one (`dev`).
_Avoid_: annotation, ground truth, gold label, mark

**Calibration**:
What `mst judges check` measured for one judge identity against people's `test` labels: TPR and TNR with their intervals, kappa, the `unknown` rate, and whether the judge is usable. It applies only to that identity. An unversioned calibration is of a judge whose version MST can't see change, so it can't tell when it goes stale.
_Avoid_: accuracy, validation, judge score

**Usable**:
A judge whose calibration passes the gate: enough failing and passing labels with a verdict, TPR and TNR lower bounds at or above the minimum, and few enough `unknown` answers.
_Avoid_: calibrated (a judge is calibrated for a user's labels, not in general), trusted, valid

**Pairwise judge**:
A judge that compares two variants' trials of the same case and says which is better, instead of scoring one alone.
_Avoid_: comparator, preference model

**Agentic judge**:
A judge that runs an agent (on the `claude-agent` or `codex` runtime) over a workspace of the trial's evidence, which it can read and search before it scores, instead of getting the trial in one prompt. It can be pointwise or pairwise.
_Avoid_: agent grader, tool-using judge

**Staged judge**:
An agentic pairwise judge described as data, a bundle: the files it needs (prompts, helper scripts), programs that prepare the workspace, and a graph of agent stages whose answers later stages quote, ending in verdict stages. `stagedPairwiseJudge` runs one, so a judge maintained elsewhere as prompt files runs in MST without being reimplemented.
_Avoid_: composite judge, judge pipeline

**Preference**:
A pairwise judge's result comparing two variants on one case: which side's trials it prefers (or a tie), how strongly, and why. Several reps, and the swapped order, reconcile into one preference per case.
_Avoid_: verdict, vote

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
An aggregate over a run's trials or cases, such as pass rate (Anthropic's pass@1), pass^k, tool recall, tokens, cost or latency.
_Avoid_: KPI, stat

**Likely range**:
Where a pass rate's true value, the rate over unlimited trials, lies with 95% confidence. It shows how much a run measured, not how flaky the client is: 8 of 8 cases passing is likely 63.1–100%. A rate over several cases counts cases, not trials, as the sample. A range wider than ±10 points means too few trials to tell.
_Avoid_: margin of error, error bars

**Regrade**:
Grading a stored run's transcripts again with the eval config's graders as they are now (`mst grade`), without running the client. It is saved as a new run, `<run-id>.g2` and so on, whose `run.json` names the original in `gradedFrom`. Needs transcripts stored with `"redactStoredResponses": false`.
_Avoid_: rescore, re-run

### Writes

**Write case**:
A case whose `expected.writes` lists writes, or whose trials made one ([ADR 0014](docs/adr/0014-graders-check-outcomes-and-every-write-is-accounted-for.md)). Its scores say what they rest on (write evidence).
_Avoid_: action case, mutation case

**Write record**:
The writes the dry-run proxies in front of a trial's servers recorded during the trial, each with its server, tool, arguments, reply and write mode, matched against the trial's transcript. Stored with the trial as `writeRecord`; the `writes` grader reads it, never the transcript.
_Avoid_: write log, audit log

**Write mode**:
How a server in a variant handles a write, known before the run starts: `planned` or `simulated` (the dry-run proxy stops it), `server-planned` (the server stops it and marks it), `live` (it reaches the service), `unguarded` (MST can't see it, and the eval config accepts that) or `read-only` (the server listed no write tools when MST checked it; a trial that calls a tool it didn't list is a `setup` failure).
_Avoid_: write policy, dry-run mode

**Write evidence**:
What a score of a write rests on, weakest first: `claimed` (the answer says so), `called` (the transcript has the call), `requested` (a dry-run proxy recorded the request) or `applied` (an outcome check found the expected state; reserved). A planned or simulated write is at most `requested`: the request, not a write that happened.
_Avoid_: confidence, proof

**Unreported write**:
A write in the record with no matching call in the trial's transcript: the client made a write its transcript doesn't show. Fails the trial's `writes` grader.

**Unrecorded write**:
A write call in the transcript, to a server whose writes MST records, with no entry in the record: the call never reached the server. Fails the trial's `writes` grader.

**Unclassified call**:
A call the proxy forwarded and can't classify as a read or a write: a dispatcher's call, or a write tool's call, whose result has no planned-write mark. A write record with one gives at most `called` evidence.
_Avoid_: unknown write

**Outcome check**:
A grader that reads the environment through MST's own connection after a trial, to find the outcome. Planned (the `outcome` grader); until it ships, no write case reaches `applied`.
_Avoid_: state check, verification

### Runs and comparisons

**Run**:
One execution of an eval: every variant on every case, for the case's number of trials.
_Avoid_: experiment, suite run, execution

**Run ID**:
A run's name, from its start time and a random suffix (`20261006T091500Z-7f3c2a`), which is also its directory under the eval's `runs/`. The suffix alone (`7f3c2a`) is its short form; a regrade adds `.gN`.
_Avoid_: execution id, run number

**Phase**:
One of a run's two stages, collect and grade, each recorded in `run.json` as `complete`, `partial`, `skipped` or `failed`.
_Avoid_: stage, step

**Ending**:
How a client's attempt at a case ended, decided where it ended (by the client, the batch or the shard): a trial, which is graded as usual even when the client errored or ran out of turns, time or context; or an infrastructure failure. Collection decides it; grading never changes it.
_Avoid_: outcome (that is the environment's final state), status, result

**Infrastructure failure**:
An attempt that ended because something around the client broke (the desktop crashed or was leased, a machine couldn't be reached), not because of what the client did. MST must be able to name what broke, one of: the client app (the desktop or CLI program MST drives crashed, wasn't available, didn't take the prompt, or gave output MST couldn't read), the client's workspace (Cowork's VM), the network, the model provider's API, collection (MST couldn't collect the trial's result: its shard ended without it, or its artifacts couldn't be copied), an MST deadline, or setup (the eval, the case, a client setting or a permission). A client that ran out of its own turns, time or context failed the trial. An infrastructure failure isn't a trial: it is recorded with why, its case is incomplete, and `--resume` collects it again unless a retry can't help (a prompt the desktop truncates or the model's context can't hold, a client setting the eval can't run with). Those are reported as needing a fix to the eval, the case or the setup.
_Avoid_: error trial, flake

**Incomplete case**:
A case that is short a trial (an infrastructure failure, completed by `--resume`) or has a trial its judges couldn't grade (a grading error, completed by `mst grade --resume`). It is neither passed nor failed and is left out of pass rates until it is completed; per-trial measurements (tool calls, duration, usage) use the trials it has. A grading error isn't an infrastructure failure: the client's attempt ended fine.
_Avoid_: partial case, failed case

**Partial run**:
A run narrowed at run time (`--variant`, `--case`, `--filter-tag`, `--max-cases`, `--trials`). It's compared only with partial runs narrowed the same way, and never becomes a result store's latest run.
_Avoid_: subset run, filtered run

**Comparison**:
How a variant differs from the baseline, or a run from an earlier run: metric changes with confidence intervals, an assessment of each change (better, worse or unclear, from a paired test), and the cases that improved or regressed.
_Avoid_: diff, A/B result, verdict

**History**:
An eval's runs over time: a row per run with what it ran with and what each variant measured, in the eval's `history.json` (`mst.history/v1`), beside `latest.json` locally and in a result store. Derived from the runs and rebuildable from them; `mst history` prints it ([ADR 0012](docs/adr/0012-an-evals-history-is-derived-from-its-runs.md)).
_Avoid_: trend, timeline, dashboard, log

**Era**:
Consecutive full runs in an eval's history that measured the same way: the same datasets, the same eval config judges, the same plugin versions and settings, the same `simulateWrites`, and for one variant the same setup (servers as recorded, write modes, client options under the same option key, and the judge identity its scores recorded in each case, against the one the case last had in the era). A change starts a new era, with the reasons; runs on either side of an era's start are never compared. A new client app build doesn't start one.
_Avoid_: epoch, segment, baseline period

**Result store**:
Where an eval's runs are kept besides the local run directories: a `file` directory, a `gcs` bucket, or a plugin's store, chosen with `mst run --results` or the eval config's `results.store`. It gets a copy of each whole run directory, in the same layout, with a manifest written last, and is where the previous run comes from; `mst grade` and `--resume` fetch a run from it that isn't local. A plugin's store only moves bytes (a `RunStore`); MST owns the layout. Opening a stored run (`mst open --results`) is planned.
_Avoid_: results backend, sink

**Regression case**:
A case that works today, which a variant must keep passing. Declared with the `regression` tag; when no case has the tag, the cases that pass a separate grouping run of the baseline. Never chosen from the baseline run variants are compared with, which would build in regression to the mean.
_Avoid_: keep-working case, guard case

**Capability case**:
Any case that isn't a regression case: one a variant should improve on. Anthropic calls an eval of these a capability eval; MST keeps the split at case level, because one eval holds both. A capability case that passes reliably graduates by taking the `regression` tag.
_Avoid_: should-work case, target case

**Held-out case**:
A case tagged `held-out`, kept out of view while a variant was written, so its results show whether the variant generalizes.
_Avoid_: unseen case, test split

**Tool optimization**:
Tool-metadata variants, proposed up front or round by round, compared with the baseline, ending in a recommendation to apply one or none. On an eval it is stored: a record in the eval's `optimizations/<id>/` naming the runs that measured its baseline and each round, so it continues from any process (`mst optimize`, [ADR 0008](docs/adr/0008-a-tool-optimization-is-a-stored-experiment.md)). Its runs never become the eval's latest run.
_Avoid_: variant experiment, tool experiment

**Candidate**:
One tool-metadata variant an optimization tries: an id, the idea it tests, and the metadata it gives editable tools. It may change a tool's name, its description, and the description and title text in its input schema, nothing a call depends on, and is checked against the tools the servers serve before it runs.
_Avoid_: proposal (that is the recommendation), arm

**Round**:
The candidates an optimization runs together, in one run, after reading what earlier rounds showed.
_Avoid_: iteration, generation

**Variant budget**:
The most candidates an optimization runs across its rounds (`--max-variants`). It caps cost, and the significance test divides its threshold by the number tried, so more candidates also need stronger evidence.
_Avoid_: max candidates, cap

### Where a run happens

**Coordinator**:
The machine where `mst run` or `mst grade` was typed (your machine or a CI job). It loads, resolves, prepares, gathers, grades, compares and reports. Collecting can happen elsewhere, and with `mst grade --runner` so can running the graders: the coordinator still resolves what they grade with and writes the regrade ([ADR 0005](docs/adr/0005-grading-runs-in-an-environment.md)).
_Avoid_: controller, host, driver

**Runner**:
Where a run's trials are collected, chosen with `--runner`: `local` (in the `mst run` process, the default), `docker` (containers from MST's Linux Cowork or ChatGPT image), or a runner extension that creates machines, such as containers or VMs (`acme/runner/cloud-vm`). Never part of an eval config ([ADR 0004](docs/adr/0004-environments-run-shards-over-a-channel.md)). ADR 0004 and 0005 call it an environment; [ADR 0013](docs/adr/0013-mst-uses-anthropics-eval-vocabulary.md) renamed it, because Anthropic's environment is what the client acts on. The OS of the machine that runs a trial decides how a desktop client runs: Computer Use on macOS, the accessibility automation on Linux ([ADR 0011](docs/adr/0011-a-client-is-a-product-and-how-it-runs-is-not-configuration.md)); each shard's machine records its OS. At eval load, MST checks client OS requirements when the runner's OS is known: the executing machine for `local`, Linux for built-in `docker`, or a runner definition's optional `os: 'macos' | 'linux'`. The check includes case clients. An undeclared OS stays unknown; validation never opens a machine to discover it.
_Avoid_: environment (that is what the client acts on), sandbox, backend, target

**Shard**:
One machine's part of a run's trials, to collect, or to grade (a **grade shard**, `mst grade --runner`). Trials are split by case, so a case's variants and trials all run on one shard.
_Avoid_: partition, worker (for the slice)

**Worker**:
The process that runs a shard on its machine with the same code a local run uses: `mst collect` collects its trials, and `mst grade-shard` grades them.
_Avoid_: agent, guest, runner

**Channel**:
How the coordinator reaches a worker's machine: run a command with its input and output attached, and copy files in and out (`docker exec` and `docker cp`, or SSH and `scp`).
_Avoid_: transport (MCP's word), connection

**Runtime preparation**:
A plugin's in-process setup of a Docker desktop runtime through the worker channel, after private directories exist and before the desktop starts (`createDockerRunner`). It returns cleanup, which runs before keeping or removing the container during normal disposal and cooperative cancellation. Emergency process termination can skip the async hook. Plugin-managed inference disables MST's inference delivery and refresh; credentials and runtime formats stay plugin-owned. Grade and headless shards skip runtime preparation.
_Avoid_: login provider, credential extension

**Limits**:
The eval config's run-wide caps on trials running at once, per LLM provider and per server label, across every shard (`limits`). A worker waits for room before each trial.
_Avoid_: rate limit (that is the provider's), quota, concurrency

**Missing trial**:
A trial with no transcript after collect, because its shard failed: an infrastructure failure with nothing recorded but its absence. It isn't a failed trial: its case is incomplete, and `--resume` collects it.
_Avoid_: failed trial, skipped trial

### Tests

**Test**:
A direct check of a server, with no client: a Playwright test that calls tools or sends requests through MST's fixtures and checks the results with its matchers. Tests aren't evals and aren't graded.
_Avoid_: direct case, unit eval

### Extending MST

**Plugin**:
A plain object, the default export of a module or package, that contributes named extensions to MST under one namespace. A plugin is data that core reads; it does not call into core to register itself.
_Avoid_: register hook, extension module

**Namespace**:
The first part of a plugin extension's name, `<namespace>/<kind>/<name>` (for example `acme/judge/completeness`). Declared by the plugin's `meta.namespace`; `mst` is reserved for the built-ins.
_Avoid_: scope, prefix

**Extension**:
One named thing a plugin contributes, of one kind: a dataset source (`dataset`), client (`client`), judge (`judge`), pairwise judge (`pairwise-judge`), metric (`metric`), result store (`result-store`), connector (`connector`), runner (`runner`), credential store (`credential-store`) or shared config (`config`). Its name says its kind: `acme/judge/completeness` is a judge.
_Avoid_: contribution, registration, capability

**Built-in**:
An extension that ships with MST and is referenced by a bare name (for example `file` or `rubric`).
_Avoid_: core plugin, default

**Connector**:
An extension that describes one vendor MCP server as an organization uses it: its URL, how to sign in, and optionally how the client reaches it (such as through a dry-run proxy). An eval config names one in a server entry (`{ "connector": "acme/connector/slack" }`).
_Avoid_: integration, server definition

**Refresh grant**:
The long-lived sign-in `mst auth` saves for a connector, which a run exchanges for short-lived access tokens. Connectors with the same `grant` share one.
_Avoid_: credential, login, refresh token (that is part of it)

**Credential store**:
Where refresh grants are kept. MST ships `mst/credential-store/local`, files in `~/.mcp-server-tester/grants`; a plugin can provide others, chosen with `--store <namespace>/credential-store/<name>`.
_Avoid_: keychain, vault, secret store

**Dry-run proxy**:
A local proxy in front of a vendor MCP server that lets read tools through and answers writes without sending them: by default with a planned-write result, or with a success reply when the eval config sets `simulateWrites` (a **simulated write**). It records every write it stops in the trial's write record.
_Avoid_: mock server, write blocker, sandbox

**Shared config**:
A named, reusable fragment of an eval config that a plugin offers (for example `recommended`), which an eval opts into; a plugin cannot impose it.
_Avoid_: preset, profile

**Plugin settings**:
Values a plugin takes from the repo that runs evals rather than from one extension's options (for example a cloud project), written per plugin namespace in `mst.config.json` or an eval config's `settings`, and checked by the plugin's settings schema. Every extension of the plugin receives them as `settings`.
_Avoid_: plugin options, plugin config, factory options

**Model defaults**:
The model MST uses where nothing names one: for the `api` client by provider, for LLM and agentic judges, and for the Computer Use planner. Set in a `models` block in the user's and the repo's `mst.config.json`, the eval config and `--mst-config`, each entry overriding the one before it; MST's **built-in models** are the last resort, and a run warns about each one it uses and records it in `run.json` as `builtinModels` ([ADR 0015](docs/adr/0015-default-models-come-from-config-files.md)).
_Avoid_: default model config, model presets

**Endpoint source**:
(Planned.) An extension that supplies the base URL and credentials MST's own LLM calls use. A run uses exactly one; the built-in source reads environment variables.
_Avoid_: gateway config, LLM provider

**Marketplace plugin**:
A Claude or Codex plugin installed into a desktop client under test. Unrelated to an MST plugin.
_Avoid_: plugin (unqualified)
