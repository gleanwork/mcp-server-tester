# Evaluation framework contract

`mcp-server-tester` is the generic evaluation engine. Organization-specific
schemas, judges, hosts, dataset loaders, and result destinations are plugins.
A developer should be able to run a complete evaluation with local datasets,
built-in hosts and judges, and a local result store.

## Manifest

The editor-facing contract lives in
[`schema/eval-manifest.schema.json`](../schema/eval-manifest.schema.json), and
runtime validation is provided by `EvalManifestSchema`.

```json
{
  "name": "tool-selection-search",
  "datasets": [
    {
      "type": "file",
      "path": "evalsets/search.json"
    }
  ],
  "servers": [
    {
      "transport": "http",
      "serverUrl": "https://example.com/mcp",
      "label": "prod"
    }
  ],
  "client": "mst",
  "clientOptions": {
    "provider": "anthropic"
  },
  "metrics": ["passed", "tool_count"],
  "results": {
    "store": {
      "type": "file",
      "dir": ".mcp-test-results"
    }
  },
  "arms": [
    {
      "name": "baseline"
    },
    {
      "name": "variant",
      "servers": [
        {
          "transport": "http",
          "serverUrl": "https://example.com/mcp-v2",
          "label": "variant"
        }
      ]
    }
  ]
}
```

A key the schema doesn't define is an error, in a manifest and in a dataset, so a misspelling fails instead of being ignored. So is a setting the selected client can't honour, such as `toolOverrides` for a client that doesn't present tool variants. `--dry-run` reports all of these, including in datasets.

- **Run controls** (`trials`, `maxCases`, `concurrency`, `filterTags`, `passThreshold`) go at the top level or under `run`.
- **Client defaults:** `model`, `provider`, `maxToolCalls`, `timeout`, `temperature` and `maxTokens` default each client option of that name, for the clients that take it.
- **The client:** `client` names the client under test, `model` the model it uses, and `clientOptions` the client's other options. An arm or case may set any of the three; it inherits the manifest's `clientOptions` only when it uses the same client.

A bare dataset path is shorthand for `{ "type": "file", "path": "..." }`. Relative dataset and plugin paths in a manifest resolve against the manifest's directory, then `rootDir` (`--root-dir`, the working directory by default). A `file` result store's `dir` is always relative to the manifest, so where results are written doesn't depend on the working directory. Plugin result stores resolve their own options.
Every other pluggable block is a tagged object. `servers` is the complete MCP
server set under test; an empty set is valid for hosts that provide their own
capabilities.

## Plugins

Dataset sources, hosts, judges, metrics and result stores are extensions. Each one owns its tagged-config schema; core doesn't know organization-specific options. ADR [0001](adr/0001-eslint-style-declarative-plugins.md) records why plugins take this shape.

