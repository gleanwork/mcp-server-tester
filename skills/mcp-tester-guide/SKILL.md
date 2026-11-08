---
name: mcp-tester-guide
description: Reference for @gleanwork/mcp-server-tester (MST) 2.0, the Playwright-based testing and evaluation framework for MCP servers, with the `mst` CLI. Covers which skill to use for a task, the vocabulary (test, eval, case, client, variant, trial, assertion, judge), entry points, server config and auth, clients, judges, plugin names, CLI commands, what 1.x names became, and common mistakes. Use when working on MCP server tests or evals, or reading or upgrading code that uses MST.
metadata:
  author: gleanwork
  version: '2.0.0'
---

# MST reference

MST (`@gleanwork/mcp-server-tester`, CLI `mst`) tests and evaluates MCP servers. Requires Node.js 22 or later. 2.0 is a release candidate, published under the `rc` tag: `npm install --save-dev @gleanwork/mcp-server-tester@rc @playwright/test`. The `beta` tag is older and lacks `mst label` and `mst judges check`.

- **Tests** check a server directly, with no client: a Playwright test calls a tool through the `mcp` fixture and checks the result with MST's matchers. Deterministic; run once.
- **Evals** have a client act on cases and grade what it did. A client (such as Claude Code) runs each case's input with a model; assertions and judges score each trial. Non-deterministic; run several trials.

## Which skill

| Task                                                                    | Skill                        |
| ----------------------------------------------------------------------- | ---------------------------- |
| Write Playwright tests: tool calls, matchers, snapshots, auth, protocol | `write-mcp-test`             |
| Write eval datasets, cases, assertions, judges and eval configs         | `write-mcp-eval`             |
| Run an eval, read its results, resume or regrade a run, Docker, CI      | `run-mcp-eval`               |
| Decide whether a judge can be trusted: label trials, `mst judges check` | `calibrate-mcp-judge`        |
| Improve tool names and descriptions, measured against a baseline        | `optimize-mcp-tool-metadata` |

## Vocabulary

MST uses these terms in its API, config keys, CLI and reports. Use them, and not the old ones in the last column.

| Term           | Meaning                                                                                                    | Not                |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| eval           | What to evaluate and how: datasets, variants, graders, metrics                                             | suite              |
| eval config    | The JSON file that defines one eval; `mst run` runs one                                                    | manifest           |
| dataset        | A named list of cases                                                                                      | eval set           |
| case           | One input for a client to act on, with what is expected                                                    | scenario, test     |
| input          | The user's request, sent to the client as its prompt                                                       | scenario           |
| expected       | A case's ground truth: an answer, rubric criteria                                                          | golden             |
| client         | The MCP client application under test: `api`, `claude-code`, `codex-cli`, `cowork`, `chatgpt`, `codex-app` | host               |
| model          | The LLM the client runs, set beside the client                                                             | engine             |
| variant        | One setup an eval tests: client, model and options, servers, tool metadata                                 | arm                |
| baseline       | The variant the others are compared with (the first, unless `baseline` names one)                          | control            |
| tool metadata  | Tool names, descriptions and input schemas a variant shows the client (`tools`)                            | tool overrides     |
| trial          | One attempt at a case by one variant                                                                       | iteration          |
| trace          | What a client did in a trial: tool calls, skill loads, usage, final answer                                 | transcript         |
| grader         | An assertion (code) or a judge (model)                                                                     | scorer             |
| assertion      | A deterministic check of a trial's trace or answer (`toolsTriggered`, `containsText`, ...)                 | expectation        |
| judge          | An LLM that scores a trial against expected, a question or a rubric                                        | evaluator          |
| score          | A grader's result for one trial: 0 to 1, pass, and why                                                     | verdict            |
| label          | A person's pass or fail for a judge's question on one trial, which a judge is measured against             | annotation         |
| pass threshold | The share of a case's trials that must pass (`passThreshold`, default 1)                                   | accuracy threshold |
| metric         | An aggregate over a run's trials or cases: pass rate, tool count, tokens, cost                             |                    |
| run            | One execution of an eval: every variant on every case                                                      | experiment         |
| comparison     | How a variant differs from the baseline, or a run from an earlier run                                      | diff               |
| test           | A direct check of a server with MST's fixtures and matchers; not an eval                                   | direct case        |

