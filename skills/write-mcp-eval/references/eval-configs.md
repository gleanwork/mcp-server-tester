# Eval config reference

An eval config is the JSON file that defines one eval: its datasets, the servers under test, the client and model, the variants to compare, and the graders and metrics. `mst run --config <path>` runs one. The schema is strict: an unknown key, or a key from 1.x, fails validation with a message naming the replacement. `npx mst run --config <path> --dry-run` checks the config, its plugins and its datasets without running anything.

## Keys

| Key                                                               | Meaning                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `name`                                                            | Required. Identifies the eval; runs with the same name share a history                           |
| `datasets`                                                        | Required. Paths (relative to the config) or tagged sources (below)                               |
| `servers`                                                         | The MCP servers under test, a map keyed by label                                                 |
| `client`                                                          | `mst`, `claude-code`, `cowork`, `chatgpt`, or `<namespace>/client/<name>`. Default `claude-code` |
| `model`                                                           | The model the client runs. Without it, the client's default                                      |
| `clientOptions`                                                   | The client's other options (below)                                                               |
| `variants`                                                        | The setups to compare. Without any, one variant named `default` runs the config as written       |
| `baseline`                                                        | The variant the others are compared with. Default: the first                                     |
| `tools`                                                           | Tool metadata every variant shows its client, unless it sets its own                             |
| `toolMap`                                                         | Canonical tool name to the native names a client reports, for assertions                         |
| `inputTemplate`                                                   | Wraps each case's input: `{{input}}` is replaced by it                                           |
| `judges`                                                          | Judges added to every case's own `judges`                                                        |
| `pairwiseJudges`                                                  | Pairwise judges that compare each variant with the baseline, case by case (top level only)       |
| `metrics`                                                         | Metrics to report beyond the defaults                                                            |
| `trials`, `passThreshold`                                         | Defaults for cases that don't set their own                                                      |
| `maxCases`, `concurrency`, `filterTags`                           | Run controls. All five run controls may also go under `run`: `"run": { "trials": 5 }`            |
| `provider`, `maxToolCalls`, `timeout`, `temperature`, `maxTokens` | Defaults for the client option of the same name, for clients that take it                        |
| `results`                                                         | Where runs are stored: `{ "store": { "type": "file", "dir": ".mcp-test-results" } }`             |
| `plugins`                                                         | Plugin modules or packages to load                                                               |
| `extends`                                                         | Shared configs from those plugins: `["acme/config/recommended"]`                                 |
| `pricing`                                                         | USD per million tokens by model, to estimate cost for clients that report only tokens            |
| `redactStoredResponses`                                           | Set `false` to keep answers and tool outputs in stored results (removed by default)              |

## Datasets

```json
"datasets": [
  "./cases/search.json",
  { "type": "dir", "path": "./cases", "recursive": true },
  { "type": "gcs", "uri": "gs://my-bucket/evals/search.json" },
  { "type": "acme/dataset/info-seeking" }
]
```

A bare path is short for `{ "type": "file", "path": "..." }`. `dir` merges every `.json` file in the directory. `gcs` needs `@google-cloud/storage` and Application Default Credentials. A plugin's dataset source is named `<namespace>/dataset/<name>`, with its own options.

## Servers

Define each server once, keyed by its label. A variant lists the labels it uses.

```json
"servers": {
  "local": {
    "transport": "stdio",
    "command": "node",
    "args": ["./dist/server.js"],
    "env": { "LOG_LEVEL": "warn" }
  },
  "staging": {
    "transport": "http",
    "serverUrl": "https://staging.example.com/mcp",
    "auth": { "accessTokenEnv": "STAGING_MCP_TOKEN" }
  }
}
```

- An entry doesn't set `label`: the key is the label. Tool calls in traces and metrics carry it (`staging.search`).
- `auth.accessTokenEnv` names the environment variable that holds a bearer token. Supply it from the environment or `--secrets-file`; never write a token into the file.
- A plugin connector names a vendor server instead of a transport: `"slack": { "connector": "acme/connector/slack" }`. Sign in once with `npx mst auth --config <path>`.
- Point servers that can write data at test tenants or test accounts.

## Clients

