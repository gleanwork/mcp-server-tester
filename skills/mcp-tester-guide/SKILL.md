---
name: mcp-tester-guide
description: Reference for @gleanwork/mcp-server-tester (MST) 2.0, the Playwright-based testing and evaluation framework for MCP servers, with the `mst` CLI. Covers the vocabulary (test, eval, case, client, variant, trial, assertion, judge), entry points, server config and auth, the mcp fixture and matchers, eval datasets and eval configs, clients, judges, plugins, the reporter, CLI commands, what 1.x names became, and common mistakes. Use when working on MCP server tests or evals, or reading or upgrading code that uses MST.
metadata:
  author: gleanwork
  version: '2.0.0'
---

# MST reference

MST (`@gleanwork/mcp-server-tester`, CLI `mst`) tests and evaluates MCP servers. Requires Node.js 22 or later. 2.0 is in beta: `npm install --save-dev @gleanwork/mcp-server-tester@beta @playwright/test`.

- **Tests** check a server directly, with no client: a Playwright test calls a tool through the `mcp` fixture and checks the result with MST's matchers. Deterministic; run once. Skill: `write-mcp-test`.
- **Evals** have a client act on cases and grade what it did. A client (such as Claude Code) runs each case's input with a model; assertions and judges score each trial. Non-deterministic; run several trials. Skill: `write-mcp-eval`.
- **Tool optimization** runs tool-metadata variants against a baseline and recommends applying one or none. Skill: `optimize-mcp-tool-metadata`.

## Vocabulary

MST uses these terms in its API, config keys, CLI and reports. Use them, and not the old ones in the last column.

| Term           | Meaning                                                                                    | Not                |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------ |
| eval           | What to evaluate and how: datasets, variants, graders, metrics                             | suite              |
| eval config    | The JSON file that defines one eval; `mst run` runs one                                    | manifest           |
| dataset        | A named list of cases                                                                      | eval set           |
| case           | One input for a client to act on, with what is expected                                    | scenario, test     |
| input          | The user's request, sent to the client as its prompt                                       | scenario           |
| expected       | A case's ground truth: an answer, rubric criteria                                          | golden             |
| client         | The MCP client application under test: `mst`, `claude-code`, `cowork`, `chatgpt`           | host               |
| model          | The LLM the client runs, set beside the client                                             | engine             |
| variant        | One setup an eval tests: client, model and options, servers, tool metadata                 | arm                |
| baseline       | The variant the others are compared with (the first, unless `baseline` names one)          | control            |
| tool metadata  | Tool names, descriptions and input schemas a variant shows the client (`tools`)            | tool overrides     |
| trial          | One attempt at a case by one variant                                                       | iteration          |
| trace          | What a client did in a trial: tool calls, skill loads, usage, final answer                 | transcript         |
| grader         | An assertion (code) or a judge (model)                                                     | scorer             |
| assertion      | A deterministic check of a trial's trace or answer (`toolsTriggered`, `containsText`, ...) | expectation        |
| judge          | An LLM that scores a trial against expected or a rubric                                    | evaluator          |
| score          | A grader's result for one trial: 0 to 1, pass, and why                                     | verdict            |
| pass threshold | The share of a case's trials that must pass (`passThreshold`, default 1)                   | accuracy threshold |
| metric         | An aggregate over a run's trials or cases: pass rate, tool count, tokens, cost             |                    |
| run            | One execution of an eval: every variant on every case                                      | experiment         |
| comparison     | How a variant differs from the baseline, or a run from an earlier run                      | diff               |
| test           | A direct check of a server with MST's fixtures and matchers; not an eval                   | direct case        |

## Entry points

