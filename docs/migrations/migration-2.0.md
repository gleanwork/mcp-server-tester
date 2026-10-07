# Migration Guide: v1.x to v2.0 (MCP SDK v2 and protocol versions)

MST 2.0 moves to the [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) and adds support for the 2026-07-28 protocol alongside the legacy one. **By default, connections behave exactly as in 1.x**: `protocol` defaults to `'legacy'`, and a golden wire transcript test guards that the default sends the same messages as before.

This guide covers upgrading from 1.x (the last 1.x release is 1.1.1). Features first released in a 2.0 prerelease are listed under [New in 2.0](#new-in-20-non-breaking), in their final form. If you used a 2.0 prerelease, read [Upgrading from a 2.0 prerelease](./2.0-prereleases.md) as well.

## Table of Contents

- [SDK types and imports](#sdk-types-and-imports)
- [Imports moved to subpaths](#imports-moved-to-subpaths)
- [`mcp.callTool()` returns protocol errors as error results](#mcpcalltool-returns-protocol-errors-as-error-results)
- [Custom `MCPFixtureApi` objects need new members](#custom-mcpfixtureapi-objects-need-new-members)
- [Conformance results: severity, skips, and new checks](#conformance-results-severity-skips-and-new-checks)
- [`compareEvalRuns()` returns `warnings`](#compareevalruns-returns-warnings)
- [`MCP_PROTOCOL_VERSION` is deprecated](#mcp_protocol_version-is-deprecated)
- [`.not` works on `toSatisfyToolPredicate`, `toMatchToolSnapshot` and `toPassToolJudge`](#not-works-on-tosatisfytoolpredicate-tomatchtoolsnapshot-and-topasstooljudge)
- [LLM judges share one prompt, parser and size limit](#llm-judges-share-one-prompt-parser-and-size-limit)
- [MCP reporter attachments](#mcp-reporter-attachments)
- [Stored results are redacted the same way everywhere](#stored-results-are-redacted-the-same-way-everywhere)
- [Which credentials are used](#which-credentials-are-used)
- [Custom judges are plugins](#custom-judges-are-plugins)
- [Every judge runs the same way](#every-judge-runs-the-same-way)
- [LLM calls: bearer tokens and streaming](#llm-calls-bearer-tokens-and-streaming)
- [Server comparisons are suite variants](#server-comparisons-are-suite-variants)
- [The Claude Agent SDK is an optional peer dependency](#the-claude-agent-sdk-is-an-optional-peer-dependency)
- [`getResponseSizeBytes` is no longer exported](#getresponsesizebytes-is-no-longer-exported)
- [`runVariantExperiment` needs clear evidence to recommend a variant](#runvariantexperiment-needs-clear-evidence-to-recommend-a-variant)
- [Client cases name a client and model, not `mcpHostConfig`](#client-cases-name-a-client-and-model-not-mcphostconfig)
- [Direct cases are Playwright tests](#direct-cases-are-playwright-tests)
- [The simulator and the external-host runtime are internal](#the-simulator-and-the-external-host-runtime-are-internal)
- [Eval configs and variants](#eval-configs-and-variants)
- [New in 2.0 (non-breaking)](#new-in-20-non-breaking)

---

## SDK types and imports

**Affects:** code that imports from `@modelcontextprotocol/sdk` or uses `mcp.client` / the `mcpClient` fixture directly.

`mcp.client` and `mcpClient` are now a v2 SDK `Client` from `@modelcontextprotocol/client`. Types, transports, and auth helpers all come from that package's root:

```typescript
// Before (1.x)
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

// After (2.0)
import type {
  Tool,
  CallToolResult,
  OAuthClientProvider,
} from '@modelcontextprotocol/client';
```

If you call the raw client, note these SDK v2 behavior changes:

- `McpError` is now `ProtocolError`, and `ErrorCode` is split into `ProtocolErrorCode` (from the server) and `SdkErrorCode` (local, e.g. timeouts).
- `StreamableHTTPError` is now `SdkHttpError`, with the HTTP status on `.status`. Custom auth or transport code that catches HTTP errors needs updating.
- Error messages from the server are no longer prefixed with `MCP error <code>:`. Match on `error.code` instead.
- `client.listTools()`, `listResources()`, and `listPrompts()` fetch every page when called without a cursor (up to 64 pages), and return an empty list (instead of sending the request) when the server did not declare the capability.
- `client.callTool(params, options)` no longer takes a result schema argument, and a tool's `outputSchema` is compiled when the tool is called rather than when it is listed.
- On 2026-07-28 connections a v2 client caches list and read results for their `ttlMs`. MST's clients use a response cache that never serves stale entries, so every fixture call reaches the server; a v2 `Client` you build yourself caches unless you pass a cache of your own.
- Over stdio, stdout lines that are not JSON are skipped instead of failing the connection.
- Closing a client aborts request handlers that are still running.
- OAuth discovery (`discoverOAuthMetadata()`, `auth()`) rejects on network failures such as DNS errors or `ECONNREFUSED` in Node, instead of returning `undefined` as if the server had no metadata.

The SDK ships a codemod for the mechanical parts: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`. See the SDK's [upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md).

Projects created with `npx @gleanwork/mcp-server-tester init` now depend on `@modelcontextprotocol/client` instead of `@modelcontextprotocol/sdk`.

## Imports moved to subpaths

**Affects:** code that imports comparisons, baselines, result stores, variant experiments, or low-level OAuth from the package root. (`simulateMCPHost` is internal now: see [The simulator and the external-host runtime are internal](#the-simulator-and-the-external-host-runtime-are-internal).)

The root now holds the core testing interface: fixtures, matchers and validators, the MCP client, config, datasets with `runEvalDataset` and `runEvalCase`, judges, conformance, and Agent Skills, with the types those use. Everything else moved to a subpath. Apart from the judge registry ([Custom judges are plugins](#custom-judges-are-plugins)) and [`getResponseSizeBytes`](#getresponsesizebytes-is-no-longer-exported), nothing was renamed or removed; only the import path changed.

| Subpath                              | What it holds                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gleanwork/mcp-server-tester/evals` | The evaluation framework: eval configs, suites and batches, extension definition types, metrics, result stores, baselines and comparisons, and variant experiments. |
| `@gleanwork/mcp-server-tester/auth`  | Low-level OAuth: discovery, token storage, and the client-credentials flow.                                                                                         |

```typescript
// Before (1.x)
import {
  loadEvalDataset,
  compareEvalRuns,
  runVariantExperiment,
} from '@gleanwork/mcp-server-tester';

// After
import { loadEvalDataset } from '@gleanwork/mcp-server-tester';
import {
  compareEvalRuns,
  runVariantExperiment,
} from '@gleanwork/mcp-server-tester/evals';
```

The subpaths are ESM only (no `require` condition, and no `typesVersions`, so TypeScript needs `moduleResolution` `node16`, `nodenext` or `bundler`); the root still ships CommonJS as well. CommonJS code can no longer `require` a moved name, so code that uses one must move to ESM. Don't mix `require` of the root with `import()` of a subpath: the CommonJS root is a separate copy of the library, so its classes and module state are not the ESM copy's. Installed plugins are the exception: both copies share them. The ESM root and the subpaths share one copy.

Some root APIs take options typed from a subpath: `runEvalDataset`'s result-store options (`EvalResultStoreLike`, `StoredEvalResult*Options`) are in `./evals`, and the OAuth providers' stored-state types are in `./auth`. Import those types from the subpath when you name them.

Before 2.0 GA, exports that are neither documented nor used may still be removed; any removal will be listed in this guide.

If TypeScript reports that the package has no exported member, find the name below.

These names moved:

- **`@gleanwork/mcp-server-tester/evals`:** `compareEvalRuns`, `CompareEvalRunsOptions`, `createDefaultArtifactId`, `createEvalResultStore`, `createStoredEvalArtifact`, `defaultEnvironmentMetadata`, `EvalCaseComparison`, `EvalCaseComparisonOutcome`, `EvalResultStore`, `EvalResultStoreConfig`, `EvalResultStoreLike`, `EvalRunComparisonLabels`, `EvalRunComparisonResult`, `ExperimentMetric`, `FileEvalResultStore`, `FileEvalResultStoreConfig`, `GCSEvalResultStore`, `GCSEvalResultStoreConfig`, `getMissingDependencyMessage`, `isEvalResultStore`, `isProviderAvailable`, `ListStoredArtifactsOptions`, `loadBaseline`, `loadStoredEvalRunnerResult`, `ProposeVariantsContext`, `resolveEvalResultStore`, `runVariantExperiment`, `saveBaseline`, `SaveBaselineOptions`, `saveEvalRunComparison`, `SaveEvalRunComparisonOptions`, `StoredArtifactKind`, `StoredArtifactSummary`, `StoredEvalArtifact`, `StoredEvalArtifactMetadata`, `StoredEvalResultLoadOptions`, `StoredEvalResultRef`, `StoredEvalResultSaveOptions`, `StoredEvalRunRef`, `VariantCandidateResult`, `VariantExperimentOptions`, `VariantExperimentReason`, `VariantExperimentResult`, `VariantExperimentRound`, `VariantImprovementProposal`, `VariantRecommendation` (`runServerComparison` and `saveServerComparison` were removed instead; see [Server comparisons are suite variants](#server-comparisons-are-suite-variants).)
- **`@gleanwork/mcp-server-tester/auth`:** `ClientCredentialsConfig`, `discoverAuthorizationServer`, `discoverProtectedResource`, `DiscoveryError`, `ENV_VAR_NAMES`, `hasValidTokens`, `loadTokens`, `loadTokensFromEnv`, `MCP_PROTOCOL_VERSION`, `performClientCredentialsFlow`, `ProtectedResourceDiscoveryResult`, `ProtectedResourceMetadata`, `StoredClientInfo`, `StoredOAuthState`, `StoredServerMetadata`

## `mcp.callTool()` returns protocol errors as error results

**Affects:** tests that expect `mcp.callTool()` to reject for an unknown tool or invalid arguments.

MCP reports tool failures two ways: tool execution errors (`isError: true`) and JSON-RPC protocol errors (e.g. `-32602` for an unknown tool). v2 SDK servers and the 2026-07-28 spec use protocol errors for unknown tools, which would otherwise make `mcp.callTool()` reject. MST now folds protocol errors into an error-shaped result, so one assertion style works for both:

```typescript
import { getToolProtocolError } from '@gleanwork/mcp-server-tester';

const result = await mcp.callTool('nonexistent_tool', {});
expect(result).toBeToolError(); // works for both kinds
expect(result).toContainToolText('MCP error -32602');
getToolProtocolError(result); // { code: -32602, message: '...', data?: ... } or null
```

Local failures (timeouts, closed connections, auth) still reject. If you asserted `await expect(mcp.callTool(...)).rejects...` for a protocol error, switch to `toBeToolError()` or `getToolProtocolError()`. The raw `mcp.client.callTool()` still rejects.

## Custom `MCPFixtureApi` objects need new members

**Affects:** code that builds an `MCPFixtureApi` by hand (custom fixtures, test doubles). Code that uses the `mcp` fixture or `createMCPFixture()` is not affected.

`MCPFixtureApi` gained `protocol`, `discover()`, `listResources()`, `readResource()`, `request()`, and `skills`. Add them with the exported helpers:

```typescript
import {
  createFixtureExtensions,
  getProtocolInfo,
  type MCPFixtureApi,
} from '@gleanwork/mcp-server-tester';

const api: MCPFixtureApi = {
  client,
  authType: 'none',
  get protocol() {
    return getProtocolInfo(client);
  },
  ...createFixtureExtensions(client),
  listTools: ...,
  callTool: ...,
  getServerInfo: ...,
};
```

## Conformance results: severity, skips, and new checks

**Affects:** code that inspects `runConformanceChecks()` results in detail.

- Each check can carry `severity` (`'must'` or `'should'`), `skipped`, `specVersion`, and `specRef`. `result.pass` is true when every non-skipped `must` check passes; failing `should` checks are warnings.
- The result has a `protocol` field with the connection's requested and negotiated protocol.
- On legacy connections, the core checks are the 1.x checks, with two that are stricter:
  - `invalid_tool_returns_error` fails if calling an unknown tool times out or closes the connection. 1.x counted any rejection as a pass.
  - `tool_schemas_valid` fails if a tool's `outputSchema` does not compile.
- **Servers that declare the skills extension** (`io.modelcontextprotocol/skills`) now also get the [skills checks](../skills.md#conformance) in every era. Pass `skills: false` to turn them off.
- On 2026-07-28 connections, the [modern checks](../protocol-versions.md#conformance-by-era) run as well, including raw probe requests. Over stdio a probe starts a short-lived copy of your server; pass `probe: false` if that is a problem.
- Probes present what the session's transport presents. A stdio probe starts the server with the same environment the SDK used (its safe defaults plus your `env`), not the test process's whole environment. An HTTP probe sends the auth provider's token even when an `Authorization` header is also configured, as the SDK does. Probes and wire-level checks need a client created by `createMCPClientForConfig()` (or the fixtures); for other clients they are skipped.
- The HTML report groups checks by protocol and shows warnings and skips separately.

## `compareEvalRuns()` returns `warnings`

**Affects:** code that asserts on the exact shape of `compareEvalRuns()` output.

The result has a new `warnings: string[]` field. It flags comparisons between runs that negotiated different protocol eras or revisions.

## `MCP_PROTOCOL_VERSION` is deprecated

The exported `MCP_PROTOCOL_VERSION` constant is the header MST sends on OAuth discovery requests, not the protocol connections speak. It is deprecated and will be removed in a future major. Use `mcpConfig.protocol` to choose a connection's protocol. It is now exported from `@gleanwork/mcp-server-tester/auth`.

## `.not` works on `toSatisfyToolPredicate`, `toMatchToolSnapshot` and `toPassToolJudge`

**Affects:** tests that use `.not.toSatisfyToolPredicate()`, `.not.toMatchToolSnapshot()` or `.not.toPassToolJudge()`.

These matchers negated their own result and then Playwright negated it again, so `.not` asserted the opposite of what it says. `expect(r).not.toSatisfyToolPredicate(p)` passed when `p` was satisfied, `.not.toMatchToolSnapshot(name)` passed when the response matched the snapshot, and `.not.toPassToolJudge(rubric)` passed when the judge passed. `.not` now means "not", as it does for every other matcher; with a list of judges, it means at least one judge fails. Assertions without `.not` are unchanged.

A test that relied on the old behaviour now fails. Remove its `.not`. A predicate that throws, or a judge that can't score the response (an API error, a missing key, an unknown judge), fails the assertion with or without `.not`.

## LLM judges share one prompt, parser and size limit

**Affects:** built-in LLM judges (`rubric` judges, not custom `judge` executors). Mainly `provider: 'anthropic-agent-sdk'` and `maxToolOutputSize` users.

Every provider now sends the same system prompt and user prompt and reads the verdict with the same parser. Before, each provider carried its own copy, and they had drifted:

- **`maxToolOutputSize` applies to every provider.** Only `anthropic-agent-sdk` enforced it; the others ignored it. A judge configured with it now fails, without calling the model, when the response is larger.
- **`anthropic-agent-sdk` uses the shared prompts.** Its system prompt and the end of its user prompt differed from the other providers, so its scores may shift slightly.
- **All providers accept a verdict wrapped in prose.** Only `anthropic-agent-sdk` did; the others failed with "Failed to parse judge response as JSON".
- **`provider: 'google'` honours `temperature`.** It was fixed at 0; the default is still 0.
- **Judge usage always has a duration.** When a provider doesn't report one, `usage.durationMs` is the wall-clock time of the call. The `anthropic-agent-sdk` judge used to report 0.

## MCP reporter attachments

**Affects:** tools that read MST's Playwright attachments directly, and reports of auto-tracked `mcp.callTool()` calls.

The MCP reporter reads test data through one typed channel (`src/reporters/channel.ts`). What changes:

- **Auto-tracked calls keep their arguments and the real failure.** A test's `mcp.callTool()` results now carry `request.args`. A failing test reports Playwright's error message (for example the failed assertion) instead of `'Test failed'`.
- **Every `runEvalDataset()` in a test is reported.** The reporter used to keep only the first eval-results attachment of each test.
- **`getServerInfo()` no longer attaches `mcp-server-info`.** Nothing read it. The other attachment names are unchanged.
- **A malformed MCP attachment is reported, not skipped silently.** It's logged, and the rest of the test's attachments are still read. The reporter checks the fields it and its UI read (for example each eval case's `expectations`).
- **`mcp-conformance-checks` omits `serverInfo` when the server reports none.** It used to write `"serverInfo": null`.

## Stored results are redacted the same way everywhere

**Affects:** code that stores comparisons and reads raw responses back from them, and anything that reads stored eval-runner artifacts or baseline files.

Every API that persists results now uses one policy (`redactStoredResponses` in the result store) with one default. Before, there were six implementations that disagreed.

- **Comparisons redact by default.** `saveEvalRunComparison()` used to store every raw tool and host response unless you passed `redactStoredResponses: true`. It now omits them, as the runner and reporter already did. Pass `redactStoredResponses: false` to keep them.
- **What is redacted is the same everywhere.** Every eval case result, wherever it is nested, loses its raw `response` and the exact-match `expect.response` echoed in `request.expect`. The runner's store path, `omitResponsesFromResult()` and baseline files used to keep `request.expect.response`. The reporter and comparisons used to drop any key named `response` at any depth, including tool arguments; they now keep those.
- **One pass rate.** Every run-level pass rate is `passed / total`, and 0 for a run without cases. The reporter's `metrics.passRate` was `NaN` for an empty run, which was stored as `null`.

The reporter's local report (`index.html`, `data.js` and `run-*.json` in its `outputDir`) keeps responses so the report can show them. Its result-store artifacts follow the policy above.

## Which credentials are used

**Affects:** HTTP servers that authenticate with an `mst login`, `auth.clientCredentials`, or more than one auth setting, and users of the `mcpAuthProvider` fixture.

The fixtures and `createMCPClientForConfig()` now share one precedence, decided in `src/auth/credentials.ts`: the OAuth state file, then a static token, then client credentials, then (in the fixture) a stored login. See [Which credentials are used](../authentication.md#which-credentials-are-used).

- **Stored logins refresh during a run.** The fixture used to read a stored login's token once and send it as a fixed header, so a test that outlived the token failed with 401. The token now comes from a provider that refreshes it from the stored refresh token before it expires.
- **Client-credentials tokens refresh too.** The token was fetched once at connect; it's now requested again as it nears expiry.
- **Configured client credentials win over a stored login.** With `auth.clientCredentials` set and a stored login for the same server, the stored login's token replaced the client-credentials token. The configured grant is now used, and the stored login isn't read.
- **A static token skips the client-credentials grant.** With both `auth.accessToken` and `auth.clientCredentials`, the grant used to run (and could fail the connection) before its token was discarded. Now it doesn't run.
- **`createMCPClientForConfig()` honours `auth.oauth.authStatePath`.** Only the fixture used it before. The state file also wins over `auth.accessToken`, as it did in the fixture.
- **The `mcpAuthProvider` fixture prefers `MCP_AUTH_STATE_PATH` over `MCP_ACCESS_TOKEN`**, the same order as above. It used to prefer the token.
- **Reported `authType`.** A client-credentials connection reports `oauth` (it reported `none`), and a config with both an OAuth state file and a token reports `oauth` (it reported `api-token`, though the state file's token was the one sent).

## Custom judges are plugins

**Affects:** code that calls `registerJudge`, `getRegisteredJudge` or `clearJudgeRegistry`, and datasets or tests that name a custom judge.

A custom judge is now part of a plugin: a plain object that MST reads, in the shape [ESLint plugins](https://eslint.org/docs/latest/extend/plugins) use ([Plugins](../evaluation-framework.md#plugins), [ADR-0001](../adr/0001-eslint-style-declarative-plugins.md)). There is no global judge registry.

```typescript
// Before (1.x)
import { registerJudge } from '@gleanwork/mcp-server-tester';

registerJudge('completeness', async (candidate, reference) => ({ score: 1 }));
// expect(result).toPassToolJudge({ judge: 'completeness' });

// After
import type { Plugin } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

export default {
  meta: { name: '@acme/mst-plugin', version: '1.0.0', namespace: 'acme' },
  judges: {
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async ({ case: c, trial }, options) => ({ score: 1 }),
    },
  },
} satisfies Plugin;
// expect(result).toPassToolJudge({ judge: 'acme/completeness' });
```

- **A judge's `evaluate` takes `({ case, trial }, options)`** instead of `(candidate, reference)`. `candidate` is `trial.response` (its text is `trial.text`) and `reference` is `case.expected.answer`. The case's input, criteria, tags and metadata, and the run's tool events, are in the input too. `options` is what the judge's `schema` parsed. A judge returns the old `{ score, reasoning }`, and may also return `provider`, `model`, `pass`, `skipped`, `subScores`, `usage` and `metadata`. It runs once per `reps` ([Every judge runs the same way](#every-judge-runs-the-same-way); [Judge contract](../evaluation-framework.md#judge-contract)). The `schema` is required; `z.object({}).passthrough()` accepts any options, as the old registry did.
- **Reference it as `namespace/name`**, in `toPassToolJudge({ judge })` and in a dataset's `passesJudge.judge`. Bare names belong to built-ins, so a plugin can't take one. A 1.x bare name such as `judge: 'completeness'` now fails the assertion with `Judge "completeness" is not available`, followed by the names that are.
- **Pass the plugin where the judge is used**, instead of registering it in global setup: `test.use({ mcpPlugins: [plugin] })` in Playwright, `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `runEvalCase(evalCase, ctx, { plugins: [plugin] })`. Code that calls `validateJudge` or the matchers outside those installs it with `installPlugins([plugin])`. For a one-off judge, a small local plugin is enough: `{ meta: { name: 'local', namespace: 'local' }, judges: { x } }`.
- **Plugins are validated when installed.** A judge without a `schema` or `evaluate`, an unknown top-level key, or a different plugin claiming an installed namespace is an error that names the plugin.
- **Removed from the root:** `registerJudge`, `getRegisteredJudge`, `clearJudgeRegistry`, and the `CustomJudgeExecutor` and `CustomJudgeResult` types.

## Every judge runs the same way

**Affects:** custom judges used with `reps` or `judgeReps`, tests that match judge messages, and anything that reads `judgeName`.

Rubric judges and custom judges now share one contract. A rubric is shorthand for the built-in `rubric` judge, and every judge goes through the same evaluation.

- **`reps` and `judgeReps` apply to every judge.** In 1.x a custom judge scored each response once, whatever `reps` said. It now scores it `reps` times, and the mean is compared with the threshold, as for rubric judges. The message lists each score, and `validateJudge` details report `scores`, `scoreStdDev` and `highVariance`. If your judge is expensive or deterministic, set `reps: 1` on its assertion.
- **A custom judge receives its own fields.** On an assertion that names a `judge`, fields other than `judge`, `options`, `reference`, `threshold` and `reps` go to the judge's schema, unless `options` is set. 1.x executors received no options, so `provider`, `model` and other fields next to `judge` were ignored; a strict schema now rejects them.
- **One message format.** Results read `Judge "<name>" passed with score 0.80` or `Judge "<name>" failed with score 0.40 (threshold: 0.7)`, and errors read `Judge "<name>" error: ...`. 1.x used `Judge passed ...` for rubrics and `Custom judge "<name>" ...` for custom judges. The `score N` part is unchanged.
- **A custom-text rubric is named `rubric`.** Its `judgeName` was unset.
- **A score that isn't a number is an error.** A judge returning `NaN` used to fail as a low score.

## LLM calls: bearer tokens and streaming

**Affects:** `mcp_host` cases with `provider: 'anthropic'`, or `provider: 'openai'` with `OPENAI_BASE_URL` set, the `anthropic` judge, and code that matches on SDK host error messages.

MST's LLM calls now resolve their endpoint and credential in one place (`src/llm/endpoint.ts`), so they can go through an LLM gateway. See [LLM Gateways](../llm-gateways.md).

- **`ANTHROPIC_AUTH_TOKEN` is a gateway credential.** With `ANTHROPIC_BASE_URL` set, it is sent as `Authorization: Bearer`, ahead of `ANTHROPIC_API_KEY`; the SDK host used to send only `x-api-key`, and the judge sent both headers. Without a base URL override it is ignored, so a gateway token never reaches the public API; the judge's SDK used to send it there too. If it was your only Anthropic credential, set `ANTHROPIC_BASE_URL` (or `ANTHROPIC_API_KEY`): the `anthropic` judge now reports a missing key, and the SDK host's calls fail authentication.
- **An explicit `apiKeyEnvVar` reads only that variable.** This was already true for the SDK host; the judge used to pick up `ANTHROPIC_AUTH_TOKEN` from the environment as well.
- **With a base URL override, `MST_LLM_AUTH_COMMAND` wins over `*_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.** It is new, so this only matters once you set it.
- **`ANTHROPIC_BASE_URL` takes either form.** The SDK host needed the AI SDK's form (ending in `/v1`) and the judge needed the API root (the official SDK's and Claude Code's form); each failed with 404 on the other. Both now accept both.
- **The `anthropic` SDK host streams.** Its agent loop uses `streamText` instead of `generateText`. Tool calls, text, steps and usage are the same; an error part in the middle of a stream now fails the case.
- **The `openai` SDK host sends `store: false` behind `OPENAI_BASE_URL`.** Multi-turn tool loops through a gateway failed with `Item with id 'rs_…' not found`, because the AI SDK refers to earlier Responses items by id. Calls to the public API are unchanged.
- **Unknown dataset keys are errors.** A key MST doesn't define in a dataset, a case or its `expect` block fails loading. Examples are `regex` (use `matchesPattern`), `judge` (use `passesJudge`), and a misspelt `accuracyThreshold`. 1.x ignored such keys, so the setting or assertion never applied. The error names the case.
- **SDK hosts don't report cost.** `usage.totalCostUsd` is undefined for the Vercel AI SDK host, which knows tokens but not prices; 1.x reported 0. The same holds for Claude CLI output without a cost. A suite can estimate cost with an eval config's `pricing`.
- **Clearer SDK host errors.** Errors are classified by HTTP status as well as message text, so a 401 whose message doesn't say "401" still gets the authentication hint, and the hint now includes the provider's message: `authentication error (<provider message>)`. A plain-object stream error shows its `message` instead of `[object Object]`.

## Server comparisons are suite variants

**Affects:** code that calls `runServerComparison()` or `saveServerComparison()`, or reads `ServerComparisonResult`, `CaseComparisonResult` or `ComparisonOutcome`.

`runServerComparison()` and `saveServerComparison()` are removed. A suite runs the same comparison as two variants, each with its own `servers`, and compares them on every metric, not only pass rate:

```json
{
  "name": "server-ab",
  "datasets": ["./evals/triggering.json"],
  "client": "mst",
  "model": "claude-sonnet-4-6",
  "variants": [
    {
      "name": "production",
      "servers": [
        {
          "transport": "http",
          "serverUrl": "https://mcp.example.com/mcp",
          "label": "prod"
        }
      ]
    },
    {
      "name": "candidate",
      "servers": [
        {
          "transport": "http",
          "serverUrl": "https://staging.example.com/mcp",
          "label": "next"
        }
      ]
    }
  ]
}
```

Run it with `mst run --config server-ab.json`, or `runEvalSuite({ configPath })` from code. The run summary's `variants` has each variant's metrics and results, and `variantDeltas` their changes against the first variant. For per-case outcomes, compare the two variants' results:

```typescript
import {
  compareEvalRuns,
  runEvalSuite,
} from '@gleanwork/mcp-server-tester/evals';

const { summary } = await runEvalSuite({ configPath: 'server-ab.json' });
const [serverA, serverB] = summary.variants;
const comparison = compareEvalRuns({
  baseline: serverA!.result!,
  candidate: serverB!.result!,
});
```

With the first variant as server A, `B_WINS` cases are `comparison.improvedCases`, `A_WINS` are `regressedCases`, `TIE` are `unchangedPasses` and `BOTH_FAIL` are `unchangedFailures`.

What changes: variants run one after another, not in parallel; there is no `aWinRate`/`bWinRate` (count the buckets above); each variant connects from its own server config, so a server that needed a separate authenticated Playwright fixture needs its auth in the config (for example `auth.accessTokenEnv`); and `comparisonStore` is gone (`saveEvalRunComparison()` stores a comparison). See [Comparing servers](../evals-guide.md#comparing-servers-ab-testing).

## The Claude Agent SDK is an optional peer dependency

**Affects:** judges with `provider: 'anthropic-agent-sdk'`.

`@anthropic-ai/claude-agent-sdk` (about 46 MB) was installed with MST whether or not a judge used it. It is now an optional peer dependency, loaded only when an `anthropic-agent-sdk` judge runs. If you use that provider, install it:

```bash
npm install --save-dev @anthropic-ai/claude-agent-sdk
```

Without it, the judge fails with an error that names the package. The other judge providers (`anthropic`, `vertex-anthropic`, `openai`, `google`) already load their SDKs this way.

## `getResponseSizeBytes` is no longer exported

**Affects:** code that imports `getResponseSizeBytes`.

It was the helper behind `validateSize`. Check a response's size with `validateSize(response, { maxBytes })` or `expect(response).toHaveToolResponseSize({ maxBytes })`.

## `runVariantExperiment` needs clear evidence to recommend a variant

**Affects:** code that calls `runVariantExperiment` and acts on `proposal.recommendation`, `winner`, `metricValue` or `delta`, or a `proposeVariants` callback that reads held-out cases.

Variant experiments now follow standard practice for comparing two systems on the same cases, so `'apply'` means the evidence supports it. See [How variants are judged](../mcp-host.md#how-variants-are-judged) for the method and its limits.

- **A recommendation needs a clear improvement.** `'apply'` now needs an exact paired sign-flip test on per-case results to give p below 0.025 divided by the number of variants tried. Before, any gain in the metric was enough. Small datasets and single-trial runs will report `'inconclusive'` more often; run several trials per case (`defaultLlmIterations` or `iterations`) to tell real gains from noise. There is no opt-out. Tool metrics use the same test on per-case precision, recall or F1.
- **`regressionCheck` defaults to `'significant'`.** One flaky trial on a working case no longer disqualifies a variant; a case or group that clearly got worse still does. Set `regressionCheck: 'any-case'` for the previous rule.
- **Tag your regression cases.** Breakage is judged on cases tagged `regression` (or `regressionTag`). Without the tag, the experiment runs the baseline one extra time, only to decide which cases are regression cases, which costs one more run of the dataset.
- **`passRate` is the mean per-case pass rate.** It is now the mean of each case's share of trials passed, not the share of cases that passed every trial. With one trial per case the value is the same, except that a case whose trials all failed for infrastructure reasons is left out instead of counted as a failure. Every metric now leaves out held-out cases, so `metricValue`, `baselineValue` and `delta` change when the dataset has them.
- **`proposeVariants` never sees held-out cases.** Every run in its context has them removed, so they stay a fair check on the winner.

New fields: candidates have `measurement`, `improvement` and `fixes`, and the result has `grouping` and, when an extra run was needed, `groupingBaseline`.

## Client cases name a client and model, not `mcpHostConfig`

**Affects:** datasets with `mode: 'mcp_host'` or `mode: 'external_host'` cases, `mcpHostConfig` or `externalHost` on a case, the `mcpHostModel` option, and plugin clients that read `context.mcpHostConfig`.

A case with `input` runs on the client under test, so it needs no `mode`. The run names the client and model once: `runEvalDataset` in a Playwright test, or the suite eval config. A case can set its own `client`, `model` and `clientOptions`. Outside a suite, cases run on the `mst` client, on the test's MCP connection; Claude Code, Cowork, ChatGPT and plugin clients run in suites (`mst run`). The old keys fail with a message naming what replaces them.

```json
// Before
{
  "id": "find-config",
  "mode": "mcp_host",
  "input": "Find the config file",
  "mcpHostConfig": { "provider": "anthropic", "model": "claude-sonnet-4-5", "maxToolCalls": 8 }
}

// Now: the case says what it tests
{ "id": "find-config", "input": "Find the config file" }
```

```typescript
// The run names the client and model; clientOptions carry the rest
await runEvalDataset(
  {
    dataset,
    client: 'mst',
    model: 'claude-sonnet-4-5',
    clientOptions: { maxToolCalls: 8 },
  },
  { mcp, testInfo }
);
```

- A case that needs its own model or options sets `model` and `clientOptions` (for example `"clientOptions": { "systemPrompt": "..." }`). They replace what the case inherits.
- `provider` is inferred from the model id; set `clientOptions.provider` to override it (a gateway, or Vertex routing).
- An `external_host` case runs in a suite with `client: 'chatgpt'`, or a plugin client.
- `mcpHostConfig.cli` and `browser` (caller-authored CLI and browser hosts) have no replacement in a case; a plugin client can wrap a custom host.
- `mcpHostModel` is now `model`; the run metadata still records it as `mcpHostModel`.
- Results record the case's client and model as `request.client` and `request.model`, instead of `request.mcpHostConfig` and `request.externalHost`.
- Plugin clients: `ClientRunContext.mcpHostConfig` is gone. A case's options arrive in the client config the suite resolves.
- A case with `input` and a `toolName` or `request` fails validation: a case runs on the client or calls a tool directly, not both. Remove a placeholder `toolName` and `args` from client cases.
- Direct cases are Playwright tests now: see [Direct cases are Playwright tests](#direct-cases-are-playwright-tests).

## Direct cases are Playwright tests

**Affects:** datasets with direct cases (`toolName` and `args`, or `request`), `mode` on a case, the `response`, `schema`, `snapshot`, `snapshotSanitizers`, `isError` and `responseSize` assertions, the `schemas` options of `loadEvalDataset` and `runEvalDataset`, `EvalContext.expect`, custom executors that return `kind: 'direct'`, and `mst generate`.

An eval case is now always an `input` the client acts on. A check on a single tool's response is a Playwright test: call the tool and assert with the matcher that replaces each assertion. The old keys fail with a message naming the replacement.

```json
// Before: a direct case
{
  "id": "weather-london",
  "toolName": "get_weather",
  "args": { "city": "London" },
  "assertions": {
    "schema": "weather",
    "containsText": "London",
    "isError": false
  }
}
```

```typescript
// Now: a Playwright test
test('weather-london', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).not.toBeToolError();
  expect(result).toMatchToolSchema(WeatherSchema);
  expect(result).toContainToolText('London');
});
```

| Removed assertion | Matcher                                     |
| ----------------- | ------------------------------------------- |
| `response`        | `toMatchToolResponse(expected)`             |
| `schema`          | `toMatchToolSchema(zodSchema)`              |
| `snapshot`        | `toMatchToolSnapshot(name, sanitizers?)`    |
| `isError`         | `toBeToolError()` / `.not.toBeToolError()`  |
| `responseSize`    | `toHaveToolResponseSize({ minBytes, ... })` |
| `containsText`    | `toContainToolText(text)`                   |
| `matchesPattern`  | `toMatchToolPattern(patterns)`              |
| `passesJudge`     | `toPassToolJudge(rubric, options?)`         |

- To keep tool checks in JSON, loop over the file in a spec and make each entry a `test()`; the [filesystem example](../../examples/filesystem-server/) does this with `tool-checks.json`.
- A `request` case becomes `mcp.request(method, params, schema)` in a test; `mcp.skills` covers the skills methods. A JSON-RPC error rejects with its `code`. The built-in `SkillsListResult`-style schemas are gone with `assertions.schema`; use `validateSkillEntry()`.
- `containsText`, `matchesPattern`, `passesJudge`, `toolsTriggered` and `toolCallCount` stay as eval assertions, on what the client did.
- `mst generate` writes a Playwright spec (default `tests/generated.spec.ts`) instead of a dataset, and adds tests to a spec it wrote before. `mst init` scaffolds a tool test and a client-case dataset.
- `executeCase` returns `kind: 'host'` or `'failed'`; `'direct'` fails. Results no longer carry `request.mode`. `JudgeCase.input.tool` is gone (judges see `input.prompt`).
- `defaultTrials` and `defaultPassThreshold` now apply to every case.

## The simulator and the external-host runtime are internal

**Affects:** code that calls `simulateMCPHost()` or `getBuiltinHostConfig()` from `./evals`; the `MCPHostConfig`, `HostType`, `CLIConfig`, `CLIOutputFormat` and `MCPHostSimulator` types; browser and desktop hosts (`hostType: 'browser' | 'desktop'`); the external-host runtime in `./experimental/clients` (`runExternalHostScenario`, driver identity helpers, `getExternalHostConfigJsonSchema` and the driver references, and the external-host config and capability types); plugin clients with `createConfig`; dataset sources that read `context.hostConfig`; and `buildEvalDataset(raw, hostConfig, manifest)`.

These were the machinery behind the `mst`, `claude-code` and `chatgpt` clients. With `mcp_host` and `external_host` cases gone, the clients are the interface:

```typescript
// Before
const result = await simulateMCPHost(mcp, 'What files are in docs?', {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
});

// Now: a case on the mst client
const result = await runEvalCase(
  {
    id: 'list-docs',
    input: 'What files are in docs?',
    assertions: { toolsTriggered: { calls: [{ name: 'list_directory' }] } },
  },
  { mcp },
  { client: 'mst', model: 'claude-sonnet-4-5' }
);
```

- The `mst` client's options (`provider`, `maxToolCalls`, `temperature`, `skills`, `systemPrompt`, ...) go in `clientOptions`. See [mst client options](../mcp-host.md#mst-client-options).
- Browser and desktop hosts, and a caller-authored CLI host, have no replacement. A plugin client (`run` or `runBatch`) can drive any host and report its trace.
- A plugin client needs `run` or `runBatch`; `createConfig` is gone.
- `buildEvalDataset(raw, evalConfig)` takes no host config, and `DatasetSourceContext` has no `hostConfig`.
- The ChatGPT client still records what it saw on each result's `externalHost`, and `./experimental/clients` still exports the types for it (`ExternalHostMetadata` and the types it uses).
- The external-host drivers for the Claude desktop chat and Cowork surfaces (driven through Accessibility) are gone; the `cowork` client covers Cowork.

## Eval configs and variants

**Affects:** every eval config (formerly "manifest") with `arms` or `toolOverrides`; `mst run --manifest` and `--arm`; `mst batch --manifests` and `--manifest-dir`; the `EvalManifest`/`EvalArm` types and the functions and options that named them; plugin clients and dataset sources; code that reads `results.json`.

ADR 0002's vocabulary reaches the config: an eval config compares **variants**, the first of which (or the one `baseline` names) is the **baseline**, and a variant's **tool metadata** is its `tools`.

```json
// Before
{
  "name": "find-skills",
  "datasets": ["./cases.json"],
  "client": "mst",
  "arms": [
    { "name": "current" },
    {
      "name": "explicit",
      "toolOverrides": {
        "id": "explicit",
        "description": "Say when to search",
        "tools": { "find_skills": { "description": "Search the skills catalog first." } }
      }
    }
  ]
}

// Now
{
  "name": "find-skills",
  "datasets": ["./cases.json"],
  "client": "mst",
  "variants": [
    { "name": "current" },
    {
      "name": "explicit",
      "description": "Say when to search",
      "tools": { "find_skills": { "description": "Search the skills catalog first." } }
    }
  ]
}
```

- **Config keys.** `arms` is now `variants`; `baseline: "<name>"` picks the baseline (default: the first variant). `toolOverrides` is now `tools`, holding the tool metadata itself (what was `toolOverrides.tools`): the variant's `name` identifies it, and its `description` describes it. A config-level `tools` applies to every variant that doesn't set its own. The old top-level `tools` string, which nothing read, is gone. Old keys fail with a message naming the replacement.
- **CLI.** `mst run --config <path>` (or `-c`) and `--variant <name>`; `mst batch --configs` and `--config-dir`. The old flags fail with their replacement. The editor schema is `schema/eval-config.schema.json`, and the repo's examples name configs `eval.json`.
- **Types and functions** (`./evals`): `EvalManifest` → `EvalConfig`, `EvalArm` → `EvalVariant`, `EvalManifestSchema` → `EvalConfigSchema`, `EvalManifestInput` → `EvalConfigInput`, `loadEvalManifest` → `loadEvalConfig`, `loadEvalManifestFromObject` → `loadEvalConfigFromObject`, `validateManifest` → `validateEvalConfig` (`ValidateManifestOptions` → `ValidateEvalConfigOptions`), `resolveManifestExtends` → `resolveConfigExtends`, `EvaluationArmResult` → `EvaluationVariantResult`. New: `ToolMetadata` and `variantToolMetadata(evalConfig, variant)`.
- **Options.** `runEvalSuite({ configPath, variant, variants })` (were `manifestPath`, `arm`, `arms`), whose result has `evalConfig` (was `manifest`); `runEvalBatch({ configPaths, configDir })`. `runVariantExperiment({ suite: { configPath, baseVariant } })` (were `manifestPath`, `arm`).
- **Plugins.** A client's context is `{ evalConfig, variant, env }` (were `manifest`, `arm`); a dataset source's is `{ rootDir, configDir, evalConfig }`. A client that shows tool metadata itself declares `toolMetadata: true` (was `toolOverrides: true`) and reads it with `variantToolMetadata(context.evalConfig, context.variant)`.
- **Results.** `results.json` names the run by `configId` and `configName`, lists `variants` (was `arms`) and `variantDeltas` (was `armDeltas`); each case result has `variant` (was `arm`), and `previousRun` has `sameConfig` and `variants`. A run doesn't find a previous run stored before this change.

## New in 2.0 (non-breaking)

- An evaluation framework over datasets: eval configs, suites and batches (`mst run`, `mst batch`), variants, metrics, result stores, and plugins that add dataset sources, hosts, judges, metrics and result stores under their own namespace, and shared configs an eval config `extends`. It's in `@gleanwork/mcp-server-tester/evals`. See [Evaluation framework](../evaluation-framework.md).
- Desktop hosts for suites: Claude Cowork (`cowork`) and the ChatGPT desktop app (`chatgpt`), driven through the desktop UI (Computer Use on macOS, AT-SPI on Linux). Their APIs are in `@gleanwork/mcp-server-tester/experimental/clients`, which may change between minor versions. See [Cowork](../cowork.md) and [ChatGPT desktop](../chatgpt-desktop.md).
- A custom `executeCase` for `runEvalDataset()` and `runEvalCase()`, which returns a typed `CaseExecution` (`direct`, `host` or `failed`).
- LLM gateway support for the `mst` client and LLM judges: `ANTHROPIC_AUTH_TOKEN`, and `MST_LLM_AUTH_COMMAND` for short-lived tokens. See [LLM Gateways](../llm-gateways.md).
- The CLI is also installed as `mst`. In a project that depends on the package, `npx mst <command>` and `npx mcp-server-tester <command>` run the same binary. Before the package is installed, run `init` as `npx @gleanwork/mcp-server-tester init`: `npx mcp-server-tester` and `npx mst` would download unrelated npm packages with those names. See [CLI](../cli.md).
- `protocol` on `mcpConfig` (`'legacy'`, `'auto'`, or a revision like `'2026-07-28'`), the `mcpProtocol` fixture option, and `protocolMatrix()`. See [Protocol Versions](../protocol-versions.md). To run an existing project against both eras:

  ```typescript
  import { protocolMatrix } from '@gleanwork/mcp-server-tester';

  projects: protocolMatrix(
    { name: 'my-server', use: { mcpConfig } },
    ['legacy', '2026-07-28']
  ), // my-server@legacy, my-server@2026-07-28
  ```

- `runCrossEraChecks()` to check a server serves every era the same.
- `mcp.skills`, skills conformance checks, and a `skills` option on the `mst` client, for comparing modes as variants. See [Agent Skills](../skills.md).
- Eval run metadata records the protocol (`metadata.protocol`, stored `protocolVersion` / `protocolEra`).
