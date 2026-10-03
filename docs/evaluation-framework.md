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

A bare dataset path is shorthand for `{ "type": "file", "path": "..." }`.
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
  // Also: hosts, metrics, resultStores. `configs` is reserved for shared configs.
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Manifests and datasets reference it as `namespace/name`, such as `{ "type": "acme/legacy" }` or `passesJudge: { "judge": "acme/completeness" }`. Built-ins (`file`, `claude-cli`, `rubric`, `passed`, ...) use bare names, which plugins can't take.
- **Namespace.** `meta.namespace` is required: lowercase, optionally scoped as `@scope/name`. Two different plugins can't share a namespace. Loading the same plugin again is a no-op, including a rebuilt object with the same name, version and extension definitions. A plugin factory that builds differently configured copies needs a namespace per copy. A package's CommonJS and ESM builds are different objects too, so load a plugin one way; publishing plugins as ESM avoids the question.
- **Loading.** A manifest lists plugin specifiers in `plugins`. Each one resolves relative to the manifest's directory, then `rootDir` (`--root-dir`, the working directory by default), then as a package name, resolved as `import` resolves it. `--plugins` and the `pluginPaths` / `plugins` options of `runEvalSuite` and `runEvalBatch` add to that list. Code that runs datasets directly passes plugin objects: `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `test.use({ mcpPlugins: [plugin] })` in Playwright. Code that calls validators or matchers on its own installs them with `installPlugins([plugin])`.
- **Scope.** A manifest may only reference namespaces of plugins it loads, even if another suite in the same process (a batch) loaded more. The same check applies to the hosts and judges its datasets name. `runEvalDataset`, `runEvalCase` and the fixtures have no manifest, so they resolve against every plugin installed in the process.
- **Contracts.** Each extension has a Zod `schema` for its options and the functions its kind needs: `load` (dataset sources), `run`, `runBatch` or `createConfig` (hosts), `evaluate` (judges), `kind` and `compute` (metrics), and `create` (result stores). MST validates the plugin when it loads, and names the plugin and extension in any error.
- **Judges.** A judge's `evaluate({ case, trial }, options)` returns a verdict with `score` from 0 to 1 ([Judge contract](#judge-contract)). MST parses `options` with the judge's schema, calls `evaluate` once per `reps`, and compares the mean score with the assertion's `threshold`. The schema sees only the judge's own options, never `threshold`, `reference`, `reps` or a manifest entry's `type` and `name`. The built-in `rubric` judge has the same contract, and a manifest can list it: `judges: [{ "type": "rubric", "rubric": "correctness" }]`.

Plugins load before manifest validation, so validation can check every reference and schema.

### Judge contract

A judge is called as `evaluate({ case, trial }, options)`, once per `reps`:

- `case` (`JudgeCase`) is the case as written in the dataset, the same for every run:
  `id`, `input` (`prompt`, or `tool` for a direct case), `expected`, `tags`, `metadata`.
- `trial` (`JudgeTrial`) is one observed run: `response` (what validators grade),
  `text`, `events` (tool calls and other host events), `messages` (when the host
  reports them), `evidence`, and host `usage`.
- `options` is the judge's own settings, parsed by its `schema`.

The threshold is not in the input. MST compares the mean score with it,
unless the judge returns its own `pass`; over several reps, the majority of
those verdicts decides, and a tie fails.

`case.expected` holds the case's ground truth:

- `answer`: the assertion's `reference`, else the case's `expected.answer`,
  else its `canonicalAnswer`.
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
iteration, `totalJudgeUsage` on the run and suite telemetry, and the
`judge_cost_usd`, `judge_input_tokens`, and `judge_output_tokens` metrics.
The built-in `rubric` judge reports its usage the same way.

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
        const raw = await readMyFormat(path, context.rootDir);
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
- **Batches.** A host with `runBatch` gets one request per iteration of each host case in the dataset, and returns one trace per request, in order. A batch host can't mix host types, and its cases need unique IDs.
- **Settings only.** `createConfig` returns settings for MST's own SDK or CLI host instead of running anything.

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