| Import                                               | Holds                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `@gleanwork/mcp-server-tester/fixtures/mcp`          | `test` with the `mcp` and `mcpClient` fixtures, and `expect` with MST's matchers                                                      |
| `@gleanwork/mcp-server-tester`                       | Config, the MCP client, validators, datasets, `runEvalDataset`, `runEvalCase`, judges, conformance, Agent Skills, types               |
| `@gleanwork/mcp-server-tester/evals`                 | `runEval`, `runEvalBatch`, eval configs, `runToolOptimization`, `compareEvalRuns`, baselines, result stores, metrics, pairwise judges |
| `@gleanwork/mcp-server-tester/fixtures/mcpAuth`      | The `mcpAuthProvider` fixture, for building your own authenticated client                                                             |
| `@gleanwork/mcp-server-tester/reporters/mcpReporter` | The Playwright reporter                                                                                                               |
| `@gleanwork/mcp-server-tester/auth`                  | Low-level OAuth: discovery, token storage, client credentials                                                                         |
| `@gleanwork/mcp-server-tester/experimental/clients`  | Desktop client types and Cowork helpers; may change between minor versions                                                            |

The subpaths are ESM only. MCP SDK types come from `@modelcontextprotocol/client` (SDK v2), not `@modelcontextprotocol/sdk`.

## Server config

A Playwright project's `use.mcpConfig`, an eval config's `servers` entries, and `createMCPClientForConfig(config)` take the same shape:

```typescript
import type { MCPConfig } from '@gleanwork/mcp-server-tester';

// stdio: MST starts the server
const local: MCPConfig = {
  transport: 'stdio',
  command: 'node',
  args: ['./dist/server.js'],
  env: { LOG_LEVEL: 'warn' },
  cwd: '.',
};

// HTTP: a running server
const staging: MCPConfig = {
  transport: 'http',
  serverUrl: 'https://mcp.example.com/mcp',
  headers: { 'X-Team': 'docs' },
};
```

`auth` (HTTP only), in the order MST uses them:

1. `oauth: { serverUrl, scopes, authStatePath, clientId?, clientSecret?, redirectUri? }`: the state file a Playwright global setup wrote with `performOAuthSetup()`.
2. `accessToken: process.env.MCP_ACCESS_TOKEN`, or `accessTokenEnv: 'MCP_ACCESS_TOKEN'` (the name of the variable; use this in eval configs).
3. `clientCredentials: { tokenEndpoint, scopes? }`, with `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`.
4. In the `mcp` fixture only: a login stored by `mst login <server-url>`, refreshed as it nears expiry.

`protocol`: `'legacy'` (default, the 1.x handshake), `'auto'`, or a revision such as `'2026-07-28'`. `protocolMatrix(project, ['legacy', '2026-07-28'])` expands one Playwright project per protocol.

## The `mcp` fixture

| Member                              | Does                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `callTool(name, args)`              | Calls a tool; JSON-RPC protocol errors come back as error results (`isError: true`)   |
| `listTools()`                       | Every tool the server lists                                                           |
| `request(method, params, schema)`   | Any MCP request, its result parsed with a Zod schema                                  |
| `listResources()`, `readResource()` | Resources                                                                             |
| `skills`                            | Agent Skills over MCP: `supported()`, `settings()`, `list()`, `get(uri)`, `read(uri)` |
| `discover()`                        | `server/discover` on 2026-07-28 connections; `null` on legacy                         |
| `protocol`                          | Requested and negotiated protocol, and era                                            |
| `getServerInfo()`, `client`         | Server name and version; the raw SDK client                                           |

