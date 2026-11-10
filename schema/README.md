# JSON Schemas

This directory holds the [JSON Schemas (draft-07)](https://json-schema.org/draft-07/json-schema-release-notes.html) of the files MST reads and writes. The package publishes them, so they are in `node_modules/@gleanwork/mcp-server-tester/schema/` and on unpkg.

| File                             | Describes                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `eval-config.schema.json`        | An eval config (`eval.json`)                                                            |
| `eval-dataset.schema.json`       | An eval dataset                                                                         |
| `run/v1/<kind>.schema.json`      | Each file of a run directory in the `mst.run/v1` format, by its `kind`                  |
| `run/v1/manifest.schema.json`    | A stored run's `manifest.json` in a result store                                        |
| `run/v1/baseline.schema.json`    | A file `saveBaseline` writes                                                            |
| `run/v1/artifact.schema.json`    | An `EvalResultStore` artifact, which `runEvalDataset` and the Playwright reporter store |
| `history/v1/history.schema.json` | An eval's `history.json` (`mst.history/v1`)                                             |

`run/v1/` and `history/v1/` are generated from MST's Zod schemas with `npm run schema:generate`; the tests fail when the committed files differ. The eval config and dataset schemas are written by hand. Tests check their fields and transports against the Zod schemas in `src/evals/evalConfig.ts` and `src/evals/datasetTypes.ts`, so a new field or type there needs the schema updated too.

The fields themselves are documented with the features they belong to: datasets and eval configs in [the evaluation framework guide](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/evaluation-framework.md), and the api client's providers in [its guide](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/mst-client.md).

## Schema IDs

Every schema's `$id` is its URL at the newest 2.x release:

```
https://unpkg.com/@gleanwork/mcp-server-tester@2/schema/<path>
```

A 2.x release can add optional fields without changing an ID. A breaking change to a run or history file moves it to a new `v<n>/` path. `@2` resolves once 2.0.0 is published; until then, use `@rc`.

## Using a schema in an editor

Point `$schema` at the published URL, or at the installed file:

```json
{
  "$schema": "./node_modules/@gleanwork/mcp-server-tester/schema/eval-dataset.schema.json",
  "name": "my-eval",
  "cases": []
}
```

Or map files to it in `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["data/*.json"],
      "url": "./node_modules/@gleanwork/mcp-server-tester/schema/eval-dataset.schema.json"
    }
  ]
}
```

## Validating in code

Use any draft-07 validator, such as [`ajv`](https://ajv.js.org/):

```js
import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';

const schema = JSON.parse(
  await readFile(
    'node_modules/@gleanwork/mcp-server-tester/schema/eval-dataset.schema.json',
    'utf8'
  )
);
const dataset = JSON.parse(await readFile('data/my-evals.json', 'utf8'));
const validate = new Ajv({ strict: false }).compile(schema);
if (!validate(dataset)) console.error(validate.errors);
```
