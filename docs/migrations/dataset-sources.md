# Migrating dataset sources to canonical EvalDataset

Built-in `file`, `dir`, and `gcs` sources now accept **canonical EvalDataset JSON only**. They no longer infer tool-selection, tool-call, or quality evaluations from a first case, attach host configurations, or manufacture Glean judge assertions. `buildEvalDataset(raw, hostConfig, manifest)` retains its public signature, but the host argument is unused: it validates canonical data and applies `maxCases` after validating every case.

## Preferred migration: canonical data

A minimal direct dataset needs a name, a case ID, and a tool name. A mode, arguments, expectations, and a resolved host are not required for loading:

```json
{
  "name": "search-regression",
  "cases": [{ "id": "search", "toolName": "search" }]
}
```

Keep assertions explicit when they matter. For example, translate a legacy `tool` field to `toolName` and retain `args` and `expect`. Translate `expected_tool` into an explicit host case with `expect.toolsTriggered`. Translate quality scenarios into host cases with `expect.passesJudge` and the correct reference and threshold for each judge.

```json
{
  "name": "policy-quality",
  "cases": [
    {
      "id": "policy",
      "mode": "host",
      "host": { "type": "my-host", "model": "case-model" },
      "scenario": "What is our leave policy?",
      "iterations": 3,
      "accuracyThreshold": 0.8,
      "expect": {
        "passesJudge": {
          "judge": "my-quality-judge",
          "reference": "The expected policy answer",
          "threshold": 0.75
        }
      }
    }
  ]
}
```

Register `my-host` and `my-quality-judge` in your own plugin. Canonical ingestion preserves `direct`, `host`, `mcp_host`, and `external_host` modes, per-case host overrides, iterations, accuracy thresholds, and explicit assertions. Registered-host resolution and any manifest-wide judge policy belong to the suite, not the JSON reader.

Use canonical data with any built-in source:

```json
{
  "name": "canonical-sources",
  "datasets": [
    { "type": "file", "path": "datasets/search.json" },
    { "type": "dir", "path": "datasets/canonical" },
    { "type": "gcs", "uri": "gs://my-eval-bucket/datasets/quality.json" }
  ]
}
```

Directory declarations are expanded by the suite; each JSON entry undergoes the same canonical validation. GCS reads require the optional `@google-cloud/storage` package and Application Default Credentials with object-read access. Reading a dataset does not require a result store, uploader, or bucket-write permission.

Noncanonical fields are rejected instead of silently discarded, including on later cases and cases beyond `maxCases`. A scenario without a host mode is not implicitly a quality evaluation. Fix the JSON or select an explicit source adapter when the error says `Expected a canonical EvalDataset`.

## Transitional migration: opt-in `glean-legacy` plugin

The copyable source adapter is in [examples/plugins/legacy-glean-datasets.ts](../../examples/plugins/legacy-glean-datasets.ts). It imports only the public `@gleanwork/mcp-server-tester` API, Node APIs, and Zod; it does not import internal files or the result uploader. The example is repository source, not a new package export or an automatically loaded built-in.

1. Copy the module into your consumer repository, for example `plugins/legacy-glean-datasets.ts`.
2. Compile it to ESM JavaScript with your existing TypeScript build (or run with a TypeScript-aware loader). Keep the package import external so the plugin uses the runner's installed framework.
3. Load the compiled module using `manifest.plugins` or the CLI `--plugins` option. The loader calls the exported `register()` hook. Merely importing the module does not register it.
4. Replace legacy built-in source declarations with `type: "glean-legacy"` and explicitly select both a format and a transport. Each source is one JSON object/file; expand a legacy directory into individual source declarations in the consumer.

```json
{
  "name": "legacy-search",
  "plugins": ["./plugins/legacy-glean-datasets.js"],
  "host": { "type": "vercel-sdk", "provider": "anthropic" },
  "iterations": 3,
  "datasets": [
    {
      "type": "glean-legacy",
      "format": "tool-selection",
      "transport": { "type": "file", "path": "datasets/tool-selection.json" }
    },
    {
      "type": "glean-legacy",
      "format": "tool-call",
      "transport": {
        "type": "gcs",
        "uri": "gs://my-eval-bucket/tool-call.json"
      }
    }
  ]
}
```

For quality datasets, use `format: "e2e-quality"`, load the organization judge implementation plugin as well, and list the selected judges in the manifest. The source adapter creates assertions; it does **not** implement or register the judges.

### Preserved legacy policy

- `tool-selection` requires `expected_tool` and `scenario` on every case. It produces MCP-host tool-trigger assertions and `mcp_host` / `tool_selection` tags. Iterations resolve as case override, manifest override, then 5; accuracy defaults to 1 for one iteration and 0.8 otherwise. Explicit case accuracy thresholds win.
- `tool-call` requires `tool` on every case, renames it to `toolName`, preserves arguments and explicit expectations, and adds `tool_call` tags. With no expectations, it retains `isError: false` and `responseSize.minBytes: 50`. Explicit host-mode cases use the resolved host configuration and case/manifest iterations.
- `e2e-quality` requires `scenario`, adds `e2e_quality` tags, and uses case/manifest iterations with a default of 1. Explicit accuracy thresholds are preserved.
- Quality judge mappings remain `glean-completeness`, `glean-correctness`, `task-completion`, `glean-rate-limit`, and `glean-timeout`. Their default threshold is 0.5; an explicit manifest judge threshold overrides it. Completeness/completion/signal judges reference the scenario. Correctness requires a nonempty reference answer and receives the JSON string `{ "question": scenario, "answer": reference }`.
- No judges are enabled implicitly. Unmapped manifest judges fail explicitly, including custom quality judges, rather than silently creating unjudged cases. Tool-selection and tool-call formats reject manifest judges whose policy they cannot map. Quality/selection cases carrying an `expect` block fail explicitly rather than lose those assertions: migrate them to canonical data. Tool-call cases preserve explicit custom `expect.passesJudge` assertions.
- Scenario conversions require a resolved MCP host configuration. A custom host can expose `createConfig()` if it supports that contract; otherwise migrate to canonical `mode: "host"` cases rather than fabricating an SDK configuration.
- No environment variable is read for iterations, and no cloud storage operation is an upload. GCS is optional and dynamically loaded only when selected.

These defaults are organization policy owned by the adapter. Other organizations should supply their own `DatasetSource`, not add policy to core readers.

## Scio integration checklist

No Scio repository changes are included in this migration. In Scio's main integration:

- Copy/build the example beside existing consumer-owned plugins and add its compiled path to the plugin list without dropping the judge implementation plugin.
- Replace each legacy file/GCS declaration with `glean-legacy`, its known `format`, and a nested `transport`. Leave canonical sources on the built-in types. Expand directories before creating legacy source declarations.
- Keep quality formats in manifests whose judges match the adapter policy. For custom judge semantics, prefer canonical assertions or extend the consumer's copy of the adapter explicitly; do not silently ignore a custom judge.
- Retain existing GCS read credentials and install the optional storage dependency only where GCS input is used. Do not wire dataset reads through the result uploader.
- Run local-file smoke evaluations with stub hosts/judges before enabling real host or cloud calls. Verify selection accuracy thresholds and quality judge references against the old fixtures.

The focused tests in `src/evals/buildEvalDataset.test.ts`, `src/evals/builtinDatasetSources.test.ts`, and `src/evals/legacyGleanDatasetSource.test.ts` cover canonical loading, explicit rejection, file/GCS adaptation, thresholds, and quality judge execution. All GCS operations in these tests are mocked.
