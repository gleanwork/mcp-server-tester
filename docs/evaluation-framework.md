# Evaluation framework contract

`mcp-server-tester` is the generic evaluation engine. Organization-specific
schemas, judges, clients, dataset loaders, and result destinations are plugins.
A developer should be able to run a complete evaluation with local datasets,
built-in clients and judges, and a local result store.

## Eval config

The editor-facing contract lives in
[`schema/eval-config.schema.json`](../schema/eval-config.schema.json), and
runtime validation is provided by `EvalConfigSchema`.

```json
{
  "name": "tool-selection-search",
  "datasets": [
    {
      "type": "file",
      "path": "evalsets/search.json"
    }
  ],
  "servers": {
    "prod": {
      "transport": "http",
      "serverUrl": "https://example.com/mcp"
    },
    "variant": {
      "transport": "http",
      "serverUrl": "https://example.com/mcp-v2"
    }
  },
  "client": "api",
  "clientOptions": {
    "provider": "anthropic"
  },
  "metrics": ["passed", "tool_count"],
  "results": {
    "store": {
      "type": "file",
      "dir": "./shared-results"
    }
  },
  "variants": [
    { "name": "baseline", "servers": ["prod"] },
    { "name": "variant", "servers": ["variant"] }
  ]
}
```

A key the schema doesn't define is an error, in an eval config and in a dataset, so a misspelling fails instead of being ignored. So is a setting the selected client can't honour, such as `tools` (tool metadata) for a client that doesn't present tool variants. `--dry-run` reports all of these, including in datasets.

- **Run controls** (`trials`, `maxCases`, `concurrency`, `filterTags`, `passThreshold`) go at the top level or under `run`.
- **Run-wide limits** (`limits`) cap how many trials run at once across a runner's shards, per LLM provider (from each trial's model: `anthropic`, `openai`, ...) and per server label: `"limits": { "providers": { "anthropic": 3 }, "servers": { "slack": 2 } }`. A worker waits for room before each trial, and its trial gives the room back when it finishes. Shared configs can set them, so an organization's rate limits live in its plugin.
- **Client defaults:** `model`, `provider`, `maxToolCalls`, `timeout`, `temperature` and `maxTokens` default each client option of that name, for the clients that take it.
- **The client:** `client` names the client under test, `model` the model it uses, and `clientOptions` the client's other options. A variant or case may set any of the three; it inherits the eval config's `clientOptions` only when it uses the same client.

