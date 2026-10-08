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
  "variants": [
    { "name": "baseline", "servers": ["prod"] },
    { "name": "variant", "servers": ["variant"] }
  ]
}
```

A key the schema doesn't define is an error, in an eval config and in a dataset, so a misspelling fails instead of being ignored. So is a setting the selected client can't honour, such as `tools` (tool metadata) for a client that doesn't present tool variants. `--dry-run` reports all of these, including in datasets.

- **Run controls** (`trials`, `maxCases`, `concurrency`, `filterTags`, `passThreshold`) go at the top level or under `run`.
- **Client defaults:** `model`, `provider`, `maxToolCalls`, `timeout`, `temperature` and `maxTokens` default each client option of that name, for the clients that take it.
- **The client:** `client` names the client under test, `model` the model it uses, and `clientOptions` the client's other options. A variant or case may set any of the three; it inherits the eval config's `clientOptions` only when it uses the same client.

A bare dataset path is shorthand for `{ "type": "file", "path": "..." }`; a bare `namespace/dataset/name` is a [plugin's dataset](#plugin-datasets-and-snapshots). Relative dataset and plugin paths in an eval config resolve against the eval config's directory, then `rootDir` (`--root-dir`, the working directory by default). A `file` result store's `dir` is always relative to the eval config, so where results are written doesn't depend on the working directory. Plugin result stores resolve their own options.
Every other pluggable block is a tagged object. `servers` is the MCP servers under test, a map keyed by label (`"servers": { "acme": { "transport": "http", ... } }`); an entry doesn't set `label`, because the key is its label. A variant picks servers by label (`"servers": ["acme"]`): one that lists none uses every server, and `[]` uses none. An empty map is valid for clients that provide their own capabilities. When the eval config and a shared config it extends both set `servers`, the eval config's map replaces the shared config's whole, like every key; a variant may name a shared config's servers when the eval config sets none.

## Plugins

Dataset sources, clients, judges, metrics and result stores are extensions. Each one owns its tagged-config schema; core doesn't know organization-specific options. ADR [0001](adr/0001-eslint-style-declarative-plugins.md) records why plugins take this shape.

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
  // Also: clients, metrics, resultStores.
  configs: {
    recommended: {
      judges: ['acme/judge/completeness'],
      trials: 3,
    },
  },
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Eval configs and datasets reference it as `<namespace>/<kind>/<name>`, such as `{ "type": "acme/dataset/legacy" }` or a case's `"judges": ["acme/judge/completeness"]`. The kind is `dataset`, `client`, `judge`, `pairwise-judge`, `metric`, `result-store`, `connector` or `config`, and it must match where the name is used: `acme/judge/x` in `datasets` is an error. Built-ins (`file`, `claude-code`, `rubric`, `passed`, ...) use bare names, or the full `mst/<kind>/<name>` (`mst/judge/rubric`); the `mst` namespace is reserved.
- **Namespace.** `meta.namespace` is required: lowercase, optionally scoped as `@scope/name`. Two different plugins can't share a namespace. Loading the same plugin again is a no-op, including a rebuilt object with the same name, version, extension definitions and configs. A plugin factory that builds differently configured copies needs a namespace per copy. A package's CommonJS and ESM builds are different objects too, so load a plugin one way; publishing plugins as ESM avoids the question.
- **Loading.** An eval config lists plugin specifiers in `plugins`. Each one resolves relative to the eval config's directory, then `rootDir` (`--root-dir`, the working directory by default), then as a package name, resolved as `import` resolves it. `--plugins` and the `pluginPaths` / `plugins` options of `runEval` and `runEvalBatch` add to that list. Code that runs datasets directly passes plugin objects: `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `test.use({ mcpPlugins: [plugin] })` in Playwright. Code that calls validators or matchers on its own installs them with `installPlugins([plugin])`.
- **Scope.** An eval config may only reference namespaces of plugins it loads, even if another eval in the same process (a batch) loaded more. The same check applies to the clients and judges its datasets name. `runEvalDataset`, `runEvalCase` and the fixtures have no eval config, so they resolve against every plugin installed in the process.
- **Contracts.** Each extension has a Zod `schema` for its options and the functions its kind needs: `load` (dataset sources), `run` or `runBatch` (clients), `evaluate` (judges), `kind` and `compute` (metrics), and `create` (result stores). MST validates the plugin when it loads, and names the plugin and extension in any error.
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

  A config is typed `PluginConfig` and can set any documented eval config key except `name`, `datasets`, `variants`, `plugins` and `extends`. Other keys, including `run`, are rejected when an eval config extends the config; until then MST only checks that it's an object. Configs apply in order, then the eval config's own settings, including its `run` controls. Each top-level key is replaced, never merged: here the eval config's `trials` replaces the config's, and an eval config `judges` list would replace the config's list rather than add to it. A config may use only its own plugin's extensions and built-ins, and can't extend other configs. MST has no built-in configs. An eval's `contentHash` is computed with its configs applied, so `runEvalBatch` doesn't resume a saved run after a config changes. Code that validates an eval config itself applies `extends` first with `resolveConfigExtends` (from `./evals`).

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

