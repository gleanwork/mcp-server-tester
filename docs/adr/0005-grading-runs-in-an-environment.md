---
status: accepted
---

# Grading runs in an environment

ADR 0004 moved collecting into environments, and kept grading on the coordinator: the explainer's step 7 says "Judge credentials stay on the coordinator. The VMs never need them," and ADR 0004 says a worker "never runs a judge". That holds while grading is cheap. It no longer is.

- An agentic pairwise judge reads both sides' traces and artifacts, and takes minutes per case. An eval of 100 cases and three variants has 200 comparisons (two candidates against the baseline), and 400 judge runs in both orders. At the default concurrency of 4, that takes several hours.
- All of that runs on the coordinator, usually a laptop. It sleeps, its disk fills (a regrade copies every trace and artifact), and a judge runtime such as Codex runs there too.
- Collecting already runs on machines built for long runs. Grading should be able to run on them too.

This record decides how `mst grade` runs in an environment. It amends ADR 0004 and the explainer's step 7 where they say judges run only on the coordinator.

## Decision

- **`mst grade <run> --env <name>` grades the run in an environment.** `--env-option` works as it does for `mst run`: `shards` (default 1, at most the environment's `maxShards`), `keep`, and the environment's own options. Without `--env`, `mst grade` grades on the coordinator, as it does today.
  - `mst run --env` keeps grading on the coordinator. Collecting and grading in an environment are separate choices. To do both, run `mst run --env … --no-grade`, then `mst grade --env …`.
- **A grade shard holds whole cases, split as collecting splits them:** `shardOf(caseId, N)`. A case's variants and trials go to one shard, so its pairwise comparisons have both sides on one machine.
- **Grading is the same code everywhere.** A grade worker runs the regrade code a local `mst grade` runs (`gradeTrial` for each trial's assertions and judges, `comparePairwise` for each case), on its shard's cases.
  - The worker records what grading produced: each trial's grading outcome and each case's pairwise preferences, with their usage.
  - The coordinator then runs the regrade, as a local `mst grade` does, with a grading source that reads those records instead of calling judges. The run directory, summary, comparisons, report, `latest.json` and the result store copy are written by the code that writes them for a local regrade, so they can't differ.
  - A trial or case whose shard didn't bring its grading back gets a grading error ("Missing: grade shard 2 ended before this case was graded"). The regrade is recorded as `phases.grade: partial`, and running `mst grade` again grades it, as for any trial a grader couldn't score.
  - `mst grade <regrade> --resume` grades only what has no verdict: it keeps each judge's and pairwise judge's verdict, sends shards only the cases with something to grade, and ships each shard its cases' earlier grading (in the bundled `results.json` and `summary.json`), so the worker runs only the judges without one. It refuses when the judges (or their identities) or the cases changed since that grading, and grades again a case judge's verdict whose judge changed. Without it, a regrade that lost one shard of 20 to a VM that didn't start could only be finished by running every judge again, agentic pairwise judges included, for a few cases.
- **The coordinator resolves; the worker only grades.** As for collecting, the coordinator loads the eval config, its plugins and its datasets, and resolves each case's judges, once. It ships the result to every shard, so every trial is graded with one resolved set of settings, as the explainer's step 7 requires.
  - The **grade bundle** (`kind: 'grade-bundle'`) holds the eval config, the shard's resolved cases (with `expected`, metadata and judges), the plugins and their package versions, and the stored run's files for the shard's cases: `run.json`, their traces, and their client artifacts.
  - The worker never resolves a dataset, so dataset plugins and their credentials (a GCS login, say) stay on the coordinator.
- **Judge credentials reach a grade worker as secrets do now.** The run's `--secrets-file` values go to the worker in the `tokens` message, over stdin, never in the bundle, argv or the image.
  - The worker keeps them in its process environment only, so a judge reads them there. It redacts them from any error or log line it sends back.
  - The coordinator's ambient environment isn't sent: a judge key must be in the secrets file.
  - This replaces "Judge credentials stay on the coordinator" for grade shards. A grade worker gets the judges' keys; a collect worker gets what it gets today.
- **The worker image provides what the judges need**: the judge plugins as packages, at the coordinator's versions (checked as for collecting), and any runtime a judge runs, such as the Codex CLI for an agentic judge. `hello` reports the image as for collecting. A version mismatch fails the shard before any judge runs.
- **`mst.shard/v1` gains a grade worker.** The coordinator starts the hidden command `mst grade-shard --bundle <dir> --results <dir>`, over the same channel. The worker's MST must be the coordinator's, so these additions stay in `mst.shard/v1`:
  - The worker writes `hello`, `need-tokens`, `heartbeat` and `done` as a collect worker does, and `graded` after each trial's grading and each case's comparison: its key (`trial`: variant, case and trial; `pairwise`: candidate and case), whether every grader gave a verdict (`graded` or `failed`), and its result file. Results are copied back after each `graded`, as after each `trial`.
  - `done` for a grade shard counts the `graded` and `failed` results.
  - The coordinator writes `tokens` and `cancel`. A cancel lets the case under way finish, and grades no more.
- **What a shard runs is part of the shard.** `ShardSpec` gains `work: 'collect' | 'grade'`. `runShardOverChannel`, and so every environment built with `machineEnvironment`, starts `mst collect` or `mst grade-shard` from it, with no change to the environment.
  - An opened environment says the work its shards can run (`Environment.work`, default `['collect']`), and `machineEnvironment` sets both. An environment that implements `runShard` itself, or wraps one, sets it. `mst grade --env` refuses an environment without `grade` right after it opens, before any shard runs.
  - Later kinds of shard work join the same field.
- **The grading's machines are recorded apart from collecting's.** A regrade's `run.json` keeps `environment` as a regrade records it today. A new `grading.environment` says where its grading ran: the environment's name, its options, the shard count, and each shard's machine.
- **A run in a result store is graded where it is.** With `--results` (or the eval config's `results.store`), `mst grade` fetches a run that isn't local from the store, checked against the manifest the upload writes last. The regrade is stored there too.

## Considered

- **Grade on the collect workers, as each case finishes.** It needs no second pass, but it breaks the reasons step 7 gives for grading separately. Settings would be resolved per machine and per hour, and nothing could regrade without collecting again.
- **Run a whole `mst grade` on one remote machine, over the channel.** This is `shards=1` of this design. Without the coordinator assembling, the run directory, comparisons and store copy would be written on the worker, by code paths a local regrade doesn't take.
- **Workers fetch the stored run from the result store themselves**, instead of the bundle carrying the shard's files. It saves copying traces over the channel, but each worker would need the store's credentials. This waits with ADR 0004's "workers write traces to a `gs://` store themselves".
- **Keep judge credentials on the coordinator, and have workers call back for each judge call.** Every judge request and response would cross the channel. Agentic judges, which run their own tools for minutes, couldn't work that way.

## Not decided here

- **Judge credentials that expire.** A worker gets the secrets file's values once, when its shard starts. A token that `MST_LLM_AUTH_COMMAND` makes on the coordinator for an LLM gateway lasts minutes, so it can expire during a long grade shard. Refreshing judge credentials over `need-tokens`, as connector tokens are refreshed, comes later. Until then, a grade shard needs a key that lasts as long as it does.
- **Judge SDKs in MST's image.** `mst env setup docker` installs the eval's plugins, not the SDKs MST's judges load when they run (`openai`, `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`), which are optional peer dependencies. Until setup installs them, an image of your own adds them (`npm install -g`), and the worker's judge preflight names a missing one.
- **Judges that read files outside their package.** A judge that loads prompts or scripts from a checkout on the coordinator can't run on a worker. Its plugin must ship them in its package.

- **Judge rate limits across shards.** Each shard grades `concurrency` cases at once, so a run makes up to `shards × concurrency` judge calls at a time. Holding judge calls to a cap per provider across shards, as `acquire` does for trials, comes later.
- **`mst run --grade-env`**: collecting and grading in one command, each in its environment.
- **Grading shards by trial** instead of by case, for runs with few cases and many trials.

## Consequences

- Grade worker images must include the judge plugins and their runtimes. MST's default Linux Cowork image doesn't include any judge runtime.
- Judge keys must be in the secrets file for `mst grade --env`. One that is only in the coordinator's environment fails the shard's judge preflight, before any case is graded.
- The public environment types change: `ShardSpec.work` (`ShardWork`), `Environment.work`, `ShardOutcome`'s `graded` and `failed`, the `graded` progress event (`GradeKey`), and the grade bundle. They can change between 2.0 prereleases.
- A local `mst grade` and `mst grade --env` write the same regrade, apart from `grading.environment` and judge timings.