Fixture options (`test.use({...})` or a project's `use`): `mcpConfig`, `mcpProtocol` (overrides `mcpConfig.protocol`), `mcpPlugins` (plugin objects whose judges matchers use).

## Matchers

Use them on a `callTool` result in a Playwright test.

| Matcher                                            | Passes when                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `toMatchToolResponse(expected)`                    | Deep-equals `expected`                                               |
| `toContainToolText(text, { caseSensitive? })`      | Text contains every substring                                        |
| `toMatchToolPattern(patterns)`                     | Text matches every pattern                                           |
| `toMatchToolSchema(zodSchema)`                     | Structured content (or JSON text) validates                          |
| `toMatchToolSnapshot(name, sanitizers?)`           | Matches the saved snapshot. Async                                    |
| `toBeToolError(expected?)`                         | Is an error; a string or list checks the message                     |
| `toHaveToolResponseSize({ minBytes?, maxBytes? })` | Text size in UTF-8 bytes is within bounds                            |
| `toSatisfyToolPredicate(fn, description?)`         | `fn(response, text)` returns `true` or `{ pass: true }`. Async       |
| `toPassToolJudge(rubric, options?)`                | A judge's mean score reaches `passingThreshold` (default 0.7). Async |
| `toHaveToolCalls(assertion)`                       | A client trace (`MstClientSimulationResult`) has the calls           |
| `toHaveToolCallCount({ min?, max?, exact? })`      | A client trace has that many calls                                   |

Sanitizers: `'uuid'`, `'iso-date'`, `'timestamp'`, `'jwt'`, `'objectId'`, `{ pattern, replacement }`, `{ remove: ['field', 'nested.field'] }`. Update snapshots with `npx playwright test --update-snapshots`.

For use outside Playwright, each matcher has a function that returns `{ pass, message }`: `validateText`, `validatePattern`, `validateSchema`, `validateError`, `validateSize`, `validateResponse`, `validatePredicate`, `validateJudge`, `validateSnapshot`, `validateToolCalls`, `validateToolCallCount`.

## Eval datasets

```json
{
  "name": "search-evals",
  "cases": [
    {
      "id": "find-planning-doc",
      "input": "Find the Q3 planning document",
      "expected": { "answer": "The Q3 plan is in Planning/Q3.md." },
      "tags": ["regression"],
      "trials": 10,
      "passThreshold": 0.8,
      "assertions": {
        "toolsTriggered": { "calls": [{ "name": "search", "required": true }] },
        "toolCallCount": { "max": 4 }
      },
      "judges": [
        { "type": "rubric", "rubric": "correctness", "threshold": 0.7 }
      ]
    }
  ]
}
```

Case keys: `id`, `input` (both required), `description`, `expected`, `assertions`, `judges`, `tags`, `trials`, `passThreshold`, `judgeReps`, `client`, `model`, `clientOptions`, `metadata`. Assertions: `toolsTriggered` (`calls` with `name`, `required`, `arguments` with `$pattern`/`$flags`, `server`, `kind`, `source`; `order`; `exclusive`), `toolCallCount`, `containsText`, `matchesPattern` (on the final answer). Judges go in `judges`, beside `assertions`. Unknown keys fail validation. Load with `loadEvalDataset(path)` or `loadEvalDatasetFromObject(object)`; check with `validateEvalDataset(object)`.

Run in a Playwright test, on the `mst` client and the test's MCP connection:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('search evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./evals/search-evals.json');
  const result = await runEvalDataset(
    { dataset, client: 'mst', model: 'claude-haiku-4-5', defaultTrials: 10 },
    { mcp, testInfo }
  );
  expect(result.failed).toBe(0);
});
```

One case: `runEvalCase(evalCase, { mcp, testInfo }, { client: 'mst', model })`. With one trial, its result's `response` is the client trace that `toHaveToolCalls` reads.

## Eval configs

```json
{
  "name": "search-evals",
  "datasets": ["./search-evals.json"],
  "servers": {
    "docs": {
      "transport": "stdio",
      "command": "node",
      "args": ["./dist/server.js"]
    }
  },
  "client": "claude-code",
  "model": "claude-sonnet-4-6",
  "trials": 10,
  "variants": [
    { "name": "current" },
    {
      "name": "explicit-search",
      "tools": {
        "search": { "description": "Search internal documents first." }
      }
    }
  ]
}
```

`servers` is a map keyed by label; a variant lists labels (none means all). Without `client`, an eval config runs on `claude-code`. Run with `npx mst run --config eval.json` (`--dry-run` to validate), or `runEval({ configPath })` from `./evals`. Every key: the `write-mcp-eval` skill's `references/eval-configs.md`.

## Clients

| Client                      | What it is                                                           | Runs                                  |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `mst`                       | MST's own client: the model gets the servers' tools and nothing else | Playwright and `mst run`              |
| `claude-code`               | Claude Code, with an empty config directory                          | `mst run`                             |
| `cowork`                    | Claude Cowork in Claude Desktop                                      | `mst run` (macOS: `mst cowork setup`) |
| `chatgpt`                   | The ChatGPT desktop app                                              | `mst run`                             |
| `<namespace>/client/<name>` | A plugin's client                                                    | `mst run`                             |

The `mst` client infers the API from the model id (`claude-*` Anthropic, `claude-*@date` Vertex, `gpt-*` OpenAI, `gemini-*` Google). It needs `ai` and the provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/google-vertex`, `@ai-sdk/mistral`, `@ai-sdk/azure`, `@ai-sdk/deepseek`, `@ai-sdk/xai`, `@openrouter/ai-sdk-provider`), installed as optional dependencies, and the API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, ...). Its `clientOptions`: `provider`, `maxToolCalls` (default 5), `temperature`, `maxTokens`, `timeout`, `apiKeyEnvVar`, `systemPrompt`, `skills` (`off`, `catalog`, `preload`), `env`. Gateways: set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` with a gateway credential (`docs/llm-gateways.md`).

## Judges

- Built-in rubrics: `correctness`, `completeness`, `groundedness`, `instruction-following`, `conciseness`, or `{ "text": "..." }`.
- Providers: `anthropic` (default; needs `@anthropic-ai/sdk`), `vertex-anthropic`, `anthropic-agent-sdk` (needs `@anthropic-ai/claude-agent-sdk`), `openai`, `google`.
- In a case: `judges: [{ "type": "rubric", rubric, threshold?, reference?, reps?, provider?, model? }]`, or a plugin judge's name. `expected.answer` is the default reference. Every listed judge must pass. An eval config's `judges` apply to every case, on top of its own; the case's settings win for a judge both name.
- In a matcher: `toPassToolJudge(rubric, { passingThreshold, reference, reps, provider, model })`.
- A plugin's judge: `"acme/judge/completeness"` in `judges` (or `{ judge: 'acme/judge/completeness' }` in `toPassToolJudge`), with the plugin loaded (`plugins` in `runEvalDataset` or the eval config, `mcpPlugins` for matchers).

## Plugins

A plugin is a plain object, the default export of a module or package, that MST reads. It never calls MST to register.

```typescript
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

