# JSON Schema for Eval Datasets

This directory contains a [JSON Schema (draft-07)](https://json-schema.org/draft-07/json-schema-release-notes.html) file that describes the eval dataset format used by `@gleanwork/mcp-server-tester`.

## File

| File                       | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `eval-dataset.schema.json` | Full schema for `data/*.json` eval dataset files |

## What it enables

When you point your editor at this schema, you get:

- **Autocomplete** for all field names (`input`, `client`, `model`, `assertions.toolsTriggered`, etc.)
- **Inline documentation** from field descriptions displayed on hover
- **Validation errors** for incorrect types, missing required fields, and invalid enum values (e.g. an unknown LLM provider)

## Usage

### Option 1 — `$schema` field in your JSON file (recommended)

Add a `$schema` property at the top of your dataset file pointing to the schema relative path:

```json
{
  "$schema": "../schema/eval-dataset.schema.json",
  "name": "my-eval",
  "cases": [...]
}
```

Most JSON-aware editors (VS Code, IntelliJ, Neovim with LSP) will pick this up automatically.

### Option 2 — VS Code workspace settings

Add a glob mapping in `.vscode/settings.json` to apply the schema to all files under `data/`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["data/*.json"],
      "url": "./schema/eval-dataset.schema.json"
    }
  ]
}
```

### Option 3 — Validate programmatically

Use any draft-07-compatible validator (e.g. [`ajv`](https://ajv.js.org/)):

```js
import Ajv from 'ajv';
import schema from './schema/eval-dataset.schema.json' assert { type: 'json' };
import dataset from './data/my-evals.json' assert { type: 'json' };

const ajv = new Ajv();
const validate = ajv.compile(schema);
if (!validate(dataset)) {
  console.error(validate.errors);
}
```

## Schema structure

```
EvalDataset (root)
├── name          (string, required)
├── description   (string)
├── metadata      (object)
└── cases[]       (array, required, min 1)
    └── EvalCase
        ├── id                 (string, required)
        ├── description        (string)
        ├── input              (string, required)  — the prompt the client acts on
        ├── client             (string)  — the client, inherited from the eval or run
        ├── model              (string)  — the model the client uses
        ├── clientOptions      (object)  — the client's own options
        ├── trials             (integer >= 1, default 1)
        ├── passThreshold      (number 0–1, default 1.0)
        ├── judgeReps          (integer >= 1, default 1)
        ├── expected           (object: answer, criteria, other ground truth)
        ├── tags               (string[])
        ├── metadata           (object)
        └── assertions         (EvalAssertions)
            ├── containsText       — substring(s) of the client's answer
            ├── matchesPattern     — regex(es) the answer matches
            ├── passesJudge
            │   ├── rubric         (string, required)
            │   ├── reference
            │   ├── threshold      (number 0–1, default 0.7)
            │   ├── reps           (integer, default 1)
            │   ├── provider       ("claude" | "anthropic" | "openai" | "google")
            │   ├── model          (string)
            │   ├── apiKeyEnvVar   (string)
            │   ├── maxTokens      (integer)
            │   ├── temperature    (number 0–1)
            │   ├── maxBudgetUsd   (number)
            │   └── maxToolOutputSize (integer)
            ├── toolsTriggered
            │   ├── calls[]
            │   │   ├── name       (string, required)
            │   │   ├── arguments  (object, partial match)
            │   │   └── required   (boolean, default true)
            │   ├── order          ("strict" | "any", default "any")
            │   └── exclusive      (boolean, default false)
            └── toolCallCount
                ├── min            (integer)
                ├── max            (integer)
                └── exact          (integer)
```

## Supported LLM providers

The mst client infers the API from `model`. Its `clientOptions.provider` overrides that, and accepts any of these values:

| Value              | Notes                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`           | Requires `@ai-sdk/openai`                                                                                                                             |
| `anthropic`        | Requires `@ai-sdk/anthropic`                                                                                                                          |
| `azure`            | Requires `@ai-sdk/azure`                                                                                                                              |
| `google`           | Requires `@ai-sdk/google`                                                                                                                             |
| `mistral`          | Requires `@ai-sdk/mistral`                                                                                                                            |
| `ollama`           | Local; no API key needed. Requires `@ai-sdk/ollama`                                                                                                   |
| `deepseek`         | Requires `@ai-sdk/deepseek`                                                                                                                           |
| `openrouter`       | Requires `@openrouter/ai-sdk-provider`                                                                                                                |
| `xai`              | Requires `@ai-sdk/xai`                                                                                                                                |
| `vertex-anthropic` | Anthropic Claude via Google Vertex AI. Use when `api.anthropic.com` is blocked. Requires `@ai-sdk/google-vertex` and Application Default Credentials. |

## Keeping the schema in sync

The schema is hand-maintained alongside the TypeScript types in:

- `src/evals/datasetTypes.ts` — Zod schemas and TypeScript interfaces
- `src/evals/mstClient/types.ts` — the `LLMProvider` union

If you add a new provider, a new assertion field, or change an existing type, update `schema/eval-dataset.schema.json` to match.