| Client                      | What it is                                                           | Notes                                                                                     |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mst`                       | MST's own client: the model gets the servers' tools and nothing else | Isolates the model and your tool metadata. Options below                                  |
| `claude-code`               | Claude Code                                                          | Runs with an empty config directory, so your own skills and settings don't affect results |
| `cowork`                    | Claude Cowork in Claude Desktop                                      | macOS (run `npx mst cowork setup` once) or a prepared Linux desktop. See `docs/cowork.md` |
| `chatgpt`                   | The ChatGPT desktop app                                              | Needs `model`. Can't show tool metadata (`tools`). See `docs/chatgpt-desktop.md`          |
| `<namespace>/client/<name>` | A plugin's client                                                    | Options are the plugin's                                                                  |

`mst` options: `provider` (inferred from the model id unless set: `anthropic`, `openai`, `google`, `vertex-anthropic`, `mistral`, `azure`, `deepseek`, `openrouter`, `xai`), `maxToolCalls` (default 5), `temperature`, `maxTokens`, `timeout`, `apiKeyEnvVar`, `systemPrompt`, `skills` (`off`, `catalog`, `preload`), `env`.

`claude-code` options: `provider` (`anthropic`, `vertex`, `vertex-anthropic`), `timeout`, `systemPrompt` (passed with `--append-system-prompt`), `isolate` (`false` to use your own Claude Code configuration), `env`.

`systemPrompt` is a validation error for `cowork` and `chatgpt`, which take organisation instructions from the app.

## Variants

```json
"variants": [
  { "name": "current", "servers": ["local"] },
  { "name": "sonnet", "servers": ["local"], "model": "claude-sonnet-4-6" },
  {
    "name": "explicit-search",
    "servers": ["local"],
    "description": "Say when to use search",
    "tools": {
      "search": { "description": "Search internal documents. Use it whenever the user asks to find or look up company information." }
    }
  }
]
```

A variant has a `name` and may set `description`, `servers` (labels), `client`, `model`, `clientOptions`, `tools`, `toolMap`, `inputTemplate`, `metrics` and `judges`. What it doesn't set it inherits from the config.

- **Servers.** A variant that lists no servers uses every server; `[]` uses none.
- **Client options.** A variant (or case) inherits the config's `clientOptions` only when it uses the same client. Its own `clientOptions` override the inherited options they name; the others carry over.
- **Tool metadata.** `tools` is keyed by a tool's name on its server; with several servers, `"server.tool"` picks one. Each entry may set `name`, `description` and `inputSchema`. Calls are recorded under the tool's original name, so assertions read the same in every variant. `mst` applies tool metadata in-process; `claude-code`, `cowork` and plugin clients get it through a local MCP proxy. A key that matches no tool, or several, is an error.
- **Comparisons.** Each variant is compared with the baseline: metric changes, and the cases that improved or regressed.

## Graders and metrics

```json
"judges": [
  { "type": "rubric", "rubric": "correctness" },
  "acme/judge/completeness"
],
"metrics": ["passed", "trial_pass", "tool_count", "mcp_call_count", "input_tokens", "cost_usd", "duration_s", "judge_score"]
```

Config `judges` are added to every case's own `judges`. A variant's `judges` replace the config's. When a case and the config name the same judge, the case's settings win. `pairwiseJudges` (top level only) compare each variant with the baseline, case by case.

Every variant reports `passed_rate`, `trial_pass_rate`, tool and call counts, tokens, cost and time when the client reports them. `metrics` adds more; built-in names include `passed`, `trial_pass`, `tool_count`, `mcp_call_count`, `builtin_event_count`, `first_tool`, `is_no_action`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`, `duration_s`, `response_len`, `skill_loaded`, `tool_search_hit`, `judge_pass` and `judge_score`. A plugin's metric is `<namespace>/metric/<name>`.

## Pricing

```json
"pricing": {
  "claude-sonnet-4-6": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
}
```

MST ships no prices. A cost the client reports always wins; otherwise `cost_usd` is estimated from this table for the model each case ran on. Models it can't price are listed in the variant's `unpricedModels`.

## Plugins and names

```json
"plugins": ["@acme/mst-plugin", "./plugins/local.js"],
"extends": ["acme/config/recommended"]
```

A plugin extension's name is `<namespace>/<kind>/<name>`: `acme/dataset/info-seeking`, `acme/client/assistant`, `acme/judge/completeness`, `acme/metric/hits`, `acme/result-store/bq`, `acme/connector/slack`, `acme/config/recommended`. A two-part name (`acme/completeness`) fails with the full one. Built-ins use bare names (`file`, `rubric`, `passed`) or `mst/<kind>/<name>`. A shared config in `extends` replaces each top-level key it sets; the eval config's own keys replace the shared config's.

## Running

```bash
npx mst run --config eval.json --dry-run
npx mst run --config eval.json --variant explicit-search
npx mst run --config eval.json --case find-planning-doc search-arguments --trials 1
npx mst run --config eval.json --secrets-file .env.eval
npx mst batch --config-dir evals --workers 2
```

`mst run` flags: `-c, --config`, `--variant`, `--case <ids...>`, `--trials <n>`, `--plugins <paths...>`, `--output-dir`, `--root-dir`, `--secrets-file`, `--store`, `--dry-run`. `mst batch` takes `--configs <paths...>` or `--config-dir`, plus `--workers`, `--skip-existing`, `--output-root`.

From code:

```typescript
import { runEval } from '@gleanwork/mcp-server-tester/evals';

const { summary, outputDir } = await runEval({
  configPath: './evals/eval.json',
});
for (const variant of summary.variants)
  console.log(variant.name, variant.metrics);
```

## Results

Each run writes a directory under `.mcp-test-results/<name>/runs/` (or `--output-dir`): `results.json` holds every case result, and `summary.json` has:

- `variants`: each variant's metrics, results and evidence.
- `variantDeltas`: each variant's change from the baseline (`passRate`, `trialPassRate`, `metricDeltas`).
- `previousRun`: the change since the previous run of the same eval config, with `regressed` and `improved` case ids per variant. `sameConfig: false` means the config changed between the runs.
- `results`: every case result, each with its `variant` and `trace`.

Stored results drop answers and tool outputs by default; tool calls, arguments, servers and usage stay.