export default {
  meta: { name: '@acme/mst-plugin', version: '1.0.0', namespace: 'acme' },
  judges: {
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async ({ case: c, trial }) => ({
        score: trial.text.includes(String(c.expected.answer ?? '')) ? 1 : 0,
        reasoning: 'Answer contains the expected text',
      }),
    },
  },
} satisfies Plugin;
```

Keys: `datasetSources`, `clients`, `judges`, `pairwiseJudges`, `metrics`, `resultStores`, `connectors`, `configs`. An extension's name is `<namespace>/<kind>/<name>`, where the kind comes from the key: `acme/dataset/…`, `acme/client/…`, `acme/judge/…`, `acme/pairwise-judge/…`, `acme/metric/…`, `acme/result-store/…`, `acme/connector/…`, `acme/config/…`. A two-part name such as `acme/completeness` fails with the full one. Built-ins use bare names (`file`, `rubric`, `passed`) or `mst/<kind>/<name>`; plugins can't use the `mst` namespace.

## Reporter

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    [
      '@gleanwork/mcp-server-tester/reporters/mcpReporter',
      { outputDir: '.mcp-test-results', autoOpen: false },
    ],
  ],
});
```

Options: `outputDir` (default `.mcp-test-results`), `name` (the eval's name, default `playwright`), `autoOpen`, `quiet`, `resultStore`, `runMetadata`. Each Playwright run's eval results are a run directory (`<outputDir>/<name>/runs/<run-id>/`) with a variant per project and the same report `mst run` writes; open it with `npx mst open`. Tests and conformance checks are in Playwright's own report.

## CLI

| Command                                                  | Does                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npx @gleanwork/mcp-server-tester@beta init`             | Scaffold a project: Playwright config, a tool test, a dataset                                                                  |
| `mst generate [-o tests/generated.spec.ts] [--snapshot]` | Call tools interactively and write the calls as a Playwright spec                                                              |
| `mst login <server-url> [--scopes a,b] [--force]`        | OAuth login; the `mcp` fixture uses the stored tokens                                                                          |
| `mst token <server-url> [--format env\|json\|gh]`        | Print stored tokens for CI                                                                                                     |
| `mst run --config <path>`                                | Run an eval config. `--variant`, `--case <ids...>`, `--trials <n>`, `--plugins`, `--output-dir`, `--secrets-file`, `--dry-run` |
| `mst batch --config-dir <dir>`                           | Run several eval configs. `--configs`, `--workers`, `--skip-existing`, `--dry-run`                                             |
| `mst auth --config <path>`                               | Sign in to an eval config's connector servers (`status`, `revoke`)                                                             |
| `mst open [run or eval dir]`                             | Open a run's report: the newest run, or the one named. `--print` prints its path                                               |
| `mst cowork setup`                                       | Prepare Claude Desktop's profile for the `cowork` client (macOS)                                                               |

Inside a project, `npx mst` and `npx mcp-server-tester` run the same binary. Before installing, use `npx @gleanwork/mcp-server-tester@beta`: `npx mst` alone downloads an unrelated package.

## What 1.x names became

Old names are errors that name their replacement, not aliases.

| 1.x                                                                      | 2.0                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `mode: 'direct'`, `toolName` + `args`, `request` cases                   | Playwright tests with `mcp.callTool()` / `mcp.request()` and matchers                                        |
| `response`, `schema`, `snapshot`, `isError`, `responseSize` assertions   | `toMatchToolResponse`, `toMatchToolSchema`, `toMatchToolSnapshot`, `toBeToolError`, `toHaveToolResponseSize` |
| `mode: 'mcp_host'`, `mcpHostConfig`                                      | Every case runs on a client: `client`, `model`, `clientOptions`                                              |
| `scenario`, `expect`, `canonicalAnswer`                                  | `input`, `assertions`, `expected.answer`                                                                     |
| `iterations`, `accuracyThreshold`                                        | `trials`, `passThreshold`                                                                                    |
| `iterationResults`, `assertionPassRate`, `expectations` (results)        | `trialResults`, `passRate`, `scores`                                                                         |
| manifest, `arms`, `toolOverrides`                                        | eval config, `variants`, `tools`                                                                             |
| `servers: [{ "label": "x", ... }]`, server objects in a variant          | `servers: { "x": { ... } }`, variants list labels                                                            |
| `mst run --manifest`, `--arm`; `mst batch --manifests`, `--manifest-dir` | `--config`, `--variant`; `--configs`, `--config-dir`                                                         |
| `runEvalSuite`, `runVariantExperiment`                                   | `runEval`, `runToolOptimization` (from `./evals`)                                                            |
| `simulateMCPHost`, `vercel-sdk`, `claude-cli`                            | the `mst` and `claude-code` clients                                                                          |
| `registerJudge`                                                          | a plugin's `judges`                                                                                          |
| `acme/completeness` (two-part names)                                     | `acme/judge/completeness`                                                                                    |
| `@modelcontextprotocol/sdk`                                              | `@modelcontextprotocol/client`                                                                               |

Full list: `docs/migrations/migration-2.0.md`.

## Common mistakes

- **`expect` from `@playwright/test`.** It has no MST matchers. Import `test` and `expect` from `@gleanwork/mcp-server-tester/fixtures/mcp`.
- **Missing `await`.** `toMatchToolSnapshot`, `toSatisfyToolPredicate` and `toPassToolJudge` are async; without `await`, a failure may not fail the test.
- **A tool call in a dataset.** `toolName`/`args` cases fail to load. Write a Playwright test.
- **Tool-call assertions on a tool response.** `toHaveToolCalls` and `toolsTriggered` read a client's trace. A `callTool` result has none.
- **One trial.** A single trial can't tell a good description from a lucky one. Use 10 or more for decisions.
- **`url` for an HTTP server.** The key is `serverUrl`.
- **No `client` in an eval config.** It runs on `claude-code`. Name the client.
- **A server array.** `servers` is a map keyed by label; variants list labels.
- **Secrets in configs.** Use `accessTokenEnv`, the environment, or `--secrets-file`.
- **`runEvalDataset(dataset, mcp)`.** It takes two objects: `runEvalDataset({ dataset, ... }, { mcp, testInfo })`.
- **A non-mst client in Playwright.** `runEvalDataset` runs only `mst`. Run `claude-code`, `cowork`, `chatgpt` and plugin clients with `mst run`.
