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

## Registries

All extension points follow the same public shape. Each implementation owns
its tagged-config schema; the core registry does not know organization-specific
options:

```ts
registerX({ name, schema, ...implementation });
getX(name);
listXs();
```

The framework exposes registries for:

- `registerDatasetSource` — built-in `file` and future `dir`, `gcs`, or HTTP sources
- `registerHost` — built-in SDK, CLI, and external host drivers
- `registerJudge` — built-in and organization-specific judges
- `registerMetric` — built-in metrics and custom measurements
- `registerResultStore` — local file, GCS, and other result destinations

Built-ins register through the same APIs available to plugins. Plugin modules
are loaded with `--plugins` before manifest validation and execution.

## Execution lifecycle

```text
EvalManifest
  -> validate tagged blocks, registry names, schemas, and server labels
  -> load plugins and built-in registrations
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
mcp-server-tester run \
  --manifest ./eval-manifest.json \
  --plugins ./plugins \
  --arm variant \
  --dry-run

mcp-server-tester batch \
  --manifest-dir ./manifests \
  --workers 4 \
  --skip-existing \
  --dry-run
```

The scaffold validates manifests, loads plugins, and prints an execution plan.
The suite and batch implementation branches fill in execution behind this
contract; the scaffold never pretends that an unimplemented run succeeded.

## Ownership boundary

The framework owns generic loading, registry lookup, execution, metrics,
result storage, and summaries. Consumers own organization-specific datasets,
judges, connector configuration, secrets, schedules, CI, and deployment.
Secrets remain environment-variable or plugin-owned runtime inputs; they do not
belong in committed manifests.