A judge returns a `JudgeScore`. Only `score` (0 to 1) is required:

| Field               | Effect                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pass`              | The judge's own pass/fail. Without it, the case passes when the mean score meets the threshold.                  |
| `skipped`           | The judge cannot grade this case. It doesn't count for pass/fail or judge metrics; the remaining reps don't run. |
| `subScores`         | Named sub-scores, such as one per criterion: `{ [key]: { score, pass?, reasoning? } }`.                          |
| `usage`             | The judge's own token usage and cost, summed over reps.                                                          |
| `provider`, `model` | Reported as `judgeProvider` and `judgeModel`.                                                                    |
| `metadata`          | Other JSON output, kept in the result.                                                                           |

A score or sub-score outside 0 to 1 is an error, not a result. When every
judge of a case skips, the judge assertion passes.

Judge usage is kept apart from client usage: `judgeUsage` on each case and
trial, `totalJudgeUsage` on the run and eval telemetry, and the
`judge_cost_usd`, `judge_input_tokens`, and `judge_output_tokens` metrics.
The built-in `rubric` judge reports its usage the same way.

### Pairwise judges

A pairwise judge compares two runs of the same case, a baseline and a
candidate, and says which is better. It is a separate extension kind,
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

### Dataset sources

The built-in `file`, `dir` and `gcs` sources read canonical `EvalDataset` JSON only. They don't infer assertions from a first case, attach clients or add judges, and they reject fields they don't know, on every case. A minimal dataset needs a name, a case ID and an input:

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
    { "ref": "acme/dataset/info-seeking", "snapshot": "2026-10-01" },
    { "ref": "acme/dataset/info-seeking", "source": "live" }
  ]
}
```