A plugin is a plain object, the default export of its module or package, in the shape [ESLint plugins](https://eslint.org/docs/latest/extend/plugins) use. MST reads it; a plugin never calls into MST to register.

```ts
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const plugin: Plugin = {
  meta: { name: '@acme/mst-plugin', version: '1.0.0', namespace: 'acme' },
  datasetSources: {
    legacy: { schema: LegacySchema, load: loadLegacyDataset },
  },
  judges: {
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async ({ case: c, trial }, options) => ({ score: 1 }),
    },
  },
  // Also: hosts, metrics, resultStores.
  configs: {
    recommended: {
      judges: ['acme/completeness'],
      trials: 3,
    },
  },
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Manifests and datasets reference it as `namespace/name`, such as `{ "type": "acme/legacy" }` or `passesJudge: { "judge": "acme/completeness" }`. Built-ins (`file`, `claude-code`, `rubric`, `passed`, ...) use bare names, which plugins can't take.
- **Namespace.** `meta.namespace` is required: lowercase, optionally scoped as `@scope/name`. Two different plugins can't share a namespace. Loading the same plugin again is a no-op, including a rebuilt object with the same name, version, extension definitions and configs. A plugin factory that builds differently configured copies needs a namespace per copy. A package's CommonJS and ESM builds are different objects too, so load a plugin one way; publishing plugins as ESM avoids the question.
- **Loading.** A manifest lists plugin specifiers in `plugins`. Each one resolves relative to the manifest's directory, then `rootDir` (`--root-dir`, the working directory by default), then as a package name, resolved as `import` resolves it. `--plugins` and the `pluginPaths` / `plugins` options of `runEvalSuite` and `runEvalBatch` add to that list. Code that runs datasets directly passes plugin objects: `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `test.use({ mcpPlugins: [plugin] })` in Playwright. Code that calls validators or matchers on its own installs them with `installPlugins([plugin])`.
- **Scope.** A manifest may only reference namespaces of plugins it loads, even if another suite in the same process (a batch) loaded more. The same check applies to the hosts and judges its datasets name. `runEvalDataset`, `runEvalCase` and the fixtures have no manifest, so they resolve against every plugin installed in the process.
- **Contracts.** Each extension has a Zod `schema` for its options and the functions its kind needs: `load` (dataset sources), `run`, `runBatch` or `createConfig` (hosts), `evaluate` (judges), `kind` and `compute` (metrics), and `create` (result stores). MST validates the plugin when it loads, and names the plugin and extension in any error.
- **Shared configs.** `configs` holds named manifest settings a suite can opt into. A suite that loads the plugin applies one with `"extends": ["acme/recommended"]`:

  ```json
  {
    "name": "acme-suite",
    "plugins": ["@acme/mst-plugin"],
    "extends": ["acme/recommended"],
    "datasets": ["./cases.json"],
    "trials": 5
  }
  ```

  A config is typed `PluginConfig` and can set any documented manifest key except `name`, `datasets`, `arms`, `plugins` and `extends`. Other keys, including `run`, are rejected when a manifest extends the config; until then MST only checks that it's an object. Configs apply in order, then the manifest's own settings, including its `run` controls. Each top-level key is replaced, never merged: here the manifest's `trials` replaces the config's, and a manifest `judges` list would replace the config's list rather than add to it. A config may use only its own plugin's extensions and built-ins, and can't extend other configs. MST has no built-in configs. A suite's `contentHash` is computed with its configs applied, so `runEvalBatch` doesn't resume a saved run after a config changes. Code that validates a manifest itself applies `extends` first with `resolveManifestExtends` (from `./evals`).

- **Judges.** A judge's `evaluate({ case, trial }, options)` returns a verdict with `score` from 0 to 1 ([Judge contract](#judge-contract)). MST parses `options` with the judge's schema, calls `evaluate` once per `reps`, and compares the mean score with the assertion's `threshold`. The schema sees only the judge's own options, never `threshold`, `reference`, `reps` or a manifest entry's `type` and `name`. The built-in `rubric` judge has the same contract, and a manifest can list it: `judges: [{ "type": "rubric", "rubric": "correctness" }]`.

Plugins load before manifest validation, so validation can check every reference and schema.

### Judge contract

A judge is called as `evaluate({ case, trial }, options)`, once per `reps`:

- `case` (`JudgeCase`) is the case as written in the dataset, the same for every run:
  `id`, `input` (`prompt`), `expected`, `tags`, `metadata`.
- `trial` (`JudgeTrial`) is one observed run: `response` (what validators grade),
  `text`, `events` (tool calls and other host events), `messages` (when the host
  reports them), `evidence`, and host `usage`.
- `options` is the judge's own settings, parsed by its `schema`.

The threshold is not in the input. MST compares the mean score with it,
unless the judge returns its own `pass`; over several reps, the majority of
those verdicts decides, and a tie fails.

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

A judge returns a `JudgeVerdict`. Only `score` (0 to 1) is required:

| Field               | Effect                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pass`              | The judge's own verdict. Without it, the case passes when the mean score meets the threshold.                    |
| `skipped`           | The judge cannot grade this case. It doesn't count for pass/fail or judge metrics; the remaining reps don't run. |
| `subScores`         | Named sub-scores, such as one per criterion: `{ [key]: { score, pass?, reasoning? } }`.                          |
| `usage`             | The judge's own token usage and cost, summed over reps.                                                          |
| `provider`, `model` | Reported as `judgeProvider` and `judgeModel`.                                                                    |
| `metadata`          | Other JSON output, kept in the result.                                                                           |

A score or sub-score outside 0 to 1 is an error, not a verdict. When every
judge of a case skips, the judge expectation passes.

Judge usage is kept apart from host usage: `judgeUsage` on each case and
trial, `totalJudgeUsage` on the run and suite telemetry, and the
`judge_cost_usd`, `judge_input_tokens`, and `judge_output_tokens` metrics.
The built-in `rubric` judge reports its usage the same way.

### Pairwise judges

A pairwise judge compares two runs of the same case, a baseline and a
candidate, and says which is better. It is a separate extension kind,
`pairwiseJudges`, because a preference is not a score against a threshold:
pointwise judges decide whether a case passes, pairwise judges decide which
arm did better.

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

`baseline` and `candidate` are `JudgeTrial`s, so a judge reads text, host
events (tool calls and their output), and evidence the same way a pointwise
judge does.

`comparePairwise({ baseline, candidate, judges, cases? })` runs the listed
judges on every case both runs have, matched by id. The runs can be two arms
of one suite, a run and a stored baseline, or runs made on separate machines.
Pass `cases` (dataset cases by id) when judges need ground truth that results
do not carry.

- Each judge runs each case in both orders, and the swapped verdict is mapped
  back, to cancel position bias. A verdict whose two orders disagree is
  reported with `consistent: false`. A judge that debiases itself sets
  `swapPositions: false`.
- `reps` repeats each order; the majority preference wins, ties break to tie.
- A skipped comparison or a judge error is recorded on the case, not counted
  as a preference.
- The summary reports, per judge, wins, losses, ties, `candidateWinRate`
  (wins plus half the ties, over compared cases), order `consistency`,
  per-dimension win rates, and judge usage.

### Dataset sources

The built-in `file`, `dir` and `gcs` sources read canonical `EvalDataset` JSON only. They don't infer expectations from a first case, attach hosts or add judges, and they reject fields they don't know, on every case. A minimal dataset needs a name, a case ID and an input:

```json
{
  "name": "search-regression",
  "cases": [{ "id": "search", "input": "Find the Q3 planning doc" }]
}
```

`dir` reads every `.json` file in the directory (subdirectories too with `"recursive": true`), validates each the same way, and merges their cases into one dataset named after the directory. `gcs` needs the optional `@google-cloud/storage` package and Application Default Credentials that can read the object.

Datasets in another schema need a dataset source in your own plugin that converts them. The conversion policy (default trials, pass thresholds, which judges a case gets) belongs to that source, not to MST:

```typescript
import {
  loadEvalDatasetFromObject,
  type Plugin,
} from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const MySourceSchema = z
  .object({ type: z.literal('my/format'), path: z.string().min(1) })
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
          context.manifestDir ?? context.rootDir
        );
        return loadEvalDatasetFromObject(convertToCanonical(raw));
      },
    },
  },
} satisfies Plugin;
```

A manifest that loads the plugin declares `{ "type": "my/format", "path": "..." }` in `datasets`. Select the format in the declaration rather than inferring it from a first case, and fail on fields the source can't map instead of dropping them.

### Clients

The client is the MCP client application an eval tests. Built-in clients have canonical names; how MST drives one (a CLI, desktop automation, an SDK) isn't part of its name:

| Client        | What it is                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | Claude Code                                                                                                           |
| `cowork`      | Claude Cowork, in Claude Desktop (macOS, or a prepared Linux desktop)                                                 |
| `chatgpt`     | ChatGPT desktop; macOS or Linux follows the platform                                                                  |
| `mst`         | MST's own client: the model gets the servers' tools and nothing else, which isolates the model and your tool metadata |

Set the model beside the client. The `mst` client infers which API serves it from the model id (`claude-*`, `gpt-*`, `gemini-*` and so on; a `claude-*@date` id is Vertex). Set `provider` only to override that, for example to route through Vertex or a gateway.

A client runs one input and returns its trace. It doesn't repeat cases, run judges or decide pass/fail; `runEvalDataset` does that for every client. A plugin client is the way to add one: plugins contribute them under `clients`. The built-in desktop drivers are composed from internal capabilities, which plugins can't provide.

```typescript
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