## Entry points

| Import                                               | Holds                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `@gleanwork/mcp-server-tester/fixtures/mcp`          | `test` with the `mcp` and `mcpClient` fixtures, and `expect` with MST's matchers                                                      |
| `@gleanwork/mcp-server-tester`                       | Config, the MCP client, validators, datasets, `runEvalDataset`, `runEvalCase`, judges, conformance, Agent Skills, types               |
| `@gleanwork/mcp-server-tester/evals`                 | `runEval`, `runEvalBatch`, eval configs, `runToolOptimization`, `compareEvalRuns`, baselines, result stores, metrics, pairwise judges |
| `@gleanwork/mcp-server-tester/fixtures/mcpAuth`      | The `mcpAuthProvider` fixture, for building your own authenticated client                                                             |
| `@gleanwork/mcp-server-tester/reporters/mcpReporter` | The Playwright reporter: eval results as a run that `mst open` opens                                                                  |
| `@gleanwork/mcp-server-tester/auth`                  | Low-level OAuth: discovery, token storage, client credentials                                                                         |
| `@gleanwork/mcp-server-tester/experimental/clients`  | Desktop client types and Cowork helpers; may change between minor versions                                                            |

The subpaths are ESM only. MCP SDK types come from `@modelcontextprotocol/client` (SDK v2), not `@modelcontextprotocol/sdk`.

## Server config

A Playwright project's `use.mcpConfig`, an eval config's `servers` entries, and `createMCPClientForConfig(config)` take the same shape: `{ transport: 'stdio', command, args?, env?, cwd? }`, where MST starts the server, or `{ transport: 'http', serverUrl, headers? }` for a running one.

`auth` (HTTP only), in the order MST uses them:

1. `oauth: { serverUrl, scopes, authStatePath, ... }`: the state file a Playwright global setup wrote with `performOAuthSetup()`.
2. `accessToken: process.env.MCP_ACCESS_TOKEN`, or `accessTokenEnv: 'MCP_ACCESS_TOKEN'` (the name of the variable; use this in eval configs).
3. `clientCredentials: { tokenEndpoint, scopes? }`, with `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`.
4. In the `mcp` fixture only: a login stored by `mst login <server-url>`, refreshed as it nears expiry.

`protocol`: `'legacy'` (default, the 1.x handshake), `'auto'`, or a revision such as `'2026-07-28'`. Examples: `write-mcp-test`.

## Clients

| Client                      | What it is                                                           | Runs                                  |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `api`                       | The model alone, through its provider's API, with the servers' tools | Playwright and `mst run`              |
| `claude-code`               | Claude Code, with an empty config directory                          | `mst run`                             |
| `cowork`                    | Claude Cowork in Claude Desktop                                      | `mst run` (macOS: `mst cowork setup`) |
| `codex-cli`                 | The Codex CLI, headless                                              | `mst run`                             |
| `chatgpt`                   | The ChatGPT desktop app                                              | `mst run`                             |
| `codex-app`                 | The Codex surface of the ChatGPT desktop app                         | `mst run`                             |
| `<namespace>/client/<name>` | A plugin's client                                                    | `mst run`                             |

The `api` client needs `ai`, its provider's package (such as `@ai-sdk/anthropic`) and the API key. Options and the other clients' needs: `write-mcp-eval`.

## Judges

