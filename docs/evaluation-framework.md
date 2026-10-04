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
  "datasets": [{ "type": "file", "path": "evalsets/search.json" }],
  "servers": [
    {
      "transport": "http",
      "serverUrl": "https://example.com/mcp",
      "label": "prod"
    }
  ],
  "host": { "type": "sdk" },
  "metrics": ["passed", { "type": "tool-count" }],
  "results": { "store": { "type": "file", "directory": ".mcp-test-results" } },
  "arms": [
    { "name": "baseline" },
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

A key the schema doesn't define is an error, in a manifest and in a dataset, so a misspelling fails instead of being ignored. So is a setting the selected host can't honour, such as `toolOverrides` for a host that doesn't present tool variants. `--dry-run` reports all of these, including in datasets.

- **Run controls** (`iterations`, `maxCases`, `concurrency`, `filterTags`, `accuracyThreshold`) go at the top level or under `run`.
- **Host defaults:** `model`, `provider`, `maxToolCalls`, `timeout`, `temperature` and `maxTokens` default each host option of that name, for the hosts that take it.
- **Inheritance:** an arm or case host inherits the manifest host's options only when it's the same host type.

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
      evaluate: async (candidate, reference) => ({ score: 1 }),
    },
  },
  // Also: hosts, metrics, resultStores.
  configs: {
    recommended: {
      judges: ['acme/completeness'],
      iterations: 3,
    },
  },
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Manifests and datasets reference it as `namespace/name`, such as `{ "type": "acme/legacy" }` or `passesJudge: { "judge": "acme/completeness" }`. Built-ins (`file`, `claude-cli`, `rubric`, `passed`, ...) use bare names, which plugins can't take.
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
    "iterations": 5
  }
  ```

  A config is typed `PluginConfig` and can set any documented manifest key except `name`, `datasets`, `arms`, `plugins` and `extends`. Other keys, including `run`, are rejected when a manifest extends the config; until then MST only checks that it's an object. Configs apply in order, then the manifest's own settings, including its `run` controls. Each top-level key is replaced, never merged: here the manifest's `iterations` replaces the config's, and a manifest `judges` list would replace the config's list rather than add to it. A config may use only its own plugin's extensions and built-ins, and can't extend other configs. MST has no built-in configs. A suite's `contentHash` is computed with its configs applied, so `runEvalBatch` doesn't resume a saved run after a config changes. Code that validates a manifest itself applies `extends` first with `resolveManifestExtends` (from `./evals`).

- **Judges.** A judge's `evaluate(candidate, reference, options)` returns `{ score, reasoning?, provider?, model? }`, with `score` from 0 to 1. MST parses `options` with the judge's schema, calls `evaluate` once per `reps`, and compares the mean score with the assertion's `threshold`. The schema sees only the judge's own options, never `threshold`, `reference`, `reps` or a manifest entry's `type` and `name`. The built-in `rubric` judge has the same contract, and a manifest can list it: `judges: [{ "type": "rubric", "rubric": "correctness" }]`.

Plugins load before manifest validation, so validation can check every reference and schema.

### Dataset sources

The built-in `file`, `dir` and `gcs` sources read canonical `EvalDataset` JSON only. They don't infer expectations from a first case, attach hosts or add judges, and they reject fields they don't know, on every case. A minimal direct dataset needs a name, a case ID and a tool name:

```json
{
  "name": "search-regression",
  "cases": [{ "id": "search", "toolName": "search" }]
}
```

`dir` reads every `.json` file in the directory (subdirectories too with `"recursive": true`), validates each the same way, and merges their cases into one dataset named after the directory. `gcs` needs the optional `@google-cloud/storage` package and Application Default Credentials that can read the object.

Datasets in another schema need a dataset source in your own plugin that converts them. The conversion policy (default iterations, accuracy thresholds, which judges a case gets) belongs to that source, not to MST:

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

### Hosts

A host runs one scenario and returns its trace. It doesn't repeat cases, run judges or decide pass/fail; `runEvalDataset` does that for every host. A plugin host is the way to add a host: the built-in desktop drivers are composed from internal capabilities, which plugins can't provide.

```typescript
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