export default {
  meta: { name: 'my-mst-plugin', namespace: 'my' },
  clients: {
    assistant: {
      schema: z.object({ type: z.literal('my/assistant') }),
      evidence: 'observed',
      async run(input, config, context) {
        // input.prompt and input.servers are the unit of execution.
        return { finalText: 'Answer from the assistant', events: [] };
      },
    },
  },
} satisfies Plugin;
```

A manifest that loads the plugin selects the client with `"client": "my/assistant"`, and passes its options in `clientOptions`.

- **The trace.** `run` returns a `ClientRunResult`: `finalText`, `events`, and optional `usage`, `error` and timing fields. Each event has a `kind` (`tool_call`, `skill`, `command`, `subagent` or `tool_search`), a `source` (`mcp` or `host`), a `name`, and optionally the MCP server label, arguments, output and ID. Record what the host did; don't reconstruct tool calls from the final text. A `tool_search` event (the host searching its tool catalog) lists the tools the search returned in `results`, each `{ name, server? }`. Type host-native actions as their kind rather than as calls to a host tool, so skill expectations and search metrics can read them.
- **Evidence.** Declare `evidence: 'structured'` only for authoritative protocol or host-native traces. With `observed`, `none` or no declaration, tool-call and argument assertions can't pass; text and judge assertions still run.
- **Servers.** Events keep their MCP server labels. With more than one server, tool assertions use label-qualified names, or the manifest's `toolMap` from canonical to native names.
- **In results.** Each host case result keeps the trace as `trace`, a `Trace`: the `ClientRunResult` your host returned, without telemetry and diagnostics, plus its evidence. On a one-server arm, MCP events that name no server get that server's label. A case with several trials has no `trace` of its own; each entry in `iterationResults` has the trace of that trial. In a suite, every case result also names its `arm`. Stored results drop `finalText` and each event's `output`, the same way they drop `response`; events, servers, arguments and usage stay.
- **Batches.** A host with `runBatch` gets one request per trial of each host case in the dataset, and returns one trace per request, in order. A batch host can't mix host types, and its cases need unique IDs.
- **Settings only.** `createConfig` returns settings for MST's own SDK or CLI host instead of running anything.
- **Tool variants.** A host that connects to the servers in `input.servers` gets an arm's `toolOverrides` with no work of its own: the suite gives it `http` server configs for a local MCP proxy that applies the variant, so the host must speak Streamable HTTP (see [Tool variants on every host](#tool-variants-on-every-host)). A host that applies variants itself sets `toolOverrides: true` and reads them from `context.arm`. `buildToolSurface(listed, variant)` from `./evals` applies a variant with MST's rules (keys, renames, collisions), and `resolve(name, server)` maps a presented name back to the original tool. Record a renamed tool's calls under `originalName`, with the model's name in `rawName`, as MST's hosts do. A batch host that connects to one server set for the whole batch (the first request's `input.servers`) sets `serversPerBatch: true`, and the batch shares one proxy endpoint. A proxied request also carries `input.checkServers`: the same servers on an endpoint for the host's own checks, such as a readiness probe, so that traffic isn't taken for the model seeing the variant. A host that connects elsewhere (hosted connectors, say) sets `toolSurfaceProxy: false`; a manifest that gives it `toolOverrides` then fails validation.
- **What it honours.** `maxConcurrency` caps the manifest's `concurrency`.

### Claude Code host-native events

The Claude CLI and Cowork hosts read Claude Code transcripts, where skills, commands, subagents and tool search are calls to host tools. They are recorded as typed events:

| Claude Code tool | Event                                                  |
| ---------------- | ------------------------------------------------------ |
| `Skill`          | `skill`, named for the skill it loaded                 |
| `SlashCommand`   | `command`, named for the command                       |
| `Task`, `Agent`  | `subagent`, named for the subagent type                |
| `ToolSearch`     | `tool_search`, with the tools it returned in `results` |

A search's `results` come from `tool_reference` blocks in its result, or, without them, from `mcp__<server>__<tool>` names in its text. This format is inferred rather than taken from recorded `ToolSearch` traces; if `tool_search_hit_rate` reads 0 where searches clearly worked, check the search's `output` in the trace. Other host tools (`Bash`, `Read`) stay tool calls with `source: 'host'`.

### System prompts

`systemPrompt` adds text to a host's system prompt, such as an organisation's instructions. To measure what it changes, give one arm the prompt (an arm inherits the manifest's `clientOptions` when it uses the same client):

```json
"arms": [
  { "name": "no-prompt" },
  { "name": "org-prompt", "clientOptions": { "systemPrompt": "For actions in a connected app, call find_skills first." } }
]
```

- **`mst`** puts it in the model's system prompt, ahead of the skills catalog when `skills` is on.
- **`claude-code`** passes it with `--append-system-prompt`, so Claude Code's own system prompt stays.
- **Cowork and ChatGPT** take organisation instructions from the app, not from MST, so `systemPrompt` is a validation error for them.

A plugin client that can apply one declares `systemPrompt` in its schema. A case's own `clientOptions.systemPrompt` replaces the one it inherits, and is a validation error for a client that can't apply one.

### Tool variants on every host

An arm's `toolOverrides` (descriptions, input schemas, renames) reach every host:

- **`mst`** applies the variant in-process.
- **Hosts that connect to their servers** (plugin hosts, `claude-code`, `cowork`) get them through a local MCP proxy. The suite starts it on first use and gives each host request its own loopback Streamable HTTP endpoints, one per server, with the servers' labels and timeouts. The proxy presents the variant's tools and sends calls to a renamed tool to the original. Other requests (resources, prompts, skills) pass through; notifications, such as list changes and progress, don't.
- **One connection per server for the arm.** The proxy connects to each server once and shares that connection across the arm's cases, where a host without a variant may connect per case. A server that keeps per-connection state sees one connection in a variant arm.
- **A request whose host never lists the proxied tools fails.** Otherwise the run would report results for a variant the model never saw. Cowork sets up its servers once per batch, so it lists them once: the batch shares one endpoint, and the check is for the batch. MST's own readiness probe uses a separate endpoint and doesn't count.
- **Calls are recorded under the tools' original names**, so a dataset's expectations read the same in every arm, with the model's name in `rawName`.

The ChatGPT desktop client opts out until it is verified with the proxy, so a manifest that gives it `toolOverrides` fails validation.

## Execution lifecycle

```text
EvalManifest
  -> load the suite's plugins (built-ins are always available)
  -> validate tagged blocks, extension names and namespaces, schemas, and server labels
  -> resolve DatasetSource entries into EvalDataset values
  -> derive one or more arms from the manifest
  -> run each arm through its Host (built-in or plugin) with its MCPConfig[] server set
  -> compute metrics and judges
  -> write per-arm results through the ResultStore
  -> save a RunSummary with manifest identity, content hash, arm aggregates,
     pairwise arm deltas, and per-case artifact pointers