- **Yes-or-no judges** read the whole trace and answer yes, no or `unknown`: `task-completion`, `grounded-in-tools`, `tool-use`, and `criteria` (the case's own criteria, one question each).
- **`rubric`** scores the answer from 0 to 1 against a built-in rubric (`correctness`, `completeness`, `groundedness`, `instruction-following`, `conciseness`) or your own text.
- **`preference`** is a pairwise judge: which variant did better on a case, against the baseline.
- **Plugin judges** are named `<namespace>/judge/<name>`, such as `"acme/judge/completeness"`.
- **Trust is measured, not assumed.** No judge is calibrated for your data until you label trials and run `mst judges check`: `calibrate-mcp-judge`.

In a test, `toPassToolJudge(rubric, options?)` grades a tool response. In a case or an eval config, judges go in `judges`, beside `assertions`: `write-mcp-eval`.

## Plugin names

A plugin is a plain object, the default export of a module or package, with `meta: { name, version, namespace }` and keys such as `judges`, `clients`, `datasetSources`, `metrics`, `resultStores`, `connectors`, `configs` and `environments`. It never calls MST to register.

An extension's name is `<namespace>/<kind>/<name>`, where the kind comes from the key: `acme/judge/…`, `acme/client/…`, `acme/dataset/…`, `acme/pairwise-judge/…`, `acme/metric/…`, `acme/result-store/…`, `acme/connector/…`, `acme/config/…`, `acme/env/…`. A two-part name such as `acme/completeness` fails with the full one. Built-ins use bare names (`file`, `rubric`, `passed`) or `mst/<kind>/<name>`; plugins can't use the `mst` namespace.

## CLI

| Command                                         | Does                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npx @gleanwork/mcp-server-tester@rc init`      | Scaffold a project: Playwright config, a tool test, a dataset. `--command` or `--url`, `--name`, `--no-install`, `--force` |
| `mst generate --tool <name> --args <json>`      | Call a tool and write the call as a Playwright test. `--command`, `--url` or `--config`; `-o`, `--snapshot`, `--name`      |
| `mst login <server-url>`                        | OAuth login in a browser; the `mcp` fixture uses the stored tokens. `--scopes a,b`, `--force`                              |
| `mst token <server-url> --format env\|json\|gh` | Print stored tokens for CI                                                                                                 |
| `mst run --config <path>`                       | Run an eval config (`run-mcp-eval`)                                                                                        |
| `mst grade <run> --config <path>`               | Grade a stored run's traces again, as a new run                                                                            |
| `mst open`                                      | Open a run's report: the newest run, or the run or eval directory named                                                    |
| `mst batch --config-dir <dir>`                  | Run several eval configs                                                                                                   |
| `mst label page <run> --judge <name>`           | Label a judge's trials on a local page (`calibrate-mcp-judge`); `export` and `import` for spreadsheets                     |
| `mst judges check <run> --judge <name>`         | Measure a judge against labels; `mst judges` lists judges                                                                  |
| `mst clients`, `mst datasets`                   | List clients and plugin datasets                                                                                           |
| `mst auth --config <path>`                      | Sign in to an eval config's connector servers (`status`, `revoke`)                                                         |
| `mst optimize start --config <path>`            | Improve tool metadata a round at a time (`optimize-mcp-tool-metadata`)                                                     |
| `mst env setup docker`, `mst runs list`         | Prepare Docker; follow detached runs                                                                                       |
| `mst cowork setup`                              | Prepare Claude Desktop's profile for the `cowork` client (macOS)                                                           |

No command needs a terminal. In one, `init` and `generate` ask for what the flags leave out; in an agent's shell they take every answer from flags and name the flag they need. `generate` without `--tool` asks which tools to call, so an agent passes `--tool`. Without a terminal, `mst login` prints the sign-in URL instead of opening a browser and waits: run it in the background and give the user the URL. `2.0.0-rc.0` and older fail in an agent's shell with `Raw mode is not supported on the current process.stdin`; upgrade it.

Inside a project, `npx mst` and `npx mcp-server-tester` run the same binary. Before installing, use `npx @gleanwork/mcp-server-tester@rc`: `npx mst` alone downloads an unrelated package. Every flag: [CLI reference](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/cli.md).

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
| `simulateMCPHost`, `vercel-sdk`, `claude-cli`                            | the `api` and `claude-code` clients                                                                          |
| `registerJudge`                                                          | a plugin's `judges`                                                                                          |
| `acme/completeness` (two-part names)                                     | `acme/judge/completeness`                                                                                    |
| `@modelcontextprotocol/sdk`                                              | `@modelcontextprotocol/client`                                                                               |

Full list: [the 2.0 migration guide](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/migrations/migration-2.0.md).

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
- **A non-api client in Playwright.** `runEvalDataset` runs only `api`. Run `claude-code`, `codex-cli`, `cowork`, `chatgpt`, `codex-app` and plugin clients with `mst run`.
- **Trusting a judge's pass rate unchecked.** Calibrate it against your own labels first.