export default {
  meta: { name: 'my-mst-plugin', namespace: 'my' },
  hosts: {
    assistant: {
      schema: z.object({ type: z.literal('my/assistant') }),
      evidence: 'observed',
      async run(input, config, context) {
        // input.scenario and input.servers are the unit of execution.
        return { finalText: 'Answer from the assistant', events: [] };
      },
    },
  },
} satisfies Plugin;
```

A manifest that loads the plugin selects the host with `{ "type": "my/assistant" }`.

- **The trace.** `run` returns a `HostRunResult`: `finalText`, `events`, and optional `usage`, `error` and timing fields. Each event has a `kind` (`tool_call`, `skill`, `command` or `subagent`), a `source` (`mcp` or `host`), a `name`, and optionally the MCP server label, arguments, output and ID. Record what the host did; don't reconstruct tool calls from the final text.
- **Evidence.** Declare `evidence: 'structured'` only for authoritative protocol or host-native traces. With `observed`, `none` or no declaration, tool-call and argument assertions can't pass; text and judge assertions still run.
- **Servers.** Events keep their MCP server labels. With more than one server, tool assertions use label-qualified names, or the manifest's `toolMap` from canonical to native names.
- **In results.** Each host case result keeps the trace as `trace`, a `HostTrace`: the `HostRunResult` your host returned, without telemetry and diagnostics, plus its evidence. On a one-server arm, MCP events that name no server get that server's label. A case with several iterations has no `trace` of its own; each entry in `iterationResults` has the trace of that iteration. In a suite, every case result also names its `arm`. Stored results drop `finalText` and each event's `output`, the same way they drop `response`; events, servers, arguments and usage stay.
- **Batches.** A host with `runBatch` gets one request per iteration of each host case in the dataset, and returns one trace per request, in order. A batch host can't mix host types, and its cases need unique IDs.
- **Settings only.** `createConfig` returns settings for MST's own SDK or CLI host instead of running anything.
- **What it honours.** Set `toolOverrides: true` if the host shows the model an arm's tool variants (from `context.arm`); without it, a manifest that gives the host `toolOverrides` fails validation. `maxConcurrency` caps the manifest's `concurrency`.

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

`EvalDataset`, `EvalCase`, `EvalMode`, `MCPConfig`, and `runEvalDataset` remain
the canonical case and execution primitives. The suite layer composes them; it
does not replace them with a second case model.

## Arms

An arm is a patch over the manifest defaults. Arms replace separate A/B and
variant-experiment concepts. An arm may change its server set, host options,
tool-name map, scenario template, metrics, or judges. A manifest without arms
has one implicit `default` arm.

Each `MCPConfig` may have a `label`. Labels are required when a server set has
more than one entry so traces and metrics can attribute MCP calls correctly.

## Metrics

Every arm in the run summary has `metrics`. They always include:

- `passed_rate`: the share of cases that passed.
- `trial_pass_rate`: the share of trials that passed, averaged over cases.

A trial is one run of a case: one iteration, or the case itself when it runs once. A case passes when its trials reach its `accuracyThreshold` (1 by default), so two arms whose cases pass 60% and 100% of the time report a `passed_rate` of 0 and 1. `trial_pass_rate` reports 0.6 and 1.

A manifest's or arm's `metrics` list adds more. Built-in names:

| Metric                                                                                                 | Reports                                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `passed`, `trial_pass`                                                                                 | The two above.                                                    |
| `tool_count`, `first_tool`, `is_no_action`                                                             | Tool calls in the trace. MCP calls are named `server.tool`.       |
| `input_tokens`, `input_tokens_uncached`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Host token usage. `input_tokens` includes cache reads and writes. |
| `cost_usd`                                                                                             | Host-reported cost.                                               |
| `duration_s`, `duration_api_s`                                                                         | Wall time, and API time when the host reports it.                 |
| `response_success`, `response_len`, `response_words`                                                   | Trials without a host error, and the answer's length.             |
| `skill_loaded`, `skill_before_tool`, `skill_verification_failed`                                       | Agent Skills loads.                                               |
| `judge_pass`, `judge_score`, `judge_name`, `judge_pass_for`, `judge_score_for`                         | Judge verdicts, from the case's last trial.                       |

- **Per trial.** Usage, timing, tool and answer metrics are measured per trial. A case's value is the mean over its trials, and an arm's is the mean over its cases (`<name>_mean`, or `<name>_rate` for shares). `first_tool` lists the first tool of each case's first trial. Runs that failed on infrastructure, such as a network error or a host that couldn't start, aren't trials, as they don't count toward accuracy.
- **Unavailable, not zero.** A metric with no value for any case is left out of `metrics` and listed in the arm's `unavailableMetrics`. A host that reports no cost has no `cost_usd`. A host whose evidence is `none` has no tool metrics.
- **Evidence.** An arm's `evidence` is the weakest among its cases (`none`, then `observed`, then `structured`). With `observed`, tool metrics come from a best-effort trace; compare them only between arms with the same evidence.
- **Deltas.** `armDeltas` compares each arm with the first: `passRate`, `trialPassRate`, and their deltas.
- **Run totals.** The summary's top-level `total`, `passed`, `failed` and `passRate` count every arm; its other metrics are the first arm's.

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