- **`snapshot` and `source` are MST's.** MST takes them off the declaration before the source's schema sees it, passes them as `context.request` (`source` defaults to `snapshot`; no `snapshot` means the source's latest), and rejects them for a source without `snapshots`. A dataset back with a snapshot other than the one asked for, or live data with a snapshot, fails the run.
- **`run.json` records which copy.** Each plugin dataset in `datasets` has its `ref`, plus `snapshot` or `live: true`, next to its `caseCount` and `contentHash`. `mst run --dry-run` prints the same. Unchanged cases hash the same whichever copy they came from.

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

- **The trace.** `run` returns a `ClientRunResult`: `finalText`, `events`, and optional `usage`, `error` and timing fields. Each event has a `kind` (`tool_call`, `skill`, `command`, `subagent` or `tool_search`), a `source` (`mcp` or `builtin`), a `name`, and optionally the MCP server label, arguments, output and ID. Record what the host did; don't reconstruct tool calls from the final text. A `tool_search` event (the host searching its tool catalog) lists the tools the search returned in `results`, each `{ name, server? }`. Type client-native actions as their kind rather than as calls to a host tool, so skill assertions and search metrics can read them.
- **Evidence.** Declare `evidence: 'structured'` only for authoritative protocol or client-native traces. With `observed`, `none` or no declaration, tool-call and argument assertions can't pass; text and judge assertions still run.
- **Servers.** Events keep their MCP server labels. With more than one server, tool assertions use label-qualified names, or the eval config's `toolMap` from canonical to native names.
- **In results.** Each client case result keeps the trace as `trace`, a `Trace`: the `ClientRunResult` your client returned, without telemetry and diagnostics, plus its evidence. On a one-server variant, MCP events that name no server get that server's label. A case with several trials has no `trace` of its own; each entry in `trialResults` has the trace of that trial. In an eval, every case result also names its `variant`. Stored results drop `finalText` and each event's `output`, the same way they drop `response`; events, servers, arguments and usage stay.
- **Batches.** A client with `runBatch` gets one request per trial of each client case in the dataset, and returns one trace per request, in order. A batch client can't mix client types, and its cases need unique IDs.
- **Tool variants.** A client that connects to the servers in `input.servers` gets a variant's tool metadata (`tools`) with no work of its own: the run gives it `http` server configs for a local MCP proxy that applies the variant, so the host must speak Streamable HTTP (see [Tool variants on every host](#tool-variants-on-every-client)). A client that shows tool metadata itself sets `toolMetadata: true`; `variantToolMetadata(context.evalConfig, context.variant)` from `./evals` gives the variant's (its own `tools`, else the config's), and `buildToolSurface(listed, metadata)` applies it with MST's rules (keys, renames, collisions), and `resolve(name, server)` maps a presented name back to the original tool. Record a renamed tool's calls under `originalName`, with the model's name in `rawName`, as MST's hosts do. A batch host that connects to one server set for the whole batch (the first request's `input.servers`) sets `serversPerBatch: true`, and the batch shares one proxy endpoint. A proxied request also carries `input.checkServers`: the same servers on an endpoint for the host's own checks, such as a readiness probe, so that traffic isn't taken for the model seeing the variant. A host that connects elsewhere (hosted connectors, say) sets `toolSurfaceProxy: false`; an eval config that gives it `tools` then fails validation.
- **What it honours.** `maxConcurrency` caps the eval config's `concurrency`.

### Claude Code client-native events

The Claude CLI and Cowork clients read Claude Code transcripts, where skills, commands, subagents and tool search are calls to built-in tools. They are recorded as typed events:

| Claude Code tool | Event                                                  |
| ---------------- | ------------------------------------------------------ |
| `Skill`          | `skill`, named for the skill it loaded                 |
| `SlashCommand`   | `command`, named for the command                       |
| `Task`, `Agent`  | `subagent`, named for the subagent type                |
| `ToolSearch`     | `tool_search`, with the tools it returned in `results` |

A search's `results` come from `tool_reference` blocks in its result, or, without them, from `mcp__<server>__<tool>` names in its text. This format is inferred rather than taken from recorded `ToolSearch` traces; if `tool_search_hit_rate` reads 0 where searches clearly worked, check the search's `output` in the trace. Other built-in tools (`Bash`, `Read`) stay tool calls with `source: 'client'`.

### System prompts

`systemPrompt` adds text to a client's system prompt, such as an organisation's instructions. To measure what it changes, give one variant the prompt (a variant inherits the eval config's `clientOptions` when it uses the same client):

```json
"variants": [
  { "name": "no-prompt" },
  { "name": "org-prompt", "clientOptions": { "systemPrompt": "For actions in a connected app, call find_skills first." } }
]
```

- **`mst`** puts it in the model's system prompt, ahead of the skills catalog when `skills` is on.
- **`claude-code`** passes it with `--append-system-prompt`, so Claude Code's own system prompt stays.
- **Cowork and ChatGPT** take organisation instructions from the app, not from MST, so `systemPrompt` is a validation error for them.

A plugin client that can apply one declares `systemPrompt` in its schema. A case's own `clientOptions.systemPrompt` replaces the one it inherits, and is a validation error for a client that can't apply one.

### Tool variants on every client

A variant's tool metadata (`tools`: descriptions, input schemas, renames) reaches every client:

- **`mst`** applies the variant in-process.
- **Clients that connect to their servers** (plugin clients, `claude-code`, `cowork`) get them through a local MCP proxy. The run starts it on first use and gives each client request its own loopback Streamable HTTP endpoints, one per server, with the servers' labels and timeouts. The proxy presents the variant's tools and sends calls to a renamed tool to the original. Other requests (resources, prompts, skills) pass through; notifications, such as list changes and progress, don't.
- **One connection per server for the variant.** The proxy connects to each server once and shares that connection across the variant's cases, where a client without tool metadata may connect per case. A server that keeps per-connection state sees one connection for a variant with tool metadata.
- **A request whose client never lists the proxied tools fails.** Otherwise the run would report results for a variant the model never saw. Cowork sets up its servers once per batch, so it lists them once: the batch shares one endpoint, and the check is for the batch. MST's own readiness probe uses a separate endpoint and doesn't count.
- **Calls are recorded under the tools' original names**, so a dataset's assertions read the same in every variant, with the model's name in `rawName`.

The ChatGPT desktop client opts out until it is verified with the proxy, so an eval config that gives it `tools` fails validation.

## Execution lifecycle

```text
EvalConfig
  -> load the eval's plugins (built-ins are always available)
  -> validate tagged blocks, extension names and namespaces, schemas, and server labels
  -> resolve DatasetSource entries into EvalDataset values
  -> derive one or more variants from the eval config (baseline first)
  -> run each variant through its client (built-in or plugin) with its MCPConfig[] server set
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
└── runs/<run-id>/
    ├── run.json                    # what ran: variants, datasets (with content hashes), judges, environment, phases
    ├── traces/<variant>/<case-id>/<trial>.json          # what the client did in one trial
    ├── scores/<grader>/<variant>/<case-id>/<trial>.json # one grader's score for one trial
    ├── results.json                # every case result, traces and scores joined
    ├── summary.json                # per-variant totals, metrics and comparisons (cases are in results.json)
    └── report/index.html           # the report `mst open` shows, built from the files above
```

- **Run IDs** sort by start time: `20261007T182504Z-7f3c2a`. The last six characters are its short form.
- **Every file** starts with `"format": "mst.run/v1"` and its `kind` (`run`, `trial`, `score`, `results`, `summary`, `latest`). Readers ignore fields they don't know, so new optional fields keep the version; removing or renaming one moves the format to `mst.run/v2`. The JSON Schemas are published in `schema/run/v1/`.
- **Paths:** variant, case and grader names are URI-encoded into one path segment each, and trials count from 0. Case IDs must be unique within a run, because they name these paths: a case ID in two datasets fails before anything runs.
- **`latest.json`** is written last, and only for a full run, so a crash or a partial run leaves it at the previous run.
- **Redaction** applies to every file, as it does to stored results (`redactStoredResponses`).
- **`--output-dir`** names the eval's directory (`<output-dir>/runs/<run-id>/`).
- **`report/`** is built from the run's own files, so `mst open <run>` can rebuild it for a run copied without it. `run.json` records each variant's setup (client, model, servers, tool metadata, input template, judges, and client options, with any whose name suggests a credential replaced by a hash) for the report's _What differs_. See [`mst open`](./cli.md#open---open-a-runs-report).

A result store set in the eval config also gets the run summary, as before.

## Variants

A variant is a patch over the eval config defaults. Variants replace separate A/B and
variant-optimization concepts. A variant may change its server set, client, model, client options,
tool-name map, input template, metrics, or judges. An eval config without variants
has one implicit `default` variant.

Each server's label is its key in `servers`. Traces and metrics attribute MCP
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

### Pairwise judges in an eval config

`pairwiseJudges` lists [pairwise judges](#pairwise-judges) at the eval config's top level (or in a shared config, not on a variant): references `<namespace>/pairwise-judge/<name>`, or `{ "type": <reference>, "reps": 2, ...options }`. Validation checks each one exists in a plugin the eval loads, and that its schema takes the options.

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

| Metric                                                                                                 | Reports                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `passed`, `trial_pass`                                                                                 | The share of cases, and of trials, that passed.                                      |
| `tool_count`, `mcp_call_count`, `builtin_event_count`, `first_tool`, `is_no_action`                    | Tool calls and client-native events in the trace. MCP calls are named `server.tool`. |
| `input_tokens`, `input_tokens_uncached`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Client token usage. `input_tokens` includes cache reads and writes.                  |
| `cost_usd`                                                                                             | Client-reported cost, or an estimate from the eval config's `pricing`.               |
| `duration_s`, `duration_api_s`                                                                         | Wall time, and API time when the client reports it.                                  |
| `response_success`, `response_len`, `response_words`                                                   | Trials without a client error, and the answer's length.                              |
| `skill_loaded`, `skill_before_tool`, `skill_verification_failed`                                       | Agent Skills loads.                                                                  |
| `tool_search_hit`                                                                                      | Trials where a tool search returned a tool the trial then called.                    |
| `judge_pass`, `judge_score`, `judge_name`, `judge_pass_for`, `judge_score_for`                         | Judge scores, from the case's last trial.                                            |

- **Per trial.** Usage, timing, tool and answer metrics are measured per trial. A case's value is the mean over its trials, and a variant's is the mean over its cases (`<name>_mean`, or `<name>_rate` for shares). `first_tool` lists the first tool of each case's first trial. Runs that failed on infrastructure, such as a network error or a client that couldn't start, aren't trials, as they don't count toward accuracy.
- **Unavailable, not zero.** A metric with no value for any case is left out of `metrics`; if the eval config lists it, it's also in the variant's `unavailableMetrics`. A client that reports no cost has no `cost_usd` unless the eval config prices its model. A client whose evidence is `none` has no tool metrics.
- **Evidence.** A variant's `evidence` is the weakest among its cases (`none`, then `observed`, then `structured`). With `observed`, tool metrics come from a best-effort trace; compare them only between variants with the same evidence.
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

- **Which run.** The eval config's `name` identifies it, so two eval configs with the same name share a history. With a result store, the previous run is the store's newest summary for that eval config. Without one, it's the newest earlier run in the eval's `runs/` directory (under `--output-dir`, by default `.mcp-test-results/<name>/`), read from its `summary.json` and `results.json`.
- **Output.** `mst run` prints the change and the regressed, improved, added and removed cases.
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
      "regressed": ["billing-owner"],
      "improved": [],
      "added": [],
      "removed": []
    }
  }
}
```

`sameConfig` is false when the eval config changed between the runs, so a difference may come from the configuration rather than the server. Datasets aren't part of that hash.

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
anything; `run --dry-run` prints the eval config name, datasets and variants as JSON.
Without it, `run` runs the eval config's variants and `batch` runs each listed
eval config.

## Ownership boundary

The framework owns generic loading, extension lookup, execution, metrics,
result storage, and summaries. Consumers own organization-specific datasets,
judges, connector configuration, secrets, schedules, CI, and deployment.
Secrets remain environment-variable or plugin-owned runtime inputs; they do not
belong in committed eval configs.
