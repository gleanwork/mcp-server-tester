# Migrating dataset sources to canonical EvalDataset

Built-in `file`, `dir`, and `gcs` sources now accept **canonical EvalDataset JSON only**. They no longer infer tool-selection, tool-call, or quality evaluations from a first case, attach host configurations, or manufacture judge assertions. `buildEvalDataset(raw, hostConfig, manifest)` retains its public signature, but the host argument is unused: it validates canonical data and applies `maxCases` after validating every case.

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
      "host": { "type": "my/host", "model": "case-model" },
      "scenario": "What is our leave policy?",
      "iterations": 3,
      "accuracyThreshold": 0.8,
      "expect": {
        "passesJudge": {
          "judge": "my/quality",
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

## Other dataset schemas: register a dataset source

If your datasets use another schema, convert them in a dataset source that your own plugin provides. Core readers stay canonical-only, and the conversion policy (default iterations, accuracy thresholds, which judges a case gets) belongs to your adapter, not to MST.

```typescript
import {
  loadEvalDatasetFromObject,
  type Plugin,
} from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const MySourceSchema = z
  .object({ type: z.literal('my/format'), path: z.string().min(1) })
  .strict();

const plugin: Plugin = {
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
};

export default plugin;
```

List the module in `manifest.plugins` (or pass it with `--plugins`), then declare `{ "type": "my/format", "path": "..." }` in `datasets`. See [Plugins](../evaluation-framework.md#plugins). Select the format explicitly in the declaration rather than inferring it from a first case, and fail on fields the adapter can't map instead of dropping them.

The focused tests in `src/evals/buildEvalDataset.test.ts` and `src/evals/builtinDatasetSources.test.ts` cover canonical loading and explicit rejection.