```

`EvalDataset`, `EvalCase`, `MCPConfig`, and `runEvalDataset` remain
the canonical case and execution primitives. The suite layer composes them; it
does not replace them with a second case model.

## Arms

An arm is a patch over the manifest defaults. Arms replace separate A/B and
variant-experiment concepts. An arm may change its server set, client, model, client options,
tool-name map, input template, metrics, or judges. A manifest without arms
has one implicit `default` arm.

Each `MCPConfig` may have a `label`. Labels are required when a server set has
more than one entry so traces and metrics can attribute MCP calls correctly.

## Metrics

Every arm in the run summary has `metrics`. They include, when the host reports them:

- `passed_rate`: the share of cases that passed.
- `trial_pass_rate`: the share of trials that passed, averaged over cases.
- `tool_count_mean`, `mcp_call_count_mean` and `host_event_count_mean`: per trial, every tool call; MCP tool calls; and host-native events (host tools, skills, commands, subagents, tool searches). A host tool call counts in both `tool_count` and `host_event_count`; a typed host event (a skill load, command, subagent or tool search) counts only in `host_event_count`; a skill an MCP server serves counts in neither.
- `tool_search_hit_rate`, for hosts that search their tool catalog: the share of trials where an MCP call was to a tool an earlier search returned. It doesn't check that the tool was the one the case expected; `toolsTriggered` does.
- `input_tokens_mean`, `output_tokens_mean` and `cost_usd_mean`: usage and cost per trial.
- `duration_s_mean`: time per trial.
- `judge_pass_rate` and `judge_score`, for cases with judges.

A trial is one run of a case: one trial, or the case itself when it runs once. A case passes when its trials reach its `passThreshold` (1 by default), so two arms whose cases pass 60% and 100% of the time report a `passed_rate` of 0 and 1. `trial_pass_rate` reports 0.6 and 1.

A manifest's or arm's `metrics` list adds more. Built-in names:

| Metric                                                                                                 | Reports                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `passed`, `trial_pass`                                                                                 | The share of cases, and of trials, that passed.                                    |
| `tool_count`, `mcp_call_count`, `host_event_count`, `first_tool`, `is_no_action`                       | Tool calls and host-native events in the trace. MCP calls are named `server.tool`. |
| `input_tokens`, `input_tokens_uncached`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Host token usage. `input_tokens` includes cache reads and writes.                  |
| `cost_usd`                                                                                             | Host-reported cost, or an estimate from the manifest's `pricing`.                  |
| `duration_s`, `duration_api_s`                                                                         | Wall time, and API time when the host reports it.                                  |
| `response_success`, `response_len`, `response_words`                                                   | Trials without a host error, and the answer's length.                              |
| `skill_loaded`, `skill_before_tool`, `skill_verification_failed`                                       | Agent Skills loads.                                                                |
| `tool_search_hit`                                                                                      | Trials where a tool search returned a tool the trial then called.                  |
| `judge_pass`, `judge_score`, `judge_name`, `judge_pass_for`, `judge_score_for`                         | Judge verdicts, from the case's last trial.                                        |

- **Per trial.** Usage, timing, tool and answer metrics are measured per trial. A case's value is the mean over its trials, and an arm's is the mean over its cases (`<name>_mean`, or `<name>_rate` for shares). `first_tool` lists the first tool of each case's first trial. Runs that failed on infrastructure, such as a network error or a host that couldn't start, aren't trials, as they don't count toward accuracy.
- **Unavailable, not zero.** A metric with no value for any case is left out of `metrics`; if the manifest lists it, it's also in the arm's `unavailableMetrics`. A host that reports no cost has no `cost_usd` unless the manifest prices its model. A host whose evidence is `none` has no tool metrics.
- **Evidence.** An arm's `evidence` is the weakest among its cases (`none`, then `observed`, then `structured`). With `observed`, tool metrics come from a best-effort trace; compare them only between arms with the same evidence.
- **Deltas.** `armDeltas` compares each arm with the first: `passRate`, `trialPassRate` and their deltas, and `metricDeltas`, the change in every numeric metric both arms report (`metricDeltas.input_tokens_mean`, say), with `judge_score` per judge.
- **In the CLI.** `mst run` prints a row per arm: cases passed, trial pass rate, judge pass rate when there are judges, MCP calls and host events, tokens, cost and time.
- **Run totals.** The summary's top-level `total`, `passed`, `failed` and `passRate` count every arm; its other metrics are the first arm's.

### Pricing

Most hosts report tokens but not cost. A manifest (or a plugin's shared config) can price them, in USD per million tokens, by the model each case runs:

```json
"pricing": {
  "claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
}
```

MST ships no prices; they change too often to bake in.

- **Reported cost wins.** A host-reported cost is always used. Estimates are kept apart as `estimatedCostUsd` in each case's usage, `cost_usd` uses whichever there is, and the arm's `costSource` says which (`host`, `pricing` or `mixed`).
- **Which model.** A case is priced at its own `model`, else the arm's or manifest's `model` (including a client's default). A model the client picks at run time isn't known to MST, so set `model` to price it.
- **Auditable.** Each arm records the prices it used in `pricing`, and models it couldn't price in `unpricedModels`; `cost_usd` leaves their trials out.
- **Shared configs.** A manifest's `pricing` replaces a shared config's whole table; the two aren't merged.

### Compared with the previous run

Every run has a `runId`. Its summary's `previousRun` compares it with the previous run of the same manifest that ran the same arms, when there is one:

- **Which run.** The manifest's `name` identifies it, so two manifests with the same name share a history. With a result store, the previous run is the store's newest summary for that manifest. Without one, it's the newest earlier `results.json` in the output directory (`--output-dir`, by default `.mcp-test-results/<name>/`).
- **Output.** `mst run` prints the change and the regressed, improved, added and removed cases.
- **Best effort.** A previous run that can't be read is skipped with a warning; it never fails the run.

```json
"previousRun": {
  "runId": "4c1f…",
  "timestamp": "2026-10-03T18:02:11.000Z",
  "sameManifest": true,
  "passRate": 1,
  "passRateDelta": -0.5,
  "arms": {
    "default": {
      "passRateDelta": -0.5,
      "trialPassRateDelta": -0.1,
      "regressed": ["billing-owner"],
      "improved": [],
      "added": [],
      "removed": []
    }
  }
}
```

`sameManifest` is false when the manifest changed between the runs, so a difference may come from the configuration rather than the server. Datasets aren't part of that hash.

## CLI

```bash
npx mst run \
  --manifest ./eval-manifest.json \
  --plugins ./plugins \
  --arm variant \
  --dry-run

npx mst batch \
  --manifest-dir ./manifests \
  --workers 4 \
  --skip-existing \
  --dry-run
```

`--dry-run` validates the manifests and loads their plugins without running
anything; `run --dry-run` prints the manifest name, datasets and arms as JSON.
Without it, `run` runs the manifest's arms and `batch` runs each listed
manifest.

## Ownership boundary

The framework owns generic loading, extension lookup, execution, metrics,
result storage, and summaries. Consumers own organization-specific datasets,
judges, connector configuration, secrets, schedules, CI, and deployment.
Secrets remain environment-variable or plugin-owned runtime inputs; they do not
belong in committed manifests.
