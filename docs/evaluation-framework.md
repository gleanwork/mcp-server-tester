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
      evaluate: async (candidate, reference) => ({ score: 1 }),
    },
  },
  // Also: hosts, metrics, resultStores. `configs` is reserved for shared configs.
};

export default plugin;
```

- **Names.** Each map key names an extension within the plugin's namespace. Manifests and datasets reference it as `namespace/name`, such as `{ "type": "acme/legacy" }` or `passesJudge: { "judge": "acme/completeness" }`. Built-ins (`file`, `claude-cli`, `passed`, ...) use bare names, which plugins can't take.
- **Namespace.** `meta.namespace` is required: lowercase, optionally scoped as `@scope/name`. Two different plugins can't share a namespace. Loading the same plugin again is a no-op, including a rebuilt object with the same name, version and extension definitions. A plugin factory that builds differently configured copies needs a namespace per copy. A package's CommonJS and ESM builds are different objects too, so load a plugin one way; publishing plugins as ESM avoids the question.
- **Loading.** A manifest lists plugin specifiers in `plugins`. Each one resolves relative to the manifest's directory, then `rootDir` (`--root-dir`, the working directory by default), then as a package name; packages resolve with their `import` export condition. `--plugins` and the `pluginPaths` / `plugins` options of `runEvalSuite` and `runEvalBatch` add to that list. Code that runs datasets directly passes plugin objects: `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `test.use({ mcpPlugins: [plugin] })` in Playwright. Code that calls validators or matchers on its own installs them with `installPlugins([plugin])`.
- **Scope.** A manifest may only reference namespaces of plugins it loads, even if another suite in the same process (a batch) loaded more. The same check applies to the hosts and judges its datasets name.
- **Contracts.** Each extension has a Zod `schema` for its options and the functions its kind needs: `load` (dataset sources), `run`, `runBatch` or `createConfig` (hosts), `evaluate` (judges), `kind` and `compute` (metrics), and `create` (result stores). MST validates the plugin when it loads, and names the plugin and extension in any error.

Plugins load before manifest validation, so validation can check every reference and schema.

## Execution lifecycle

```text
EvalManifest
  -> load the suite's plugins (built-ins are always available)
  -> validate tagged blocks, extension names and namespaces, schemas, and server labels
  -> resolve DatasetSource entries into EvalDataset values
  -> derive one or more arms from the manifest
  -> run each arm through a registered Host with its MCPConfig[] server set
  -> compute metrics and judges
  -> write per-arm results through a registered ResultStore
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

The scaffold validates manifests, loads plugins, and prints an execution plan.
The suite and batch implementation branches fill in execution behind this
contract; the scaffold never pretends that an unimplemented run succeeded.

## Ownership boundary

The framework owns generic loading, extension lookup, execution, metrics,
result storage, and summaries. Consumers own organization-specific datasets,
judges, connector configuration, secrets, schedules, CI, and deployment.
Secrets remain environment-variable or plugin-owned runtime inputs; they do not
belong in committed manifests.