A bare dataset path is shorthand for `{ "type": "file", "path": "..." }`; a bare `namespace/dataset/name` is a [plugin's dataset](#plugin-datasets-and-snapshots). Relative dataset and plugin paths in an eval config resolve against the eval config's directory, then `rootDir` (`--root-dir`, the working directory by default). A `file` result store's `dir` is always relative to the eval config, so where results are written doesn't depend on the working directory. Plugin result stores resolve their own options.
Every other pluggable block is a tagged object. `servers` is the MCP servers under test, a map keyed by label (`"servers": { "acme": { "transport": "http", ... } }`); an entry doesn't set `label`, because the key is its label. A variant picks servers by label (`"servers": ["acme"]`): one that lists none uses every server, and `[]` uses none. An empty map is valid for clients that provide their own capabilities. When the eval config and a shared config it extends both set `servers`, the eval config's map replaces the shared config's whole, like every key; a variant may name a shared config's servers when the eval config sets none.

For Cowork, `clientOptions.mode: "first-party"` uses this same server map and
variant selection to select **existing authenticated account connectors**. Each
HTTP `serverUrl` must uniquely match a connected Claude account endpoint; MST
applies account-wide tool permissions instead of installing a developer server.
Only plain HTTPS URL declarations are supported in this mode, with sequential
local macOS runs. See [first-party Cowork](cowork.md#cloud-sessions) for permission
policies, restoration, and unsupported transport settings. The default Cowork
mode remains the MST-managed third-party profile.

## Plugins

Dataset sources, clients, judges, metrics and result stores are extensions. Each one owns its tagged-config schema; core doesn't know organization-specific options. ADR [0001](adr/0001-eslint-style-declarative-plugins.md) records why plugins take this shape.

A plugin is a plain object, the default export of its module or package, in the shape [ESLint plugins](https://eslint.org/docs/latest/extend/plugins) use. MST reads it; a plugin never calls into MST to register.

```ts
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const plugin: Plugin = {
  meta: { name: '@acme/mst-plugin', version: '1.0.0', namespace: 'acme' },
  // The repo's values, from mst.config.json (see Settings below).
  settings: { schema: z.object({ project: z.string() }).strict() },
  datasetSources: {
    legacy: { schema: LegacySchema, load: loadLegacyDataset },
  },
  judges: {
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async ({ case: c, trial }, options, { settings } = {}) => ({
        score: 1,
      }),
    },
  },
  // Also: clients, metrics, resultStores, connectors, runners, credentialStores.
  configs: {
    recommended: {
      judges: ['acme/judge/completeness'],
      trials: 3,
    },
  },
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Eval configs and datasets reference it as `<namespace>/<kind>/<name>`, such as `{ "type": "acme/dataset/legacy" }` or a case's `"judges": ["acme/judge/completeness"]`. The kind is `dataset`, `client`, `judge`, `pairwise-judge`, `metric`, `result-store`, `connector`, `env`, `credential-store` or `config`, and it must match where the name is used: `acme/judge/x` in `datasets` is an error. Built-ins (`file`, `claude-code`, `rubric`, `passed`, ...) use bare names, or the full `mst/<kind>/<name>` (`mst/judge/rubric`); the `mst` namespace is reserved.
- **Namespace.** `meta.namespace` is required: lowercase, optionally scoped as `@scope/name`. Two different plugins can't share a namespace. Loading the same plugin again is a no-op, including a rebuilt object with the same name, version, extension definitions, configs and settings schema. A plugin factory that builds differently configured copies needs a namespace per copy; a plugin that needs repo-wide values takes them as [settings](#plugins) instead. A package's CommonJS and ESM builds are different objects too, so load a plugin one way; publishing plugins as ESM avoids the question.
- **Loading.** An eval config lists plugin specifiers in `plugins`. Each one resolves relative to the eval config's directory, then `rootDir` (`--root-dir`, the working directory by default), then as a package name, resolved as `import` resolves it. `--plugins` and the `pluginPaths` / `plugins` options of `runEval` and `runEvalBatch` add to that list. Code that runs datasets directly passes plugin objects: `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `test.use({ mcpPlugins: [plugin] })` in Playwright. Code that calls validators or matchers on its own installs them with `installPlugins([plugin])`.
- **Scope.** An eval config may only reference namespaces of plugins it loads, even if another eval in the same process (a batch) loaded more. The same check applies to the clients and judges its datasets name. `runEvalDataset`, `runEvalCase` and the fixtures have no eval config, so they resolve against every plugin installed in the process.
- **Contracts.** Each extension has a Zod `schema` for its options and the functions its kind needs: `load` (dataset sources), `run`, `open`, or both (clients), `evaluate` (judges), `kind` and `compute` (metrics), `create` (result stores, returning a [`RunStore`](#result-stores)), `open` (runners, with an optional positive `maxShards` and an optional `coordinator`, which creates the machine a detached run's coordinator runs on; see [Detached runs](./cli.md#runs---detached-runs)), and `create` (credential stores, returning a `CredentialStore`; they take no options, so no `schema`). MST validates the plugin when it loads, and names the plugin and extension in any error.
- **Runners.** `runners` declares where a run's trials can be collected, used as `mst run --runner acme/runner/cloud-vm` ([ADR 0004](./adr/0004-environments-run-shards-over-a-channel.md); [ADR 0013](./adr/0013-mst-uses-anthropics-eval-vocabulary.md) renamed environments to runners). A runner's `schema` checks its `--runner-option`s, which arrive as strings, except `shards` and `keep`, which MST owns. In a plugin runner, MST first collects every variant's trials on `shards` machines, splitting cases by `hash(caseId) mod shards` so that a case's variants and trials share one machine. It saves each trial as it comes back, then grades them all on this machine as it grades a batch's. A trial whose shard ended without it is **missing** (`failureKind: 'missing'`): its case is incomplete, so it is left out of `total`, `passed`, `failed` and the pass rate, and counted in `incomplete`. The run is `collect: partial` and doesn't become `latest.json`. Ctrl-C stops the shards and keeps what came back; a second Ctrl-C quits. Workers get the `--secrets-file` values (not this machine's environment) and resolve their servers' secrets themselves. A connector server goes to a worker as its declaration: the worker's plugin launches it with the worker's paths, and the worker asks this machine for the server's access token when it starts and again before the token expires, so refresh grants stay here. A variant's tool metadata is served by a proxy on the worker. `mst run --resume <run-id>` (`resumeRun`) completes such a run: it collects only the missing trials in the same runner, along with any trials the client never submitted (`failureKind: 'not-submitted'`, such as a batch blocked after a failed reset), grades every trial again (the others from their stored transcripts, so the run must store them with `"redactStoredResponses": false`), and writes the run into its own directory, which becomes `latest.json` once nothing is missing. `run.json`'s `runner` records the runner's name, shards, and any `keep` or options, so options must not hold secrets.

  A runner definition can declare `os: 'macos' | 'linux'` when every machine that collects trials has that OS. MST checks each client's `requirements.os` against it when loading the eval, including variant and case clients. `local` uses the executing machine's OS; built-in `docker` declares Linux, even when started from macOS. Omit `os` when unknown or mixed. MST does not guess the OS or open a machine during validation. This metadata does not select a desktop implementation or fill in per-OS option defaults.

  Most runners only create machines. `machineRunner` (from `./evals`) builds the rest: it copies the shard's bundle to the machine, starts the hidden `mst collect` there, answers the worker's `mst.shard/v1` messages (tokens, progress, heartbeats, cancel), copies the results back after each trial, and deletes the machine when the shard ends, or keeps it as `keep` says:

  ```ts
  import { machineRunner } from '@gleanwork/mcp-server-tester/evals';

  const docker: RunnerDefinition = {
    os: 'linux',
    schema: z.object({ image: z.string() }).strict(),
    maxShards: 8,
    async open({ image }, context) {
      return machineRunner(context, async (shard) => {
        const id = await startContainer(String(image), shard.index);
        return {
          id,
          channel: dockerChannel(id), // exec: `docker exec -i`; put and get: `docker cp`
          dispose: async ({ keep }) => {
            if (!keep) await removeContainer(id);
          },
        };
      });
    },
  };
  ```

  A runner whose machines are Docker hosts, such as cloud VMs, can leave the containers to the built-in `docker` runner, `dockerRunner` (from `./evals`):
  - **`setup`** creates one host and a Docker context for it, and calls `dockerRunner.setup!({ contexts: '<context>', image }, { log, plugins })` with the `plugins` its own `setup` was given. (`setup` is optional on `RunnerDefinition`, hence the `!`.) It then saves that host as the image new hosts boot from. `dockerRunner.open` checks that each context already has the image, and never builds or pulls it, so a host without the image fails every shard.
  - **`open`** returns a runner with `work: ['collect', 'grade']`. Its `runShard` passes both kinds of shard on, and without `work` it would run collect shards only, so `mst grade --runner` would refuse it.
  - **`runShard`** creates a host for the shard and a Docker context for it. It opens `dockerRunner` with that context only and runs the shard on it, in a `try`. The docker runner limits each container to the host's memory (`docker info`): a Cowork container to all the host can spare, a grade container to 2 GiB. Pass `memory` (and `cpus`) on to `dockerRunner.open` to change that, for example when a grade shard runs agentic judges side by side. The docker runner reports a shard's failures (a bundle it couldn't copy, a worker it couldn't start, a silent worker) in the shard's result (its `ShardOutcome`), not as a throw; the `try` is for your own host management (opening the docker runner, the host API). A throw from it counts as a result that isn't `ok`. In the `finally` it closes the docker runner, then deletes the host and its context, unless `context.keep` keeps them: `'always'`, or `'failed'` when the result isn't `ok`. Catch a host or context deletion that fails there and add it to the result (`note` on a good shard, `reason` on a failed one), as MST's own machine runners do: a `runShard` that rejects after a good shard turns its collected trials into a failed shard. The docker runner keeps the container by the same rule, and prints a `docker --context <context> exec` command that works only while the host and its context exist.
  - **`close`** deletes the hosts and contexts of shards that are still running.

  A worker machine needs the same MST version as the coordinator (a mismatch fails the shard at `hello`), on `PATH` as `mst`, and the client's plugin. Access tokens reach it only over stdin; the worker writes them to `MST_TOKENS_DIR` (default `/run/mst/tokens`, which a worker image should mount as tmpfs), one file per server label, renews them before they expire, and removes them at the end. `MST_IMAGE` names the image in the worker's `hello`. A shard's failures (no machine, a bundle the channel couldn't stage, a worker it couldn't start, a silent or cancelled worker, a machine it couldn't delete afterwards) are in its result; `runShard` doesn't throw for them. A `machineRunner` machine that couldn't be deleted after a good shard is a `note`, not a failure. A runner that throws from `runShard` anyway fails only its own shard (`Shard N failed: …`): the run's other shards finish and keep what they collected.

- **Shared configs.** `configs` holds named eval config settings an eval can opt into. An eval that loads the plugin applies one with `"extends": ["acme/config/recommended"]`:

  ```json
  {
    "name": "acme-eval",
    "plugins": ["@acme/mst-plugin"],
    "extends": ["acme/config/recommended"],
    "datasets": ["./cases.json"],
    "trials": 5
  }
  ```

  A config is typed `PluginConfig` and can set any documented eval config key except `name`, `datasets`, `variants`, `baseline`, `plugins`, `extends`, `run` and `filterTags`. That includes `redactStoredResponses` and `simulateWrites`, so one config can keep full transcripts (for `--no-grade`, `mst grade` and `--resume`) for every eval that extends it. Other keys are rejected when an eval config extends the config; until then MST only checks that it's an object. Configs apply in order, then the eval config's own settings, including its `run` controls. Each top-level key is replaced, never merged: here the eval config's `trials` replaces the config's, and an eval config `judges` list would replace the config's list rather than add to it. A config may use only its own plugin's extensions and built-ins, and can't extend other configs. MST has no built-in configs. An eval's `contentHash` is computed with its configs applied, so `runEvalBatch` doesn't resume a saved run after a config changes. Code that validates an eval config itself applies `extends` first with `resolveConfigExtends` (from `./evals`).

- **Settings.** `settings: { schema }` declares values the plugin takes from the repo that runs evals, not from one extension's options: a cloud project, an internal endpoint ([ADR 0008](./adr/0008-plugin-settings.md)). The repo writes them in `mst.config.json`, one section per plugin namespace, and an eval config may set `settings` too, whose section replaces the file's for that namespace, whole:

  ```json
  { "settings": { "acme": { "project": "acme-evals" } } }
  ```

  MST reads the nearest `mst.config.json` at or above the eval config's directory, up to the repository root (the directory holding `.git`); `mst datasets`, `mst judges` and `mst runner setup` without `--config` read the one at or above `--root-dir`. Once the eval's plugins load, MST keeps the sections of those plugins, drops the rest, and parses each plugin's section with its schema (`{}` when it has none), so a missing or wrong setting fails before the run starts. A section for a plugin that takes no settings is an error. Every extension of the plugin gets the parsed section as `settings`: in its context (dataset source `load` and `describe`, client `run` and `open`, runner `open`, `setup` and `coordinator`, connector `launch`), or as an optional last argument (judge `evaluate` and `preflight`, pairwise judge `compare` and `preflight`, metric `compute` and `aggregate`, result store and credential store `create`, connector `auth.token` and `auth.client`). It's undefined for built-ins and plugins without settings. The settings are part of the resolved eval config, so they go with it to workers, grade shards and a detached coordinator, and an eval's `contentHash` changes when they do. They are JSON values: a path in them means nothing on another machine, so files an extension reads still ship in its package.

- **Judges.** A judge's `evaluate({ case, trial }, options)` returns a score: `score` from 0 to 1 ([Judge contract](#judge-contract)). MST parses `options` with the judge's schema, calls `evaluate` once per `reps`, and compares the mean score with the judge entry's `threshold`. The schema sees only the judge's own options, never `threshold`, `reference`, `reps` or an eval config entry's `type` and `name`. The built-in `rubric` judge has the same contract, and an eval config can list it: `judges: [{ "type": "rubric", "rubric": "correctness" }]`. An optional `description` (on judges and pairwise judges) is what [`mst judges`](cli.md#judges---find-judges) shows, with `requires` and the options schema.

Plugins load before eval config validation, so validation can check every reference and schema.

### Judge contract

A judge is called as `evaluate({ case, trial }, options)`, once per `reps`:

- `case` (`JudgeCase`) is the case as written in the dataset, the same for every run:
  `id`, `input` (`prompt`), `expected`, `tags`, `metadata`.
- `trial` (`JudgeTrial`) is one observed run: `response` (what validators grade),
  `text`, `events` (tool calls and other client events), `messages` (when the client
  reports them), `evidence`, and client `usage`.
- `options` is the judge's own settings, parsed by its `schema`.

The threshold is not in the input. MST compares the mean score with it,
unless the judge returns its own `pass`; over several reps, the majority of
those decides, and a tie fails.

A judge that can't score (it throws, its SDK isn't installed, its endpoint
rejects the call, or it returns an invalid score) gives no verdict. Unless
another grader already failed the trial (every grader must pass, so that fail
stands), the trial is **not graded**: its `error` says
`Not graded: <grader>: <error>`, its trial record has `gradingError`, it's left
out of the trial pass rate and judge metrics, its case is incomplete (neither
passed nor failed), and the run's `run.json` says `grade: partial`. It isn't an
infrastructure failure: the client's attempt ended fine, and
`mst grade --resume` grades it. Its other graders' scores, and the
judge's error, are still stored under `scores/`. When another grader did
fail the trial, the case is a fail, but the judge still has no verdict: the
run is `grade: partial` all the same, and `--resume` runs that judge. The
same goes for a pairwise judge that gave no preference. `grade: complete`
means exactly that a resume would have nothing to grade.

`case.expected` holds the case's ground truth:

- `answer`: the assertion's `reference`, else the case's `expected.answer`,
  else its `expected.answer`.
- `criteria`: rubric criteria keyed by name, from the case's `expected.criteria`.
- Any other key a dataset puts under `expected`.

Put data in `case.expected` when any judge could grade against it. Put it in
`options` when it only changes how one judge grades.

A judge can declare the inputs it needs:

```ts
judges: {
  criteria: {
    schema: z.object({}).passthrough(),
    requires: ['case.expected.criteria'],
    evaluate: async ({ case: c, trial }) => gradeCriteria(c.expected.criteria!, trial.text),
  },
}
```

When a required path is missing or empty, MST does not call the judge and
records it as skipped.

A judge can also check that it can run at all, such as that its SDK is
installed and its credential is set. `preflight(options)` runs once per
judge setting, before `mst run` starts a variant's client and before
`mst grade` writes anything, so a missing key fails the run instead of every
trial. It must not call a model. `mst run --no-grade` doesn't call it. The
built-in `rubric` judge checks its provider's package and credential.

```ts
judges: {
  graded: {
    schema: z.object({}).strict(),
    preflight: async () => {
      if (!process.env.ACME_JUDGE_KEY) throw new Error('Set ACME_JUDGE_KEY.');
    },
    evaluate: async ({ trial }) => grade(trial.text),
  },
}
```

A judge returns a `JudgeScore`. Only `score` (0 to 1) is required:

| Field               | Effect                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`              | The judge's own pass/fail. Without it, the case passes when the mean score meets the threshold.                                                                                                             |
| `skipped`           | The judge cannot grade this case. It doesn't count for pass/fail or judge metrics; the remaining reps don't run. Its `reasoning`, `usage` and `metadata` are recorded, its `score` is not.                  |
| `unknown`           | The judge read the trial, and the transcript can't support a verdict. Unlike a skip, the trial doesn't pass. The judge's pass rate and score metrics leave the trial out, and `mst judges check` counts it. |
| `subScores`         | Named sub-scores, such as one per criterion: `{ [key]: { score, pass?, reasoning? } }`.                                                                                                                     |
| `criteria`          | Criteria a person labels one at a time: `[{ id, text?, required?, verdict, reasoning? }]`, `verdict` `pass`, `fail` or `unknown`. See below.                                                                |
| `usage`             | The judge's own token usage and cost, summed over reps.                                                                                                                                                     |
| `provider`, `model` | Reported as `judgeProvider` and `judgeModel`.                                                                                                                                                               |
| `metadata`          | Other JSON output, kept in the result.                                                                                                                                                                      |

A judge that checks several criteria, each a question a person can answer
on its own, lists their verdicts in `criteria`. Each criterion is then its own
label question, `<judge>#<id>`: `mst label`, `mst label export` and
`mst judges check` take it as `--judge`, and the report's _Judges_ table has a
row for each, with its pass rate, in place of the judge's. Over several reps,
each criterion's majority wins, and a tie is `unknown`.

When at least one criterion is required (any without `required: false`), the
criteria decide the judge, in place of its own `pass`, `unknown` and score,
and of the threshold: it fails when a required criterion fails, is `unknown`
when none fails and one is `unknown`, and passes otherwise. Its score is the
share of required criteria that passed, and its reasoning and each
criterion's sub-score are the criteria's (a criterion that came out
`unknown` has no sub-score). When none is required, the judge's own verdict decides, as
for any judge. A judge that skips keeps the criteria its reps listed, each
`unknown`. A criterion's `id` can't have a `#`.

A criterion's identity
is the judge's unless the judge sets `criterionOptions(options, id)`: the
options, before `schema` parses them, that decide that criterion alone. Its
identity then hashes those in place of the judge's options, so the same
criterion in several cases shares one calibration. The built-in `criteria`
judge keeps only that criterion of its list.

A score or sub-score outside 0 to 1 is an error, not a result. When every
judge of a case skips, the judge assertion passes. Over several reps, a rep
that answers `unknown` is left out, and the reps that answered decide; the
judge is `unknown` only when every rep is (unless required criteria decide
it, as above). The report shows an unknown
answer as UNKNOWN, and its _Judges_ table counts them.

#### Juries

A judge entry's `jury` runs the judge on several models and takes their
majority
([ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md)).
Each member is the options it changes, merged over the entry's own:

```json
{
  "type": "task-completion",
  "jury": [
    { "model": "claude-sonnet-4-6" },
    { "provider": "openai", "model": "gpt-5-mini" },
    { "provider": "google", "model": "gemini-2.5-flash" }
  ]
}
```

Each member runs as its own judge, with the entry's `threshold` and
`reps`, and validation checks each member's options. The verdict is the
majority of the members that passed or failed. A tie is `unknown`, a member
that answered `unknown` or skipped is left out, and the jury skips only
when every member does. A member that fails to run fails the score, naming
the member. A jury's score is the mean of those members' scores, and its
`criteria`, for the `criteria` judge, each take the members' majority; a
criterion is optional only when every member that lists it says so. A
criterion's identity is the set of every member's identity for it, so a
member that skips a trial doesn't change it.

The score records each member's verdict in `jury`, and its `judgeModel`
lists the members' models. Its identity is a hash of the set of its
members' identities, so the order of the members doesn't change it, and two
members can't be the same judge. The report's _Judges_ table shows each
member's pass and fail counts and their agreement, Krippendorff's α over
the trials (1 is full agreement, 0 is chance; absent when there is no
variation to measure). A trial's scores show each member's verdict.

The run output names each judge's models, and warns when a judge model is
from the same family as the client's model, since a model tends to rate
its own family's answers higher. The report's _Judges_ table marks those
judges _same family as client_. Pairwise judges don't take `jury`.

Judge usage is kept apart from client usage: `judgeUsage` on each case and
trial, `totalJudgeUsage` on the run and eval telemetry, and the
`judge_cost_usd`, `judge_input_tokens`, and `judge_output_tokens` metrics.
The built-in `rubric` judge reports its usage the same way. It reads the
last `{pass, score, reasoning}` object in the model's answer, so reasoning
before the JSON is fine; an answer cut off at `maxTokens` (default 4096)
fails saying so.

#### Judge identity

Every score and pairwise preference records the identity of the judge that
gave it, in `judgeIdentity`. `run.json` records the identity of each eval
config, variant and pairwise judge, in `judges[].identity`. The identity is
a SHA-256 of the judge's reference, its `version`, its options as its
schema parses them (so an option left to its default hashes the same as the
value written out), how its answers become a verdict (a judge's
`threshold` and `reps`, a pairwise judge's `reps`), and its plugin's
settings from the eval's `settings` or `mst.config.json`, which the judge
receives as `settings` and can grade by. Settings count only when the
plugin has some, so a judge whose plugin takes none has the identity it
had before settings counted. Two scores with the same identity came from a
judge that grades the same way, which a calibration needs
([ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md)).

A judge or pairwise judge can declare a `version`: a non-empty string that
changes whenever it could grade differently with the same options, such as
a new prompt or a new default model. Without one, the identity uses the
plugin's `meta.version`, so every new plugin version counts as a new judge.
`agenticJudge` and `agenticPairwiseJudge` take `version` from their spec,
and a staged judge uses its bundle's `version` or the bundle's hash. The
built-in `rubric` judge's version covers its prompts, every built-in
rubric's text and the defaults it falls back on.

`mst grade --resume` refuses a run whose eval config or pairwise judges'
identities changed since it was graded. A case's own judges aren't in
`run.json`, so each verdict's identity decides: a trial with a verdict
whose judge changed is graded again, on a shard with `--runner`. A run
graded before MST recorded identities resumes as before.

### Pairwise judges

A pairwise judge compares two runs of the same case, a baseline and a
candidate, and says which is better. MST has one built in,
[`preference`](#the-preference-pairwise-judge). It is a separate extension kind,
`pairwiseJudges`, because a preference is not a score against a threshold:
pointwise judges decide whether a case passes, pairwise judges decide which
variant did better.

```ts
const plugin = {
  meta: { name: 'my-judges', namespace: 'mine' },
  pairwiseJudges: {
    overall: {
      schema: z.object({}).strict(),
      requires: ['case.expected.answer'], // optional; missing -> skipped
      compare: async ({ case: c, baseline, candidate }, options) => ({
        preference: 'candidate', // 'baseline' | 'candidate' | 'tie'
        strength: 0.6, // optional, 0..1
        dimensions: { correctness: { preference: 'tie' } }, // optional
        usage,
        model,
        version, // optional
      }),
    },
  },
};
```

`baseline` and `candidate` are `JudgeTrial`s, so a judge reads text, client
events (tool calls and their output), and evidence the same way a pointwise
judge does.

`comparePairwise({ baseline, candidate, judges, cases? })` runs the listed
judges on every case both runs have, matched by id. The runs can be two variants
of one eval, a run and a stored baseline, or runs made on separate machines.
Pass `cases` (dataset cases by id) when judges need ground truth that results
do not carry.

- Each judge runs each case in both orders, and the swapped preference is mapped
  back, to cancel position bias. A preference whose two orders disagree is
  reported with `consistent: false`. A judge that debiases itself sets
  `swapPositions: false`.
- `reps` repeats each order; the majority preference wins, ties break to tie.
- A skipped comparison or a judge error is recorded on the case, not counted
  as a preference.
- The summary reports, per judge, wins, losses, ties, `candidateWinRate`
  (wins plus half the ties, over compared cases), order `consistency`,
  per-dimension win rates, and judge usage.

### Agentic judges

An agentic judge doesn't get the trial in one prompt. It runs an agent over a
workspace of the trial's evidence, so it can read every tool output in full,
search the transcript, and run helper programs before it answers. `agenticJudge`
makes a pointwise judge and `agenticPairwiseJudge` a pairwise one; both are
registered like any other judge.

```ts
import { agenticJudge } from '@gleanwork/mcp-server-tester/evals';

const plugin = {
  meta: { name: 'my-judges', namespace: 'mine' },
  judges: {
    grounded: agenticJudge({
      requires: ['case.expected.answer'],
      defaults: { effort: 'medium', maxTurns: 10 },
      // Added to the workspace next to case.json, response.md and transcript/.
      files: ({ trial }) => [{ path: 'scripts/digest.py', content: DIGEST_PY }],
      // Programs the agent may run from the workspace.
      commands: [
        {
          name: 'digest',
          description: 'Summarize the transcript',
          argv: ['python3', 'scripts/digest.py'],
        },
      ],
      buildPrompt: ({ case: c }) => ({
        system: GRADER_INSTRUCTIONS,
        prompt: `Grade response.md against case.json expected.answer: ${c.input.prompt}`,
      }),
      outputSchema: {
        type: 'object',
        required: ['score', 'reasoning'],
        properties: {
          score: { type: 'number' },
          reasoning: { type: 'string' },
        },
      },
      parseScore: ({ json }) => {
        const { score, reasoning } = json as {
          score: number;
          reasoning: string;
        };
        return { score: score / 10, reasoning };
      },
    }),
  },
};
```

The workspace holds `case.json`, `response.md`, `transcript/events.json` (every
client event with its full output), `transcript/messages.json` when the client
reports turns, `artifacts/` when the client kept its own record of the
trial, and the plugin's `files`. A pairwise workspace has `case.json` and one
such tree per trial: `a/` is the baseline, `b/` the candidate
(`agenticPairwiseJudge` takes `parsePreference`).

`artifacts/` is a copy of the trial's stored client artifacts (see
[Client artifacts](#client-artifacts)). For Cowork, that's the session the
agent worked in: `audit.jsonl`, the files it wrote (`outputs/`), its
transcripts and the tool output it saved to files. They are stored with the
run, so `mst grade` gives a regraded trial the same workspace: a judge can read
and run its helpers over what the agent did without running the client again.
`trial.artifactsDir` points to the stored copy, for a judge whose `files` stage
it differently.

The runtime is an option, so the same judge runs on either agent SDK. The
default is `claude-agent`, the one that keeps the judge to the workspace;
choose `codex` only where its reach is acceptable (see below):

```json
{
  "type": "mine/judge/grounded",
  "runtime": "codex",
  "model": "gpt-5.5"
}
```

| Option          | Effect                                                      |
| --------------- | ----------------------------------------------------------- |
| `runtime`       | `claude-agent` (default) or `codex` (`@openai/codex-sdk`).  |
| `model`         | The judge model.                                            |
| `effort`        | Reasoning effort, where the runtime supports it.            |
| `maxTurns`      | Agent turn limit (Claude). Codex is bounded by `timeoutMs`. |
| `maxBudgetUsd`  | Spend limit, where the runtime enforces one (Claude).       |
| `timeoutMs`     | Wall-clock limit per judge call. Default 15 minutes.        |
| `keepWorkspace` | Keep the workspace and record its path, for debugging.      |

What each runtime can reach:

- **Claude** (`claude-agent`, the default) gets only `Read`, `Grep` and
  `Glob`, and a permission check denies any path outside the workspace,
  symlinks included. It has no shell; each command is a tool that runs the
  program with the agent's arguments, without a shell. That process is not
  OS-sandboxed, so commands must be read-only helpers.
- **Codex** runs in its `read-only` OS sandbox: it can't write files or reach
  the network, and web search is off. It is **not** confined to the
  workspace: read-only means its shell can read any file the user running MST
  can, by absolute path. Use it only on a machine where that is acceptable,
  such as a CI runner with nothing else on it. In a container its sandbox
  can't start (bubblewrap needs user namespaces), so every command fails; an
  image that is the judge's sandbox sets `MST_JUDGE_SANDBOX=container`, and
  Codex then runs unsandboxed inside it (MST's Linux Cowork image does, for
  `mst grade --runner`).
- **A Codex judge's preflight checks its sandbox.** It runs `codex sandbox`
  on a file it wrote in a temporary directory, with no model call, and fails
  unless the sandboxed command prints the file. A sandbox that can't start for
  any reason (no user namespaces, a seccomp or AppArmor profile, a missing
  helper) then stops `mst run` or `mst grade` before any judgment, with the
  sandbox's own error. Without the check, the judge's commands fail, the
  model answers anyway, and its guess (a tie, in practice) counts as a
  verdict. With `MST_JUDGE_SANDBOX=container` there is no Codex sandbox to
  check.
- Each run starts with a fresh, empty config home (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`) and loads no user settings, rules, memory or MCP servers. The
  agent's environment is an allowlist: `PATH`, `TMPDIR`, `LANG` and the
  runtime's credential. Codex's `HOME` is its empty config home; Claude gets
  the caller's `HOME`, which an organization's credential helper may need.
- Organization-managed policy that the agent CLI reads from system locations
  still applies, and wins over MST's settings. A managed Claude Code gateway,
  for example, replaces the endpoint and credential MST resolved, and may
  need its own model alias (`"model": "sonnet"`).
- The workspace is private (mode 0700) and removed after the judge answers. File
  paths that would leave it are errors.

The score's (or preference's) `usage`, `provider` (the runtime) and `model` come from the
agent run. `metadata.agent` records the runtime, turns, and each tool call's
tool and whether it failed, never its input or output. A run that redacts
stored responses drops judges' `metadata` altogether.

Credentials resolve as for every LLM call in MST (`resolveLLMEndpoint`):
Claude uses `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` with
`ANTHROPIC_AUTH_TOKEN` or `MST_LLM_AUTH_COMMAND` for a gateway; Codex uses
`OPENAI_API_KEY`, or `OPENAI_BASE_URL` with `MST_LLM_AUTH_COMMAND`. The agent
gets only the credential MST resolved. Claude needs
`@anthropic-ai/claude-agent-sdk` and Codex `@openai/codex-sdk`, optional peer
dependencies loaded only when the judge runs. An agentic judge's preflight
(pointwise or pairwise) checks the SDK and the credential before a run starts
any client.

#### Staged pairwise judges

An agentic pairwise judge can also be data: a bundle of the files it needs
and a graph of agent stages, which `stagedPairwiseJudge(bundle)` runs. A
judge maintained elsewhere as prompt files, such as a team's production
judge, runs in MST without being reimplemented: the plugin builds the bundle
from those files and registers the result.

```js
import { stagedPairwiseJudge } from '@gleanwork/mcp-server-tester/evals';

export default {
  meta: { name: 'acme-judges', version: '1.0.0', namespace: 'acme' },
  pairwiseJudges: {
    'two-step': stagedPairwiseJudge({
      schemaVersion: 1,
      name: 'two-step',
      files: [{ path: 'prompts/gather.md', content: gatherPrompt }],
      stages: [
        {
          id: 'gather',
          prompt: [{ file: 'prompts/gather.md' }],
          forbidKeys: ['preferred'],
        },
        {
          id: 'verdict',
          after: ['gather'],
          prompt: [
            { text: 'Notes:\n{{stages.gather.text}}\nCompare a/ and b/.' },
          ],
          output: 'verdict',
        },
      ],
      result: { overall: 'verdict' },
    }),
  },
};
```

| Field      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`    | Prompts and helper scripts, written into the workspace (`content`, or `base64`).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `prepare`  | Trusted programs (`argv`) run in the workspace, in order, before any stage: to turn both trials into the layout the prompts expect. They run unsandboxed, as the plugin's own code.                                                                                                                                                                                                                                                                                                                           |
| `workdir`  | Where agents start and are confined to, under the workspace (default the root).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stages`   | Agent runs. A stage runs when every stage in `after` is done; independent stages run at once. `prompt` (and `system`) is a list of parts: `{ file }`, `{ text }`, or `{ json, format }` (`pretty`, or `python` for `json.dumps(..., sort_keys=True)`). `writes` writes files before the stage runs. `output` is `text`, `json` (the first JSON object in the answer) or `verdict`. `forbidKeys` fails the judgment when a JSON answer has one. `maxTurns`, `model` and `effort` override the judge's options. |
| `result`   | `overall`: the verdict stage that decides; `dimensions`: named verdict stages, reported as the preference's dimensions.                                                                                                                                                                                                                                                                                                                                                                                       |
| `order`    | `randomized` (default): which run is slot A is picked per case from a SHA-256 of `seed` (default the case ID), so the judge can't tell the baseline, and MST doesn't also swap positions. `baseline-first`: A is the baseline, and MST swaps.                                                                                                                                                                                                                                                                 |
| `requires` | Input paths, such as `candidate.artifactsDir`, whose absence skips the comparison.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `defaults` | Agentic judge options (runtime, model, effort, turns, timeout).                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Text and JSON strings take placeholders: `{{workspace}}` (the workspace root),
`{{case.id}}`, `{{case.input}}` (the prompt), `{{stages.<id>.text}}` and
`{{stages.<id>.json}}` (an earlier stage's answer; a stage can quote only
stages it is after), and `{{file.text:<path>}}` / `{{file.json:<path>}}` (a
workspace file). A JSON string that is a single placeholder takes its value,
not its text.

A verdict stage answers `{ "preferred": "A" | "B" | "tie", "gap_score": 0-5 }`
about slots A and B (or both `absolute_score_a`/`_b`, 0-10), plus an optional
`explanation`. MST maps slots back to baseline and candidate: the preference
from `overall`, its strength `gap_score / 5`. A stage that fails, or a verdict
that isn't one, fails the comparison. The preference's `version` is the
bundle's SHA-256 unless the bundle sets one; `metadata` records which slot held
the candidate, each verdict by slot, and each stage's tool calls.

The workspace is `agenticPairwiseJudge`'s, with the trials in slot order:
`a/` and `b/` (`response.md`, `transcript/`, `artifacts/`), `case.json`, and the
bundle's files.

### Client artifacts

A client can report a local directory with its own record of each trial, and
which paths in it are evidence (`ClientRunResult.artifacts`, `{ dir, include }`).
Cowork reports its session folder and includes only the audit log
(`audit.jsonl`), the files the agent wrote (`outputs/`), its transcripts
(`.claude/projects/*/*.jsonl`) and the tool output it saved to files
(`.claude/projects/*/*/tool-results`). Before anything grades the trial, MST
copies what `include` names and nothing else: an allowlist, so a credential
or setting the client didn't anticipate is never copied. In a pattern, `*`
matches any characters of one name, but not a leading `.`, as in a shell. A
directory includes everything under it except hidden names, which a pattern
must name: Cowork's `outputs/` is its working directory, and its
`outputs/.claude/settings.local.json` isn't copied. Symbolic links and other
non-regular files are never copied. Judges and
pairwise judges get the copy as `trial.artifactsDir`; no result holds its path.

A copy has limits: 16 MB per file, 64 MB in all, 4,096 entries and 16
directories deep. A copy that fails (over a limit, or a directory that's gone)
leaves nothing behind, and the trial is an infrastructure failure
(`clientDiagnostics.failureKind: "artifacts"`), not graded and left out of
pass rates.

A run that keeps full transcripts (`"redactStoredResponses": false`) keeps the copy
in its directory, at `artifacts/<variant>/<case-id>/<trial>/`, and the trial's
transcript names it (`"artifacts"`), so `mst grade` gives judges exactly what they
read when the run was graded first. `mst grade` refuses a run whose transcript
names any other path, or whose copy leads outside the run directory through a
symbolic link. Otherwise the copy is in a temporary directory, removed once
grading is done.

### Dataset sources

The built-in `file`, `dir` and `gcs` sources read canonical `EvalDataset` JSON only. They don't infer assertions from a first case, attach clients or add judges, and they reject fields they don't know, on every case. A minimal dataset needs a name, a case ID and an input:

```json
{
  "name": "search-regression",
  "cases": [{ "id": "search", "input": "Find the Q3 planning doc" }]
}
```

Every case's `input` must contain at least one non-whitespace character, for every client, including run-only plugins. MST checks file, plugin and in-memory datasets before opening a client or submitting any trial. A blank later case therefore stops the run before earlier valid cases run. Valid prompts keep their exact text, including leading and trailing whitespace, line endings and Unicode; validation does not trim them.

`dir` reads every `.json` file in the directory (subdirectories too with `"recursive": true`), validates each the same way, and merges their cases into one dataset named after the directory. `gcs` needs the optional `@google-cloud/storage` package and Application Default Credentials that can read the object.

Datasets in another schema need a dataset source in your own plugin that converts them. The conversion policy (default trials, pass thresholds, which judges a case gets) belongs to that source, not to MST:

```typescript
import {
  loadEvalDatasetFromObject,
  type Plugin,
} from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const MySourceSchema = z
  .object({ type: z.literal('my/dataset/format'), path: z.string().min(1) })
  .strict();

export default {
  meta: { name: 'my-mst-plugin', version: '1.0.0', namespace: 'my' },
  datasetSources: {
    format: {
      schema: MySourceSchema,
      async load(config, context) {
        const { path } = MySourceSchema.parse(config);
        // readMyFormat and convertToCanonical are your own reader and converter.
        const raw = await readMyFormat(
          path,
          context.configDir ?? context.rootDir
        );
        return loadEvalDatasetFromObject(convertToCanonical(raw));
      },
    },
  },
} satisfies Plugin;
```

An eval config that loads the plugin declares `{ "type": "my/dataset/format", "path": "..." }` in `datasets`. Select the format in the declaration rather than inferring it from a first case, and fail on fields the source can't map instead of dropping them.

### Plugin datasets and snapshots

A dataset source whose schema takes no options is a dataset: an eval config lists it by name, and [`mst datasets`](cli.md#datasets---find-plugin-datasets) lists it. A source that keeps snapshots sets `snapshots: true`, reads `context.request`, and sets the dataset's `snapshot` to the one it read:

```ts
const plugin: Plugin = {
  meta: { name: '@acme/mst-plugin', namespace: 'acme' },
  datasetSources: {
    'info-seeking': {
      description: 'Questions with one right answer, from the support corpus.',
      snapshots: true,
      schema: z.object({ type: z.string() }).strict(),
      // context.request: { source: 'snapshot' | 'live', snapshot?: string }
      async load(_config, { request }) {
        if (request?.source === 'live')
          return loadEvalDatasetFromObject(await readLive());
        const snapshot = request?.snapshot ?? (await latestSnapshot());
        return {
          ...loadEvalDatasetFromObject(await readSnapshot(snapshot)),
          snapshot,
        };
      },
      // Optional: what `mst datasets` shows without loading cases.
      async describe() {
        return { cases: 50, snapshot: await latestSnapshot() };
      },
    },
  },
};
```

```json
{
  "datasets": [
    "acme/dataset/info-seeking",
    { "type": "acme/dataset/info-seeking", "snapshot": "2026-10-01" },
    { "type": "acme/dataset/info-seeking", "source": "live" }
  ]
}
```

- **One object form.** A dataset declaration is `{ "type", "snapshot"?, "source"? }`, plus any options the source takes of its own (as in [Dataset sources](#dataset-sources)). The bare string is shorthand for `{ "type" }`. A declaration with `ref` fails with a message naming `type`.
- **`snapshot` and `source` are MST's.** MST takes them off the declaration before the source's schema sees it, passes them as `context.request` (`source` defaults to `snapshot`; no `snapshot` means the source's latest), and rejects them for a source without `snapshots`. A dataset back with a snapshot other than the one asked for, or live data with a snapshot, fails the run.
- **`run.json` records which copy.** Each plugin dataset in `datasets` has its `type`, next to its `caseCount` and `contentHash`. A source with snapshots also records `source` (`snapshot` or `live`) and, for a snapshot, its id in `snapshot`. `mst run --dry-run` prints the same. Unchanged cases hash the same whichever copy they came from.

### Clients

The client is the MCP client application an eval tests. Built-in clients have canonical names; how MST drives one (a CLI, desktop automation, an SDK) isn't part of its name. `mst clients` lists them, with the plugins' clients for `--config` or `--plugins`:

<!-- clients:start (generated by `npm run docs:clients`) -->

| Client        | What it is                                                                                                         | Runs on      |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ------------ |
| `api`         | The model alone, through its provider's API, with the servers' tools: it isolates the model and your tool metadata | any OS       |
| `chatgpt`     | The ChatGPT desktop app                                                                                            | macOS, Linux |
| `claude-code` | The Claude Code CLI, headless                                                                                      | any OS       |
| `codex-app`   | The Codex surface of the ChatGPT desktop app                                                                       | macOS, Linux |
| `codex-cli`   | The Codex CLI, headless, through the Codex SDK                                                                     | any OS       |
| `cowork`      | Claude Desktop in Cowork mode                                                                                      | macOS, Linux |

What each one needs on the machine that runs its trials (`mst clients show <client>` prints the same, with its options):

- **`api`.** Install: `ai` and the provider's AI SDK package, such as `npm install ai @ai-sdk/anthropic`. Credentials: the provider's API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, ...), or an LLM gateway (`ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` with `MST_LLM_AUTH_COMMAND`).
- **`chatgpt`.** Install: macOS: the ChatGPT app, signed in, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST; Linux: MST's ChatGPT image (`--runner docker`). Credentials: macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner; Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`). Setup: Docker: `mst runner setup docker --config <a ChatGPT eval>`.
- **`claude-code`.** Install: Claude Code (`claude`) on `PATH`. Credentials: `ANTHROPIC_API_KEY`, or Google Application Default Credentials with `provider: "vertex"`.
- **`codex-app`.** Install: macOS: the ChatGPT app, signed in with access to Codex, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST; Linux: MST's ChatGPT image (`--runner docker`), which runs Codex in the ChatGPT app. Credentials: macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner; Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`). Setup: Docker: `mst runner setup docker --config <a Codex app eval>`.
- **`codex-cli`.** Install: `@openai/codex-sdk` beside MST (`npm install @openai/codex-sdk`), which brings the Codex CLI. Credentials: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`).
- **`cowork`.** Install: macOS: Claude Desktop, signed in, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST; Linux: MST's Cowork image (`--runner docker`), or a prepared desktop with Claude Desktop. Credentials: macOS: `ANTHROPIC_API_KEY` for Cowork inference, unless managed preferences set its provider; `ANTHROPIC_API_KEY` or an LLM gateway for the Computer Use planner; Linux image: Cowork inference, `ANTHROPIC_API_KEY` or an LLM gateway (`ANTHROPIC_BASE_URL` with `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN`). Setup: macOS: `mst cowork setup`, then sign in to Claude Desktop once; Docker: `mst runner setup docker`.

Options and their defaults follow. `timeout` is in milliseconds. Required options must be supplied; “not set” preserves omission. OS- and environment-dependent defaults resolve on the trial machine, not while listing or loading the config. Removed options are not listed.

#### `api` options

| Option         | Default                                   |
| -------------- | ----------------------------------------- |
| `model`        | "claude-sonnet-4-20250514"                |
| `maxToolCalls` | 5                                         |
| `timeout`      | none (no time limit)                      |
| `temperature`  | 0                                         |
| `maxTokens`    | not set (provider default)                |
| `provider`     | inferred from model; otherwise anthropic  |
| `apiKeyEnvVar` | provider credential or LLM gateway        |
| `systemPrompt` | not set (no additional instructions)      |
| `skills`       | "off"                                     |
| `env`          | inherited environment; no extra variables |

#### `chatgpt` options

| Option             | Default                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `model`            | required                                                            |
| `reasoningEffort`  | app default                                                         |
| `timeout`          | 300000                                                              |
| `env`              | inherited environment; no extra variables                           |
| `plugins`          | no marketplace plugins (Linux only)                                 |
| `configPath`       | app profile config.toml on the trial machine (OS-specific)          |
| `requireMcpCalls`  | false                                                               |
| `correlation`      | "exact_prompt"                                                      |
| `maxActions`       | macOS: 32; Linux: 24                                                |
| `computerUseModel` | macOS: MST_COWORK_CUA_MODEL or claude-sonnet-4-6; Linux: no planner |

#### `claude-code` options

| Option         | Default                                            |
| -------------- | -------------------------------------------------- |
| `model`        | Claude Code default                                |
| `timeout`      | 180000                                             |
| `systemPrompt` | not set (no additional instructions)               |
| `provider`     | "anthropic"                                        |
| `isolate`      | true                                               |
| `cwd`          | empty temporary directory, removed after the trial |
| `env`          | inherited environment; no extra variables          |

#### `codex-app` options

| Option             | Default                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `model`            | required                                                            |
| `reasoningEffort`  | app default                                                         |
| `timeout`          | 300000                                                              |
| `env`              | inherited environment; no extra variables                           |
| `plugins`          | no marketplace plugins (Linux only)                                 |
| `configPath`       | app profile config.toml on the trial machine (OS-specific)          |
| `requireMcpCalls`  | false                                                               |
| `correlation`      | "exact_prompt"                                                      |
| `maxActions`       | macOS: 32; Linux: 24                                                |
| `computerUseModel` | macOS: MST_COWORK_CUA_MODEL or claude-sonnet-4-6; Linux: no planner |

#### `codex-cli` options

| Option            | Default                                                        |
| ----------------- | -------------------------------------------------------------- |
| `model`           | Codex default                                                  |
| `timeout`         | 300000                                                         |
| `systemPrompt`    | not set (no additional instructions)                           |
| `reasoningEffort` | Codex default                                                  |
| `sandbox`         | read-only; danger-full-access when MST_JUDGE_SANDBOX=container |
| `webSearch`       | false                                                          |
| `cwd`             | empty temporary directory, removed after the trial             |
| `apiKeyEnvVar`    | OPENAI_API_KEY or LLM gateway                                  |
| `env`             | allowed inherited variables; no extra variables                |

#### `cowork` options

| Option             | Default                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `maxActions`       | 24                                                                      |
| `hitlMaxActions`   | 12                                                                      |
| `computerUseModel` | macOS: MST_COWORK_CUA_MODEL or claude-sonnet-4-6; Linux: no planner     |
| `dataDir`          | Claude Desktop session directory on the trial machine (OS-specific)     |
| `appVersion`       | installed app version (macOS only)                                      |
| `pluginRoots`      | not set (caller stages plugin roots on Linux)                           |
| `mcpDataRoot`      | not set (caller provides a private root on Linux)                       |
| `mode`             | third-party (MST-managed profile)                                       |
| `account`          | MST-managed third-party profile                                         |
| `connectors`       | first-party: selected servers read-only; legacy account mode: unchanged |
| `timeout`          | 900000                                                                  |
| `model`            | Cowork default                                                          |
| `env`              | inherited environment; no extra variables                               |
| `plugins`          | no marketplace plugins                                                  |

<!-- clients:end -->

Each client has its own guide: [mst-client.md](./mst-client.md) for `api` and `claude-code`, [codex.md](./codex.md), [cowork.md](./cowork.md) and [cowork-docker.md](./cowork-docker.md), and [chatgpt-desktop.md](./chatgpt-desktop.md) and [chatgpt-docker.md](./chatgpt-docker.md) for `chatgpt` and `codex-app`.

Set the model beside the client. The `api` client infers which API serves it from the model id (`claude-*`, `gpt-*`, `gemini-*` and so on; a `claude-*@date` id is Vertex). Set `provider` only to override that, for example to route through Vertex or a gateway.

A client runs one input and returns its transcript. It doesn't repeat cases, run judges or decide pass/fail; `runEvalDataset` does that for every client. A plugin client is the way to add one: plugins contribute them under `clients`.

```typescript
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

export default {
  meta: { name: 'my-mst-plugin', namespace: 'my' },
  clients: {
    assistant: {
      schema: z.object({ type: z.literal('my/client/assistant') }),
      evidence: 'observed',
      async run(input, config, context) {
        // input.prompt and input.servers are the unit of execution.
        return { finalText: 'Answer from the assistant', events: [] };
      },
    },
  },
} satisfies Plugin;
```

An eval config that loads the plugin selects the client with `"client": "my/client/assistant"`, and passes its options in `clientOptions`.

- **The transcript.** `run` returns a `ClientRunResult`: `finalText`, `events`, and optional `usage`, `error` and timing fields: `startedAt` and `completedAt` (ISO times), and on each event `startedAt`, `completedAt` and `durationMs`. `modelCalls` lists the model requests, when the client knows them: each with its `id`, `model`, usage (`inputTokens` uncached, `cacheReadInputTokens`, `cacheCreationInputTokens`, `outputTokens`, `reasoningOutputTokens`), `finishReason`, `text`, the `toolCallIds` it asked for, and its times; with the provider's `requestId`, or the client's `entryIds` for the request's records, the client's own telemetry can name it. They become a trial's [OpenTelemetry traces](./telemetry.md). `hostTelemetry` is what the client itself reported over OpenTelemetry for the trial, from MST's receiver ([`telemetry.host`](./telemetry.md#the-clients-own-telemetry)). Each event has a `kind` (`tool_call`, `skill`, `command`, `subagent` or `tool_search`), a `source` (`mcp` or `builtin`), a `name`, and optionally the MCP server label, arguments, output and ID. Record what the client did; don't reconstruct tool calls from the final text. A `tool_search` event (the client searching its tool catalog) lists the tools the search returned in `results`, each `{ name, server? }`. Type client-native actions as their kind rather than as calls to a client tool, so skill assertions and search metrics can read them.
- **How it ended.** A client decides how its attempt ended ([ADR 0010](./adr/0010-a-trial-ending-is-decided-where-it-ends.md)); MST never reads an `error`'s words to decide. An `error` alone is a trial that failed, graded as usual. When something around the client broke, return `ending: { kind: 'infrastructure', broke, retryable, reason }` (`TrialEnding` from the root), such as `broke: 'provider', retryable: true` for a provider's `429`, or `broke: 'setup', retryable: false` for a key it rejects. A prompt that doesn't fit the model's context before the client acts is `setup`, not retryable; one that fills the context after the client acted is a trial. A client that runs out of the case's own `timeout` is a trial too: return `ending: { kind: 'trial' }` with the error, as Claude Code and Codex do. Without `ending`, `diagnostics.failureKind` decides: `startup`, `process`, `output`, `not-submitted` and `cleanup` are the client app, `timeout` a deadline, and `missing` and `artifacts` collection, all retryable; `input` (the client kept only part of the prompt) is setup, not retryable. A `run` that throws is a deadline for an `AbortError`, a network failure when the error or its `cause` has a Node network `code` (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, ...), and a trial otherwise. When MST itself fails after the client (it can't copy the trial's artifacts, or a desktop session's cleanup fails), the attempt becomes a retryable infrastructure failure (`collection` or `client-app`) whatever ending the client gave, unless the attempt already was an infrastructure failure (the client's own, or an earlier failure of MST's): what broke first stands in the ending, and in `diagnostics.failureKind` when the attempt had one; otherwise the failure kind names MST's failure. The `error` text keeps every failure's message.
- **Evidence.** Declare `evidence: 'structured'` only for authoritative protocol or client-native transcripts. With `observed`, `none` or no declaration, tool-call and argument assertions can't pass; text and judge assertions still run.
- **Servers.** Events keep their MCP server labels. An event with a `server` names the tool exactly as that server lists it (`{ server: 'docs', name: 'search' }`); MST never reads a `docs.` prefix off its `name`. On a one-server run, MST gives an event with no `server` that server. With more than one server, tool assertions use label-qualified names, or the eval config's `toolMap` from canonical to native names.
- **In results.** Each client case result keeps the transcript as `transcript`, a `Transcript`: the `ClientRunResult` your client returned, without telemetry and diagnostics, plus its evidence. On a one-server variant, MCP events that name no server get that server's label. A case with several trials has no `transcript` of its own; each entry in `trialResults` has the transcript of that trial. In an eval, every case result also names its `variant`. Stored results drop `finalText` and each event's `output`, the same way they drop `response`; events, servers, arguments and usage stay. They also drop `telemetry.content`, so a client puts anything there that may quote the prompt, the model or the server (a conversation, text from the app), and keeps counts, ids and statuses in the rest of `telemetry`.
- **Secrets.** MST replaces each secret it knows with `[REDACTED]` in everything a client returns, and in the error a `run` throws, before it grades or stores them, early transcripts from an open session included. A value is a secret when MST uses it as a credential (a server's access token, the variable its `accessTokenEnv` names, a connector token), or when its name says it is one, from 8 characters. That covers an environment variable, secrets file entry, server header or stdio server `env` entry with one of these words in its name: `token`, `key`, `apikey`, `secret`, `password`, `passwd`, `auth`, `authorization`, `cookie`, `credential`, `credentials` or `pat`. A name splits into words at `_`, `-`, `.`, camelCase (an acronym too) and the digits that end it, and a whole word must match, so `ACME_API_KEY`, `accessToken`, `APIToken` and `GITHUB_TOKEN2` are credentials, while `GIT_AUTHOR_NAME`, `MCP_OAUTH_SERVER_URL`, `AUTH0_DOMAIN` and `GITHUBTOKEN` are not. Settings beside them, such as `OPENAI_BASE_URL` or an instance name, are kept, so a transcript that quotes them grades as it should. Give a credential such a name, or MST can't tell it from a setting. `artifacts` paths are kept too: they name files, not content. Object keys are redacted like values. On a runner's machines, the worker redacts with the secrets it knows, including its resolved servers' credentials, and this machine redacts each trial again with its own as the trial comes back, before saving or exporting it. A client redacts a credential it resolved itself, such as an API key it read from its own config, before it returns.
- **Collection batches.** MST groups trials with fixed client settings into sessions and saves each result before sending the next trial. Cases need unique IDs within a dataset. Session operations return results; MST owns reporting and waits for room under the run's limits. Run-only clients keep their existing concurrency.
- **Tool metadata.** A client that connects to the servers in `input.servers` gets a variant's tool metadata (`tools`) with no work of its own: the run gives it `http` server configs for a local MCP proxy that applies the variant, so the client must speak Streamable HTTP (see [Tool metadata on every client](#tool-metadata-on-every-client)). A client that shows tool metadata itself sets `toolMetadata: true`; `variantToolMetadata(context.evalConfig, context.variant)` from `./evals` gives the variant's (its own `tools`, else the config's), and `buildToolSurface(listed, metadata)` applies it with MST's rules (keys, renames, collisions), and `resolve(name, server)` maps a presented name back to the original tool. Record a renamed tool's calls under `originalName`, with the model's name in `rawName`, as MST's clients do. An open session gets one fixed proxy endpoint. MST checks that the client listed the expected tools separately for each session's settings. A run-only client that connects to one server set for the whole batch sets `serversPerBatch: true`. A proxied request also carries `input.checkServers`: the same servers on an endpoint for the client's own checks, such as a readiness probe, so that traffic isn't taken for the model seeing the variant. A client that connects elsewhere (hosted connectors, say) sets `toolSurfaceProxy: false`; an eval config that gives it `tools` then fails validation.
- **What it honours.** `maxConcurrency` caps the eval config's `concurrency`.
- **What it is and needs.** `description` says in one line what product the client is. `requirements` says what a machine needs to run its trials: `os` (`macos`, `linux`; without it, any), and short lines for what to `install`, the `credentials` it reads, and the `setup` commands that prepare a machine. `mst clients` and `mst clients show` print them. Both are optional, and MST checks their shape when it loads the plugin. At eval load, MST rejects a client whose `requirements.os` excludes the runner's known OS. The error names the client, runner and supported OS. A runner that doesn't declare its OS leaves it unknown.
- **Option defaults.** Both client commands and the generated tables read the options schema. Use Zod defaults for values applied by parsing. For a fallback applied only at runtime, annotate the field with `.meta({ default: value })`, using the same value the runtime uses. For a dynamic default, use `.meta({ 'x-defaultDescription': '...' })`. Metadata describes omission without changing it; do not compute per-OS defaults on the coordinator. A required option without a default is marked `required`. An optional plugin option with no default annotation is marked `not declared`.
- **Headless.** A client that runs as a process with no desktop session (a CLI or an SDK, as `api`, `claude-code` and `codex-cli` do) sets `headless: true`. A runner whose machines come with a desktop, such as `docker` with MST's Linux image, then runs a shard whose clients are all headless in a container without one: no desktop app, no VM and no Cowork inference. Without it, a client gets the desktop.

### Client sessions

`ClientDefinition.open(options, context)` opens a client once for several trials. Cowork, ChatGPT and Codex app implement it. Plugin clients can supply `run`, `open`, or both. Local and worker collection prefer `open` when both exist. Run-only clients need no change; MST wraps them in one-shot sessions where needed, without changing their concurrency or error classification. The client extension's `runBatch` entry point is removed.

MST rejects empty or whitespace-only case inputs at dataset load for all clients, before any session opens or trial runs. Valid prompts are unchanged. Direct native-session calls retain their own blank-input guard before submission.

The session types are exported from `@gleanwork/mcp-server-tester/evals`:

- `ClientSessionOptions` fixes `config` (client options and model) and `input` (servers, optional `checkServers`, and environment) at open. The context supplies the eval, variant and runtime environment as before.
- `ClientSessionTrial` has only `caseId`, zero-based `trial`, and `input: { prompt }`. A trial cannot change the model, options, servers or environment. MST opens separate sessions for different fixed settings.
- `ClientSession.run(trial)` returns `ClientSessionResult`: `{ result: ClientRunResult, continuation: 'continue' | 'reset' | 'stop' }`. The result shape is unchanged. `reset` requires a reset before another submission; `stop` forbids later submissions on this session. Neither means that the trial passed or failed.
- `reset()` returns the app to a fresh state without sending a prompt. Optional `diagnose()` returns failure artifacts, or `undefined` when capture fails. It reads the app before a reset changes it. `close()` releases the app; failed cleanup retains the desktop lease for inspection.
- Optional `readiness` lists servers that resolve only after open, with their resolver and retry environment. MST checks them before the first trial. `lifecycle` exposes the client's setup and cleanup telemetry; MST reads it after close for `telemetry.batchLifecycle` on each result.

MST checks declared servers before opening. Cowork's preparation-dependent servers are checked after opening instead, never twice. MST calls session operations sequentially and closes on every path, including failed readiness, acquisition or reporting. An open that throws cleans up its own partial setup. Direct session callers must perform readiness checks and honor continuation.

The shared collection loop owns reset and diagnosis policy, consecutive-failure limits, early reporting and run limits. It keeps earlier results if a session throws and does not submit later trials on that session. Cleanup failure marks its results as infrastructure failures; the built-in desktop helper retains the lease for inspection. The existing reset retry delays and diagnosis deadlines do not change.

### Claude Code client-native events

The Claude CLI and Cowork clients read Claude Code transcripts, where skills, commands, subagents and tool search are calls to built-in tools. They are recorded as typed events:

| Claude Code tool | Event                                                  |
| ---------------- | ------------------------------------------------------ |
| `Skill`          | `skill`, named for the skill it loaded                 |
| `SlashCommand`   | `command`, named for the command                       |
| `Task`, `Agent`  | `subagent`, named for the subagent type                |
| `ToolSearch`     | `tool_search`, with the tools it returned in `results` |

A search's `results` come from `tool_reference` blocks in its result, or, without them, from `mcp__<server>__<tool>` names in its text. This format is inferred rather than taken from recorded `ToolSearch` transcripts; if `tool_search_hit_rate` reads 0 where searches clearly worked, check the search's `output` in the transcript. Other built-in tools (`Bash`, `Read`) stay tool calls with `source: 'client'`.

### System prompts

`systemPrompt` adds text to a client's system prompt, such as an organisation's instructions. To measure what it changes, give one variant the prompt (a variant inherits the eval config's `clientOptions` when it uses the same client):

```json
"variants": [
  { "name": "no-prompt" },
  { "name": "org-prompt", "clientOptions": { "systemPrompt": "For actions in a connected app, call find_skills first." } }
]
```

- **`api`** puts it in the model's system prompt, ahead of the skills catalog when `skills` is on.
- **`claude-code`** passes it with `--append-system-prompt`, so Claude Code's own system prompt stays.
- **`codex-cli`** sets it as Codex's `developer_instructions`, so Codex's own instructions stay.
- **Cowork and ChatGPT** take organisation instructions from the app, not from MST, so `systemPrompt` is a validation error for them.

A plugin client that can apply one declares `systemPrompt` in its schema. A case's own `clientOptions.systemPrompt` replaces the one it inherits, and is a validation error for a client that can't apply one.

### Tool metadata on every client

A variant's tool metadata (`tools`: descriptions, input schemas, renames) reaches every client:

- **`api`** applies the variant in-process.
- **Clients that connect to their servers** (plugin clients, `claude-code`, `codex-cli`, `cowork`) get them through a local MCP proxy. The run starts it on first use and gives each client request its own loopback Streamable HTTP endpoints, one per server, with the servers' labels. The proxy applies each server's timeouts to its own calls to that server, so an endpoint carries none of a server's connection options, and a stdio server (such as a connector's dry-run proxy) works behind it. The proxy presents the variant's tools and sends calls to a renamed tool to the original. Other requests (resources, prompts, skills) pass through; notifications, such as list changes and progress, don't.
- **One connection per server for the variant.** The proxy connects to each server once and shares that connection across the variant's cases, where a client without tool metadata may connect per case. A server that keeps per-connection state sees one connection for a variant with tool metadata.
- **A request whose client never lists the proxied tools fails.** Otherwise the run would report results for a variant the model never saw. Cowork sets up its servers once per batch, so it lists them once: the batch shares one endpoint, and the check is for the batch. MST's readiness check runs against the declared servers before the proxy starts, so it never goes through the proxy and doesn't count.
- **Calls are recorded under the tools' original names**, so a dataset's assertions read the same in every variant, with the model's name in `rawName`.

The ChatGPT desktop client opts out until it is verified with the proxy, so an eval config that gives it `tools` fails validation.

### Server readiness

Every client's trials wait for one readiness check ([ADR 0011](./adr/0011-a-client-is-a-product-and-how-it-runs-is-not-configuration.md)). Before the first trial of a batch (a variant's trials of one dataset, on one client), MST connects to each of the variant's servers, lists its tools and closes the connection. A server is ready when it connects and lists at least one tool, and at least its `minTools` for a stdio server. Each probe has 30 seconds for all of that; a server that sets a longer `connectTimeoutMs` gets that to connect, plus 30 seconds. When the time runs out, MST closes the probe's connection at once (a stdio server's stdin, an HTTP request), even one that is still connecting, so a stalled server doesn't keep it open.

- **Every client.** It runs for `api`, `claude-code`, `codex-cli`, `chatgpt`, `codex-app`, `cowork` and plugin clients, on the machine that runs the trials: in the `mst run` process for a local run, and on the worker in a runner with machines. A client's own startup checks (Claude Code's MCP startup, Codex CLI's `required` servers, the ChatGPT app's status probe on Linux) still run after it.
- **When.** MST checks before the batch starts, before anything touches a desktop app. Cowork's stdio servers resolve only once the app is prepared, so Cowork's servers are checked after preparation and before its first prompt instead. A server is checked once per batch. A case that names its own client is checked the way that client reaches the servers: when the cases of a batch reach them in different ways (through the proxy or directly), the servers are checked once for each way.
- **Retries.** A server that isn't ready is checked again after 10 seconds and then after 30 more. Only the servers that failed are checked again. `MST_MCP_READINESS_RETRY_S` sets other delays as comma-separated seconds (`5,20`); an empty value turns retries off. The old name, `MST_COWORK_MCP_PREFLIGHT_RETRY_S`, fails the run when it starts.
- **Proxied servers.** For a client that gets [tool metadata](#tool-metadata-on-every-client) through the proxy, MST checks the servers as declared, with their `minTools` and retries, before it starts the proxy, and before Cowork's preparation too. The check never goes through the proxy, so it doesn't count as the client listing the variant's tools. If the proxy still can't reach a server once the check passed, the batch ends the same way, with a reason that names the server and says the proxy was starting.
- **When a server isn't ready.** No trial of the batch is sent. Each trial ends as an [infrastructure failure](./adr/0010-a-trial-ending-is-decided-where-it-ends.md) with `broke: 'setup'` and `retryable: true`, and a reason that names the server and what failed, for example `MCP server not ready, so no trial was sent: search listed no tools. Checked 3 times.` Its case is incomplete, the run goes on with its other batches, and `mst run --resume` collects those trials again.
- **Not checked.** A stdio server with client-resolved fields (`url`, `auth`, `files`, or `${...}` placeholders) has no launch until its client resolves it; only Cowork checks it, after preparation. `runEvalDataset` in a Playwright test isn't checked either: the test's fixture already connected.
- **Write tools.** A server with no [write mode](#writes) that lists a tool that isn't read-only fails the check, without retries: `MST can't see these servers' writes, so no trial was sent: "docs" lists tools that aren't read-only (save).` The load check stops the run for this before any trial when it can list the server; the readiness check covers the servers it can't (one only a client can launch, one on a runner's machines, or one that was down).

## Writes

A write case passes only on evidence that MST saw its writes ([ADR 0014](./adr/0014-graders-check-outcomes-and-every-write-is-accounted-for.md)). A **write case** is a case whose `expected.writes` lists writes, or whose trials made one.

### Write modes

Every server in every variant has a write mode before the run starts, or the run doesn't start:

| Mode             | What happens to a write                                                                                                      | Set by                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `planned`        | The [dry-run proxy](./cowork.md#dry-run-proxy) stops it and answers with a planned-write result.                             | A connector whose `launch` returns `dryRunProxyServer({ writes: context.writes, ... })` |
| `simulated`      | The proxy stops it and answers with a success reply.                                                                         | The same, with `"simulateWrites": true` in the eval config                              |
| `server-planned` | The server stops it and marks its result with the connector's `plannedWriteKey`; the proxy forwards the call and records it. | A connector with `plannedWriteKey` whose proxy sets `forwardWrites`                     |
| `unguarded`      | It reaches the server, and MST can't see it.                                                                                 | `"writes": { "<label>": "unguarded" }` in the eval config                               |
| `live`           | It reaches the service.                                                                                                      | `"writes": { "<label>": "live" }`, and `mst run --allow-live-writes`                    |
| `read-only`      | The server lists no write tools when MST checks it.                                                                          | None of the above                                                                       |

When the run loads, MST lists the tools of each `read-only` server it can launch. A tool that isn't read-only, by the proxy's rule (`readOnlyHint: true` and not `destructiveHint: true`), stops the run and names the server and its tools. A server MST can't list here is checked by the [readiness check](#server-readiness) before its first trial instead.

MST doesn't sit between a `read-only` server and its client, so it checks each trial's transcript instead: a call to a tool the server didn't list at the readiness check ends the trial as a `setup` failure that `--resume` doesn't retry, `The client called docs.save, which its server didn't list when MST checked it: ...`. The server listed more tools to its client than to MST, for example because its tools depend on who signs in. MST can't stop that call, so put a server like that behind a connector's dry-run proxy.

The run also doesn't start when:

- a server is `live` without `--allow-live-writes`, or a case lists writes on a run with a `live` server: a live write case needs an outcome check, which MST doesn't have yet;
- compared variants' servers stop writes in different ways (`planned`, `simulated`, `server-planned`), so the same request gets different replies;
- a case lists writes on a server whose writes MST doesn't record;
- a connector's launch doesn't pass `context.writes` to its proxy, or changes whether it simulates;
- `writes` names a server that isn't in a variant, or one whose proxy already gives it a mode.

`run.json` keeps each variant's write modes (`variants[].writeModes`), and a regrade grades with them.

### The write record and the `writes` grader

The proxy records each write it stops, with its server, tool, arguments, the reply the client got and its mode ([the write record](./cowork.md#the-write-record)). After each trial, MST matches the record with the trial's transcript and stores it with the trial as `writeRecord`:

- `writes`: the trial's recorded writes, each with the transcript event of its call;
- `unreported`: recorded writes with no call in the transcript;
- `unrecorded`: write calls in the transcript, to a server whose writes MST records, that never reached its proxy;
- `unclassified`: forwarded calls MST can't classify: a dispatcher's calls without the server's mark, and calls to write tools whose result has no mark;
- `attribution`: `exclusive` when no other trial used the servers at the same time, else `matched` (only writes that match the trial's calls count, and unreported writes can't be told apart).

A case lists the writes it expects in `expected.writes`, with `toolsTriggered`'s matching rules:

```json
{
  "id": "post-summary",
  "input": "Post the summary in #team",
  "expected": {
    "writes": {
      "calls": [
        {
          "server": "slack",
          "tool": "slack_send_message",
          "arguments": { "channel_id": "C123" }
        }
      ],
      "exclusive": true
    }
  }
}
```

The `writes` grader checks a write case's record, never its transcript. It fails a trial with no record, a missing write, a write outside the list when `exclusive` is set, or out of order when `order` is `strict`, and it fails any unreported or unrecorded write whatever the case expects. A dispatcher's write matches by its target tool.

### Write evidence

Every score of a write case records what it rests on, as `writeEvidence`, weakest first:

1. `claimed`: the answer says the write happened (judges).
2. `called`: the client's transcript has the call (`toolsTriggered`, and a `writes` match found only as an unclassified call).
3. `requested`: a dry-run proxy recorded the request (`writes`).
4. `applied`: a check read the service's state. Reserved: MST has no outcome check yet, so no write case reaches it, and `outcome` in a case's assertions fails.

Judges get the write record (question judges as `write_record` in the transcript they read, agentic judges as `writes.json` in their workspace) and are told that a planned or simulated write is the action the client requested, not one that happened.

The [metrics](#metrics) `write_case_passed` (its rate over write cases), `write_evidence` (the weakest level across them), `unreported_writes`, `unrecorded_writes` and `unclassified_calls` summarize a variant's writes, and the run report shows them with its write modes. A stored run with `redactStoredResponses` drops each write's reply, and keeps its arguments.

## Execution lifecycle

```text
EvalConfig
  -> load the eval's plugins (built-ins are always available)
  -> validate tagged blocks, extension names and namespaces, schemas, and server labels
  -> resolve DatasetSource entries into EvalDataset values
  -> derive one or more variants from the eval config (baseline first)
  -> resolve every server's write mode, and list the read-only servers' tools
  -> check each batch's servers are ready, then run each variant through its
     client (built-in or plugin) with its MCPConfig[] server set
  -> compute metrics and judges
  -> write per-variant results through the ResultStore
  -> save a RunSummary with the config's identity, content hash, variant aggregates,
     deltas from the baseline, and per-case artifact pointers
```

`EvalDataset`, `EvalCase`, `MCPConfig`, and `runEvalDataset` remain
the canonical case and execution primitives. The eval layer composes them; it
does not replace them with a second case model.

## What a run leaves behind

Each run of an eval is a directory, in the versioned `mst.run/v1` format:

```text
.mcp-test-results/<eval name>/
├── latest.json                     # the newest complete, full run
├── history.json                    # a row per run, rebuildable from runs/ (mst.history/v1; mst history)
├── history/index.html              # the history page, built from history.json (mst open --history)
├── calibrations/<judge>/<identity>.json  # how one judge identity agreed with people (mst judges check)
├── option-key                      # the key run.json hashes credential-like client options with
└── runs/<run-id>/
    ├── run.json                    # what ran: variants, datasets (with content hashes), judges, plugins, runner, phases
    ├── transcripts/<variant>/<case-id>/<trial>.json     # what the client did in one trial
    ├── scores/<grader>/<variant>/<case-id>/<trial>.json # one grader's score for one trial
    ├── labels/<judge>/<variant>/<case-id>/<trial>.json  # a person's label for a judge's verdict (mst label)
    ├── results.json                # every case result, transcripts and scores joined
    ├── summary.json                # per-variant totals, metrics and comparisons (cases are in results.json)
    └── report/index.html           # the report `mst open` shows, built from the files above
```

- **Run IDs** sort by start time: `20261007T182504Z-7f3c2a`. The last six characters are its short form.
- **Every file** starts with `"format": "mst.run/v1"` and its `kind` (`run`, `trial`, `score`, `preference`, `label`, `calibration`, `results`, `summary`, `latest`). Readers keep fields they don't know, at every depth, so new optional fields keep the version; removing or renaming one moves the format to `mst.run/v2`. A field whose values the format names, such as a write's `mode`, a trial's `ending` or a transcript event's `kind`, is closed: a value this MST doesn't know fails the read and says to upgrade MST, because guessing what it means could change a count or a grade. MST checks each client's transcript events against the stored shape when the client returns them, so a client that reports, say, a tool call without a name fails that trial instead of writing a run MST can't read. A regrade keeps each transcript and write record as recorded, fields it doesn't know included. The JSON Schemas are published in `schema/run/v1/`; they describe each trial's transcript and each case result too.
- **Paths:** variant, case and grader names are URI-encoded into one path segment each, and trials count from 0. Case IDs must be unique within a run, because they name these paths: a case ID in two datasets fails before anything runs.
- **`latest.json`** is written last, and only for a full, graded run, so a crash, a partial run or an `mst run --no-grade` run leaves it at the previous run.
- **A run is saved as it goes.** Each trial's transcript is written to `transcripts/` as soon as the trial finishes, so a run that is stopped or killed keeps every trial that finished. With the first trial, and after each variant but the last, MST writes the run directory with what has run so far, and `run.json` says `"phases": { "collect": "partial", "grade": "partial" }`; the final write makes both `complete`. If the run stops on an error, it is written with `collect: failed` before the error is reported. `results.json`, `summary.json` and `run.json`'s `variants` list only the variants that finished, so `transcripts/` can also hold the trials of the variant that was running. Pairwise judges and the comparison with the previous run happen only in the final write.
- **An unavailable client is a result, not the end of the run.** When a batch client throws `ClientUnavailableError` (from `./evals`), because its desktop is still leased by an earlier batch or its machine can't be reached, each of its trials is an infrastructure failure that says why (with credentials redacted), and the run goes on to the next variant. Any other error, such as a bad option or a server that isn't ready, stops the run, keeping the variants that finished. Infrastructure failures are left out of pass rates.
- **The report says when a run didn't finish:** _incomplete_ for a run saved while variants remained (still running, or killed), and _stopped early_ for one that stopped on an error.
- **Redaction** applies to every file, as it does to stored results (`redactStoredResponses`). A redacted transcript has no answer or tool outputs, so a run is only graded again (`mst grade`) when it was stored with `"redactStoredResponses": false`.
- **Phases:** `run.json`'s `phases.grade` is `skipped` for a run collected with `mst run --no-grade`: its trials have transcripts and no scores, and it is never a previous run to compare with.
- **Regrades:** `mst grade <run>` grades a run's transcripts with the eval config's graders as they are now, and writes the scores as a new run, `<run-id>.g2` (then `.g3`, …), next to it. Its `run.json` has `gradedFrom`, the run that collected the transcripts, and the regrade carries a copy of them and of the run's labels.
- **Labels:** `mst label` (a page that shows one trial at a time, without the judge's verdict) and `mst label import` write a person's labels into `labels/`: a pass or fail for one trial of a judge, or `labels/<pairwise judge>/<variant>/<case-id>/vs/<baseline>.json` for a preference against a baseline. A label records who gave it, when, and its split (`dev` or `test`). See [`mst label`](./cli.md#label---label-judge-verdicts).
- **Calibrations:** `mst judges check` writes `calibrations/<judge>/<identity>.json` in the eval's directory: one judge identity's TPR, TNR, kappa and `unknown` rate against the `test` labels of the runs it read (or a pairwise judge's agreement and ties), and whether it is usable. It applies only to that identity, and a later check replaces it. `unversioned: true` means MST can't see the judge's version change; scores and `run.json`'s judges say the same as `judgeUnversioned` and `unversioned`. See [`mst judges check`](./cli.md#judges-check---measure-a-judge-against-labels).
- **`--output-dir`** names the eval's directory (`<output-dir>/runs/<run-id>/`).
- **`report/`** is built from the run's own files, so `mst open <run>` can rebuild it for a run copied without it. `run.json` records each variant's setup (client, model, servers, tool metadata, input template, judges, and client options, with any whose name suggests a credential replaced by a hash) for the report's _What differs_. See [`mst open`](./cli.md#open---open-a-runs-report).

### Result stores

A result store keeps each run's directory besides the local one, so runs from CI or other machines are in one place. Choose it per run with `mst run --results <store>`, or set `results.store` in the eval config; the flag wins.

```bash
npx mst run --config eval.json --results gs://my-bucket/evals   # a GCS bucket and prefix
npx mst run --config eval.json --results file:./shared-results  # a local directory
npx mst run --config eval.json --results acme/result-store/eval-results  # a plugin's store
```

The store holds the same layout as a local results directory: `<eval name>/runs/<run-id>/` (every file, the report included, and `manifest.json`) and `<eval name>/latest.json`. The run is written locally first, then copied: its files, then its `manifest.json` (each file's size and SHA-256); `latest.json` is written last, and only when the run became the local latest run (a full, graded run). If the copy fails, `mst run` fails and names the local run directory, and the store's `latest.json` is unchanged. Redaction applies before the copy, so the store gets what the run directory has.

A run in a store can be graded or resumed on another machine. When `mst grade <run>` or `mst run --resume <run>` doesn't find the run locally, it fetches it from the store (`--results`, else the eval config's): by its run ID or short form among the store's runs. The fetch checks every file against the manifest, and moves the run into the eval's local runs only once it is all there. A run without a manifest is still uploading, its upload failed, or an MST before beta.13 uploaded it, and isn't fetched. A regrade takes the next `.g<n>` that neither the local runs nor the store has, so regrades on two machines don't overwrite each other.

```bash
npx mst run --config eval.json --no-grade --runner docker --results gs://my-bucket/evals  # on a VM
npx mst grade 7f3c2a --config eval.json --results gs://my-bucket/evals                 # anywhere
```

With a store, the [previous run](#compared-with-the-previous-run) is the store's newest comparable run, so a CI machine with no local runs still compares with the last one. `mst batch --skip-existing` also reads the store.

The `gcs` store needs the optional `@google-cloud/storage` package and Application Default Credentials. A plugin's result store returns a `RunStore` from `create`: it only moves bytes, and MST owns the layout.

```ts
import type { RunStore } from '@gleanwork/mcp-server-tester/evals';

const store: RunStore = {
  location: 's3://bucket/prefix', // shown in messages
  async put(key, body) {}, // write bytes at a `/`-separated key
  async get(key) {
    return null; // the bytes, or null when there are none
  },
  async list(prefix, { shallow } = {}) {
    return []; // every key under prefix; with shallow, one level, "directories" ending in /
  },
};
```

Opening a stored run (`mst open --results`) and listing runs (`mst runs list`) are planned.

Run JSON, file/GCS result-store artifacts and `saveResultsTo` baselines are
written and read in chunks, so large batches of tool transcripts do not require one
V8 string for the whole summary. Local JSON files are replaced only after serialization completes; a
failed write leaves the previous file intact. This preserves every result and
transcript field without truncating tool output or relaxing evidence checks. The
result objects still need to fit in memory, and a single string value remains
subject to the JavaScript string limit.

## Variants

A variant is a patch over the eval config defaults. Variants replace separate A/B and
variant-optimization concepts. A variant may change its server set, client, model, client options,
tool-name map, input template, metrics, or judges. An eval config without variants
has one implicit `default` variant.

Each server's label is its key in `servers`. Transcripts and metrics attribute MCP
calls to servers by label.

## Judges

Judges are graders that score each trial. They are listed in three places, each entry a reference (`"acme/judge/completeness"`) or `{ "type": <reference>, ...options }`, such as `{ "type": "rubric", "rubric": "correctness", "threshold": 0.8 }`:

- **A case's `judges`**, beside its `assertions`, in the dataset.
- **The eval config's `judges`**, which every case runs.
- **A variant's `judges`**, which every case runs in that variant.

Which judges a case runs:

1. The case runs its own judges plus the eval config's.
2. A variant's `judges` replace the eval config's for that variant (`"judges": []` turns them off). The case's own judges still run.
3. When the case and the eval config (or the variant) list the same judge, the case's settings win: its `threshold`, `reference`, `reps` and options override the eval config's, and options it doesn't set keep the eval config's. Two entries are the same judge when results would give them the same name: a plugin judge's reference, or a rubric judge's built-in rubric (`correctness`), so two rubric judges stay apart.
4. `reference` defaults to the case's `expected.answer`, and `reps` to the case's `judgeReps`, then 1.

Every judge a case runs must pass. Scores are reported under the case's `judge` grader, with one entry per judge when there are several.

How far to trust a judge is measured, not assumed: label some trials and run [`mst judges check`](./cli.md#judges-check---measure-a-judge-against-labels). [Built-in judges on the calibration set](./judges.md) has the built-in judges' numbers on MST's calibration set, which are not a calibration for your data.

### Built-in judges

| Judge               | Asks                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rubric`            | An LLM scores the answer from 0 to 1 against a rubric: a built-in one (`correctness`, `completeness`, ...) or your own text.                                                                                 |
| `task-completion`   | Did the assistant do what the user asked, as the transcript shows? A success that no tool result supports fails; a result the transcript can't show is `unknown`. Uses the reference answer, if any.         |
| `grounded-in-tools` | Is every claim in the answer supported by a tool result in the transcript? Claims about what the assistant did count; general knowledge doesn't support a claim. Doesn't see the reference answer.           |
| `tool-use`          | Did the client call the tools the request needed, pass arguments that fit, avoid calls it didn't need, and recover from errors? Four questions, one model call each; any no fails. Doesn't grade the answer. |
| `criteria`          | Does the trial meet each of the case's own criteria? One model call per criterion; the case passes when every required one does. Uses the reference answer, if any.                                          |

`task-completion`, `grounded-in-tools`, `tool-use` and `criteria` are yes-or-no judges ([ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md)). Each reads the transcript: the request, each tool call with its arguments and result (cut to `maxToolOutputSize`), and the final answer. It answers yes (score 1), no (score 0) or `unknown`, when the transcript can't settle the question; `unknown` doesn't count as a pass, and the pass rate leaves it out. It answers `unknown` without a model call when the client didn't report its tool calls (evidence `none`), except `criteria`, whose criteria can be about the answer alone. When the judge can't read a verdict from a model's answer, it asks the same question once more, and a second unreadable answer is a judge error. An unreadable answer that was cut off at `maxTokens` is a judge error at once: the same limit would cut it off again. It takes the `rubric` judge's LLM settings (`provider`, `model`, `effort`, ...). Their questions are in [`src/judge/prompts/`](../src/judge/prompts/) (`taskCompletion.ts`, `groundedInTools.ts`, `toolUse.ts`, `criteria.ts`), and `mst label` shows them. They ask different things: an answer true to the wrong tool's result is grounded but doesn't do the task, and a right answer with one invented detail does the task but isn't grounded.

`tool-use` asks four questions, each in its own model call: `tool-choice`, `arguments`, `needed-calls` and `error-recovery`. It fails when any answer is no, and is `unknown` when none is no and one is `unknown`. Each question's answer is a sub-score, so the report shows which one failed. Each question leaves the others' ground alone. Which tool is `tool-choice`'s question, and what a call asks it for is `arguments`': reading the wrong file with a file-reading tool fails `arguments`, not `tool-choice`. A mistake the assistant corrects with a later call passes `arguments` and `error-recovery`; one it doesn't correct, such as an invalid argument it stops after, fails both. None of the questions grades the final answer; `error-recovery` reads it only to see whether the user was told of an error the assistant couldn't fix. A label for `tool-use` answers all four: `mst label` shows them together. It goes beside [`toolsTriggered` and `toolCallCount`](./assertions.md), which check named tools and counts without a model, and doesn't replace them.

```json
{
  "judges": [
    {
      "type": "task-completion",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    }
  ]
}
```

`criteria` checks the criteria a case lists in its `judges` entry, each `{ "id", "text", "required"? }`. It asks about each one in its own model call, wrapped in the question in `criteria.ts`, and fails when a required criterion's answer is no. A criterion with `"required": false` is reported and labeled but doesn't decide the pass. Each criterion is its own label question, `criteria#<id>`, with the criterion's text as the question `mst label` shows, and its own row in the report's _Judges_ table. Its identity covers only that criterion's `id` and `text` and the judge's settings, not `required`, so the same criterion in several cases is one question, labeled and calibrated together. A changed text is a new identity, so its calibration goes stale, but its labels stay with `criteria#<id>`: give a criterion whose meaning changes a new `id`, so that old labels don't answer it. When cases word one `id` differently, `mst label` shows each trial's text with it. Write a criterion as one thing a person could check in the trial, such as "The answer gives the port from the deployed config". An `id` starts with a letter or digit, then has letters, digits, `_`, `.` and `-`, and is unique in the list.

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

### The `preference` pairwise judge

`preference` is MST's built-in [pairwise judge](#pairwise-judges). It reads both trials of a case and asks which assistant better did what the user asked: A, B or tie. It weighs the final answer first (does it give the user what they asked for, correctly, as its tool results show?) and the tool use only when the answers are even. A claimed success its tool results don't show loses to an answer that says plainly what the assistant couldn't do. It shows the request and the reference answer once, then each trial's transcript and answer, and its prompt is in [`src/judge/prompts/preference.ts`](../src/judge/prompts/preference.ts).

MST asks it in both orders (`swapPositions`) and reconciles the two answers by majority, so a judge that only follows the order (A, then A again with the trials swapped) gives a tie, and `consistent: false`. In the run summary, the variant's `pairwise` summary has `consistency`: the share of cases where both orders agreed. A preference's reasoning comes from an order that gave it, the forward one first; reasoning from the swapped order says so, because there the candidate was A. A transcript the client didn't record, or recorded only in part, doesn't count against its run: the judge compares what each transcript shows, and judges such an answer by what it says and the reference answer. Without a reference answer, nothing can show such an answer is right, so it can lose or tie to one that says plainly what the assistant couldn't do: give cases a reference when you compare a client that doesn't report its tool calls. It takes the `rubric` judge's LLM settings, and `reference: false` hides the reference answer. An unreadable answer is asked again once, as for the yes-or-no judges. List it once in `pairwiseJudges`: a comparison's preferences and labels are keyed by the judge's type, so a second entry of the same type is an error. A label for it is a preference, labeled with `mst label --judge preference` and checked with `mst judges check`.

```json
{
  "pairwiseJudges": [
    {
      "type": "preference",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    }
  ]
}
```

### Pairwise judges in an eval config

`pairwiseJudges` lists [pairwise judges](#pairwise-judges) at the eval config's top level (or in a shared config, not on a variant): the built-in `preference`, references `<namespace>/pairwise-judge/<name>`, or `{ "type": <reference>, "reps": 2, ...options }`. Validation checks that each plugin judge exists in a plugin the eval loads, and that each judge's schema takes the options.

After every variant has run, MST compares each variant with the baseline (the first, or the one `baseline` names), case by case, with `comparePairwise`. The result is the variant's `pairwise` in the run summary: a preference per case and judge, and per judge the wins, losses, ties and `candidateWinRate`. The baseline has none. When `--variant` leaves the baseline out, MST skips pairwise and prints a note. Pairwise judge usage counts in the telemetry's `totalJudgeUsage`, and on its own in `pairwiseJudgeUsage`. `mst run` prints each judge's win, loss and tie rates. A case that errored in either variant isn't compared. With several trials, the judge compares each variant's last trial of the case. A pairwise judge that fails to start is reported and the run keeps its results. Tool optimization rounds don't run pairwise judges.

## Metrics

Every variant in the run summary has `metrics`. They include, when the client reports them:

- `passed_rate`: the share of cases that passed.
- `trial_pass_rate`: the share of trials that passed, averaged over cases.
- `tool_count_mean`, `mcp_call_count_mean` and `builtin_event_count_mean`: per trial, every tool call; MCP tool calls; and the client's own events (built-in tools, skills, commands, subagents, tool searches). A built-in tool call counts in both `tool_count` and `builtin_event_count`; another built-in event (a skill load, command, subagent or tool search) counts only in `builtin_event_count`; a skill an MCP server serves counts in neither.
- `tool_search_hit_rate`, for clients that search their tool catalog: the share of trials where an MCP call was to a tool an earlier search returned. It doesn't check that the tool was the one the case expected; `toolsTriggered` does.
- `input_tokens_mean`, `output_tokens_mean` and `cost_usd_mean`: usage and cost per trial.
- `duration_s_mean`: time per trial.
- `judge_pass_rate` and `judge_score`, for cases with judges.

A trial is one run of a case: one trial, or the case itself when it runs once. A case passes when its trials reach its `passThreshold` (1 by default), so two variants whose cases pass 60% and 100% of the time report a `passed_rate` of 0 and 1. `trial_pass_rate` reports 0.6 and 1.

An eval config's or variant's `metrics` list adds more. Built-in names:

| Metric                                                                                                 | Reports                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `passed`, `trial_pass`                                                                                 | The share of cases, and of trials, that passed.                                                                 |
| `tool_count`, `mcp_call_count`, `builtin_event_count`, `first_tool`, `is_no_action`                    | Tool calls and client-native events in the transcript. MCP calls are named `server.tool`.                       |
| `input_tokens`, `input_tokens_uncached`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Client token usage. `input_tokens` includes cache reads and writes.                                             |
| `cost_usd`                                                                                             | Client-reported cost, or an estimate from the eval config's `pricing`.                                          |
| `duration_s`, `duration_api_s`                                                                         | Wall time, and API time when the client reports it.                                                             |
| `response_success`, `response_len`, `response_words`                                                   | Trials without a client error, and the answer's length.                                                         |
| `skill_loaded`, `skill_before_tool`, `skill_verification_failed`                                       | Agent Skills loads.                                                                                             |
| `tool_search_hit`                                                                                      | Trials where a tool search returned a tool the trial then called.                                               |
| `judge_pass`, `judge_score`, `judge_name`, `judge_pass_for`, `judge_score_for`                         | Judge scores, from the case's last trial.                                                                       |
| `write_case_passed`, `write_evidence`, `unreported_writes`, `unrecorded_writes`, `unclassified_calls`  | Write cases' pass rate and the weakest evidence it rests on, and the write record's counts ([Writes](#writes)). |

- **Per trial.** Usage, timing, tool and answer metrics are measured per trial. A case's value is the mean over its trials, and a variant's is the mean over its cases (`<name>_mean`, or `<name>_rate` for shares). `first_tool` lists the first tool of each case's first trial. Runs that failed on infrastructure, such as a network error or a client that couldn't start, aren't trials, as they don't count toward accuracy.
- **How an attempt ended.** Each trial record has an `ending` ([ADR 0010](./adr/0010-a-trial-ending-is-decided-where-it-ends.md)): `{ "kind": "trial" }`, graded as usual even when the client errored or ran out of its own turns, time or context, or `{ "kind": "infrastructure", "broke", "retryable", "reason" }`, where `broke` is what failed around the client: `client-app`, `workspace`, `network`, `provider`, `collection`, `deadline` or `setup`. `infrastructureError` is still written, derived from it. A run stored before `ending` gets one from its old fields when it's read, and keeps the classification it was recorded with, except an ungraded trial, which is a trial.
- **Incomplete cases.** A case short a trial (one ended in an infrastructure failure) or with an ungraded trial is incomplete: neither passed nor failed, and left out of `passed`, `failed`, the pass rates and their comparisons until it's completed. A variant's `result.total` (and `runEvalDataset`'s) still counts it, so `passed === total` only when every case passed; the run summary's `metrics.total` counts complete cases. Its trials still count toward per-trial measurements such as tool calls, duration and usage. `metrics.incomplete` counts them, and `mst run` says what finishes them: `mst run --resume` for an infrastructure failure a retry can help, a fix to the eval, the case or the setup for one it can't, and `mst grade --resume` for an ungraded trial.
- **Unavailable, not zero.** A metric with no value for any case is left out of `metrics`; if the eval config lists it, it's also in the variant's `unavailableMetrics`. A client that reports no cost has no `cost_usd` unless the eval config prices its model. A client whose evidence is `none` has no tool metrics.
- **Evidence.** A variant's `evidence` is the weakest among its cases (`none`, then `observed`, then `structured`). With `observed`, tool metrics come from a best-effort transcript; compare them only between variants with the same evidence.
- **Deltas.** `variantDeltas` compares each variant with the first: `passRate`, `trialPassRate` and their deltas, and `metricDeltas`, the change in every numeric metric both variants report (`metricDeltas.input_tokens_mean`, say), with `judge_score` per judge.
- **In the CLI.** `mst run` prints a row per variant: cases passed, trial pass rate, judge pass rate when there are judges, MCP calls and client events, tokens, cost and time.
- **Run totals.** The summary's top-level `total`, `passed`, `failed` and `passRate` count every variant; its other metrics are the first variant's.

### Pricing

Most clients report tokens but not cost. An eval config (or a plugin's shared config) can price them, in USD per million tokens, by the model each case runs:

```json
"pricing": {
  "claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
}
```

MST ships no prices; they change too often to bake in.

- **Reported cost wins.** A cost the client reports is always used. Estimates are kept apart as `estimatedCostUsd` in each case's usage, `cost_usd` uses whichever there is, and the variant's `costSource` says which (`client`, `pricing` or `mixed`).
- **Which model.** A case is priced at its own `model`, else the variant's or eval config's `model` (including a client's default). A model the client picks at run time isn't known to MST, so set `model` to price it.
- **Auditable.** Each variant records the prices it used in `pricing`, and models it couldn't price in `unpricedModels`; `cost_usd` leaves their trials out.
- **Shared configs.** An eval config's `pricing` replaces a shared config's whole table; the two aren't merged.

### Compared with the previous run

Every run has a `runId`. Its summary's `previousRun` compares it with the previous run of the same eval config that ran the same variants, when there is one:

- **Which run.** The eval config's `name` identifies it, so two eval configs with the same name share a history. With a result store, the previous run is the store's newest comparable run of that eval config. Without one, it's the newest earlier run in the eval's `runs/` directory (under `--output-dir`, by default `.mcp-test-results/<name>/`), read from its `summary.json` and `results.json`.
- **The test.** Each variant's `change` is the paired test the report's variant comparisons use, on the variant's headline cases (capability cases, or regression cases when every case is tagged `regression`): the mean per-case change, its 95% range and `assessment` (`better`, `worse` or `unclear`). The report and `mst run` show a change only through it, and show none when `sameConfig` is false.
- **Output.** `mst run` prints each variant's tested change and the regressed, improved, added and removed cases.
- **Best effort.** A previous run that can't be read is skipped with a warning; it never fails the run.

```json
"previousRun": {
  "runId": "20261007T182504Z-a3f9c1",
  "timestamp": "2026-10-03T18:02:11.000Z",
  "sameConfig": true,
  "passRate": 1,
  "passRateDelta": -0.5,
  "variants": {
    "default": {
      "passRateDelta": -0.5,
      "trialPassRateDelta": -0.1,
      "change": {
        "mean": -0.1,
        "lower": -0.32,
        "upper": 0.12,
        "cases": 10,
        "pBetter": 0.94,
        "pWorse": 0.25,
        "assessment": "unclear"
      },
      "regressed": ["billing-owner"],
      "improved": [],
      "added": [],
      "removed": []
    }
  }
}
```

`sameConfig` is false when the eval config changed between the runs, so a difference may come from the configuration rather than the server: the report and `mst run` then show no change. Datasets aren't part of that hash.

### The eval's history

Every run updates the eval's `history.json` (format `mst.history/v1`, schema in [`schema/history/v1/`](../schema/history/v1/history.schema.json)): a row per run, newest first, with what the run ran with and what each variant measured. `mst history` prints it, and the [history page](./ui-reporter.md#the-history-page) (`history/index.html`, `mst open --history`) charts it. A result store has its own, beside its `latest.json`, built from the store's runs, so a CI machine's history isn't only its own runs.

- **What a row has.** The run's ID, when its transcripts were collected, its status (`complete`, `incomplete`, `ungraded`, `failed`), whether it was partial and how it was narrowed, the eval config's `configId` and `contentHash`, MST's version, the datasets (with their content hashes and snapshots), every case ID and a hash of them, the eval config's judges (with their identities), and per variant: its client, model, servers, the client apps its trials recorded, and a hash of its setup. Per variant it measures the case and trial pass rates, the headline pass rate with its likely range, each judge's pass rate and mean score, each pairwise judge's wins, ties and losses against the baseline with the win rate's 95% Wilson range (a tie counts as half a win), cost per trial with its `costSource` and `unpricedModels`, tokens per trial (input, output, cache reads and writes), the median and 95th percentile of trial time, tool and MCP calls per trial, infrastructure failures and client errors, and each complete case's passed and counted trials.
- **Eras.** Consecutive full runs that measured the same way are one era. These start a new era for every variant, including one that skipped the run where it changed:
  - the datasets changing (cases added or removed, a case edited, another snapshot);
  - the eval config's judges changing (one added, removed, or with another judge identity);
  - a plugin the eval loads changing version or settings (`run.json`'s `plugins`; one added or removed is noted, since a client or judge it brings or takes away changes the setup anyway);
  - `simulateWrites` changing (writes answered with a success reply instead of a planned-write result).

  A variant's own setup changing starts one for it: its client, model, client options, a server under the same label, tool metadata, input template, judges, a server's write mode, or the identity its judge scores record in a case, against the one the case last had in the era (a case judge's too, whose version, options or plugin settings changed). A run whose client failed in a case gave it no verdict, so it changes nothing there. A server counts as `run.json` records it: an HTTP server's URL without its credentials, query or fragment; a stdio server's command, without its arguments or environment, which can hold credentials; a connector server's connector and URL (the declared one, or else the connector's default), without its credentials, query or fragment. A change to what isn't recorded doesn't show. Each row lists what changed since the previous full run, and whether it ends the era. A client app's version, MST's version, the trials per case and the eval config's hash are noted but don't: a weekly run of the same eval on a new client build is what the history is for.

  A client option that looks like a credential is in `run.json` only as a keyed hash (`hmac:…`). The key is the eval's: `MST_OPTION_KEY` (64 hex digits, as `openssl rand -hex 32` prints) when set, else `option-key` in its results directory (beside `latest.json`, in no run or result store), made by the eval's first run that writes anything. So the eval's runs record the same value as the same hash, and a changed value starts an era. `run.json`'s `optionKey` is a fingerprint of the key, which says nothing about it. Hashes under another key can't show the value stayed the same, so they count as changed (`client options hashed under another option key`): on CI, or wherever runs are collected on several machines, give each the same `MST_OPTION_KEY` from a secret. `--detach` sends the coordinator the key of the machine that started the run, over its channel. Runs from MST 2.0.0-rc.0 and earlier have no `optionKey`: each hashed under its own key, so between them only an option's name counts. Don't commit or upload `option-key`; delete it to start a new key.

- **Since previous.** Each variant's change since the previous run of its era that was complete for it (collected and graded, none of its cases incomplete) is the paired test `mst run` reports against its previous run, on the headline cases, with the cases that regressed and improved. `regressed` is true when that test says worse. A run in a new era has none: old runs are never hidden, and never compared across an era's start.
- **Partial runs** (`--variant`, `--case`, …) have rows, marked `partial` with their selection, but no era and no change: they're never compared with full runs. Ungraded and failed runs have rows without pass rates. A run with incomplete cases is on the line, but no later run is compared with it for the variants whose cases were incomplete. Tool optimization runs aren't in the history.
- **Regrades.** A regrade (`<run-id>.g2`) is a row of its own, ordered by when its transcripts were collected. A collection's newest grading that finished grading is the one shown; the gradings it replaces have `supersededBy`. A regrade with a new judge belongs to the new judge's era. A regrade records what collected its transcripts as its source run recorded it (servers, client, model, client options with their hashes and key, tool metadata, input template and plugins), so it compares like its source, whichever machine graded it.
- **A cache of the runs.** Each row is built from the run's `run.json`, `summary.json` and `results.json`, and kept until the run's `run.json` changes (a resumed run) or a newer MST builds rows differently. `mst history --rebuild` builds every row again. The file is replaced in one step. Two runs can finish at once, and a store can't lock, so after writing it MST lists the runs again and writes once more if one appeared; a history that still misses a run gets it at the next write or `mst history`.
- **Old runs.** A run in an older format is listed in `skipped` with why. Fields a run's MST didn't record (judge identities, client apps, plugins) are left out of its row. The Playwright reporter's runs don't record plugins either: they run the `api` client, and their plugin judges' identities cover the plugin's version.

## CLI

```bash
npx mst run \
  --config ./eval.json \
  --plugins ./plugins \
  --variant concise \
  --dry-run

npx mst batch \
  --config-dir ./configs \
  --workers 4 \
  --skip-existing \
  --dry-run
```

`--dry-run` validates the eval configs and loads their plugins without running
anything; `run --dry-run` prints the eval config's name, output directory, datasets, variants and runner as JSON (see [`run`](cli.md#run---run-an-eval-config)).
Without it, `run` runs the eval config's variants and `batch` runs each listed
eval config.

## Ownership boundary

The framework owns generic loading, extension lookup, execution, metrics,
result storage, and summaries. Consumers own organization-specific datasets,
judges, connector configuration, secrets, schedules, CI, and deployment.
Secrets remain environment-variable or plugin-owned runtime inputs; they do not
belong in committed eval configs.
