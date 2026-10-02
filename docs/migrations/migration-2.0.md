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
- [LLM calls: bearer tokens and streaming](#llm-calls-bearer-tokens-and-streaming)
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

**Affects:** code that imports comparisons, baselines, result stores, variant experiments, `simulateMCPHost`, or low-level OAuth from the package root.

The root now holds the core testing interface: fixtures, matchers and validators, the MCP client, config, datasets with `runEvalDataset` and `runEvalCase`, judges, conformance, and Agent Skills, with the types those use. Everything else moved to a subpath. Apart from the judge registry ([Custom judges are plugins](#custom-judges-are-plugins)), nothing was renamed or removed; only the import path changed.

| Subpath                              | What it holds                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gleanwork/mcp-server-tester/evals` | The evaluation framework: manifests, suites and batches, extension definition types, metrics, result stores, baselines and comparisons, variant experiments, and MCP host simulation. |
| `@gleanwork/mcp-server-tester/auth`  | Low-level OAuth: discovery, token storage, and the client-credentials flow.                                                                                                           |

```typescript
// Before (1.x)
import {
  loadEvalDataset,
  compareEvalRuns,
  runServerComparison,
} from '@gleanwork/mcp-server-tester';

// After
import { loadEvalDataset } from '@gleanwork/mcp-server-tester';
import {
  compareEvalRuns,
  runServerComparison,
} from '@gleanwork/mcp-server-tester/evals';
```

The subpaths are ESM only (no `require` condition, and no `typesVersions`, so TypeScript needs `moduleResolution` `node16`, `nodenext` or `bundler`); the root still ships CommonJS as well. CommonJS code can no longer `require` a moved name, so code that uses one must move to ESM. Don't mix `require` of the root with `import()` of a subpath: the CommonJS root is a separate copy of the library, so its classes and module state are not the ESM copy's. Installed plugins are the exception: both copies share them. The ESM root and the subpaths share one copy.

Some root APIs take options typed from a subpath: `runEvalDataset`'s result-store options (`EvalResultStoreLike`, `StoredEvalResult*Options`) are in `./evals`, and the OAuth providers' stored-state types are in `./auth`. Import those types from the subpath when you name them.

Before 2.0 GA, exports that are neither documented nor used may still be removed; any removal will be listed in this guide.

If TypeScript reports that the package has no exported member, find the name below.

These names moved:

- **`@gleanwork/mcp-server-tester/evals`:** `CaseComparisonResult`, `compareEvalRuns`, `CompareEvalRunsOptions`, `ComparisonOutcome`, `createDefaultArtifactId`, `createEvalResultStore`, `createStoredEvalArtifact`, `defaultEnvironmentMetadata`, `EvalCaseComparison`, `EvalCaseComparisonOutcome`, `EvalResultStore`, `EvalResultStoreConfig`, `EvalResultStoreLike`, `EvalRunComparisonLabels`, `EvalRunComparisonResult`, `ExperimentMetric`, `FileEvalResultStore`, `FileEvalResultStoreConfig`, `GCSEvalResultStore`, `GCSEvalResultStoreConfig`, `getMissingDependencyMessage`, `isEvalResultStore`, `isProviderAvailable`, `ListStoredArtifactsOptions`, `loadBaseline`, `loadStoredEvalRunnerResult`, `ProposeVariantsContext`, `resolveEvalResultStore`, `runServerComparison`, `runVariantExperiment`, `saveBaseline`, `SaveBaselineOptions`, `saveEvalRunComparison`, `SaveEvalRunComparisonOptions`, `saveServerComparison`, `SaveServerComparisonOptions`, `ServerComparisonOptions`, `ServerComparisonResult`, `simulateMCPHost`, `StoredArtifactKind`, `StoredArtifactSummary`, `StoredEvalArtifact`, `StoredEvalArtifactMetadata`, `StoredEvalResultLoadOptions`, `StoredEvalResultRef`, `StoredEvalResultSaveOptions`, `StoredEvalRunRef`, `VariantCandidateResult`, `VariantExperimentOptions`, `VariantExperimentReason`, `VariantExperimentResult`, `VariantExperimentRound`, `VariantImprovementProposal`, `VariantRecommendation`
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

- **Comparisons redact by default.** `saveEvalRunComparison()`, `saveServerComparison()` and `runServerComparison({ comparisonStore })` used to store every raw tool and host response unless you passed `redactStoredResponses: true`. They now omit them, as the runner and reporter already did. Pass `redactStoredResponses: false` to keep them.
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
      evaluate: async (candidate, reference) => ({ score: 1 }),
    },
  },
} satisfies Plugin;
// expect(result).toPassToolJudge({ judge: 'acme/completeness' });
```

- **A judge's `evaluate` takes the old executor's arguments and returns the same result.** It also receives the options its `schema` parsed, as a third argument. The `schema` is required; `z.object({}).passthrough()` accepts any options, as the old registry did.
- **Reference it as `namespace/name`**, in `toPassToolJudge({ judge })` and in a dataset's `passesJudge.judge`. Bare names belong to built-ins, so a plugin can't take one. A 1.x bare name such as `judge: 'completeness'` now fails the assertion with `Judge "completeness" is not available`, followed by the names that are.
- **Pass the plugin where the judge is used**, instead of registering it in global setup: `test.use({ mcpPlugins: [plugin] })` in Playwright, `runEvalDataset({ dataset, plugins: [plugin] }, ctx)`, or `runEvalCase(evalCase, ctx, { plugins: [plugin] })`. Code that calls `validateJudge` or the matchers outside those installs it with `installPlugins([plugin])`. For a one-off judge, a small local plugin is enough: `{ meta: { name: 'local', namespace: 'local' }, judges: { x } }`.
- **Plugins are validated when installed.** A judge without a `schema` or `evaluate`, an unknown top-level key, or a different plugin claiming an installed namespace is an error that names the plugin.
- **Removed from the root:** `registerJudge`, `getRegisteredJudge`, `clearJudgeRegistry`, and the `CustomJudgeExecutor` and `CustomJudgeResult` types.

## LLM calls: bearer tokens and streaming

**Affects:** `mcp_host` cases with `provider: 'anthropic'`, or `provider: 'openai'` with `OPENAI_BASE_URL` set, the `anthropic` judge, and code that matches on SDK host error messages.

MST's LLM calls now resolve their endpoint and credential in one place (`src/llm/endpoint.ts`), so they can go through an LLM gateway. See [LLM Gateways](../llm-gateways.md).

- **`ANTHROPIC_AUTH_TOKEN` is a gateway credential.** With `ANTHROPIC_BASE_URL` set, it is sent as `Authorization: Bearer`, ahead of `ANTHROPIC_API_KEY`; the SDK host used to send only `x-api-key`, and the judge sent both headers. Without a base URL override it is ignored, so a gateway token never reaches the public API; the judge's SDK used to send it there too. If it was your only Anthropic credential, set `ANTHROPIC_BASE_URL` (or `ANTHROPIC_API_KEY`): the `anthropic` judge now reports a missing key, and the SDK host's calls fail authentication.
- **An explicit `apiKeyEnvVar` reads only that variable.** This was already true for the SDK host; the judge used to pick up `ANTHROPIC_AUTH_TOKEN` from the environment as well.
- **With a base URL override, `MST_LLM_AUTH_COMMAND` wins over `*_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.** It is new, so this only matters once you set it.
- **`ANTHROPIC_BASE_URL` takes either form.** The SDK host needed the AI SDK's form (ending in `/v1`) and the judge needed the API root (the official SDK's and Claude Code's form); each failed with 404 on the other. Both now accept both.
- **The `anthropic` SDK host streams.** Its agent loop uses `streamText` instead of `generateText`. Tool calls, text, steps and usage are the same; an error part in the middle of a stream now fails the case.
- **The `openai` SDK host sends `store: false` behind `OPENAI_BASE_URL`.** Multi-turn tool loops through a gateway failed with `Item with id 'rs_…' not found`, because the AI SDK refers to earlier Responses items by id. Calls to the public API are unchanged.
- **Clearer SDK host errors.** Errors are classified by HTTP status as well as message text, so a 401 whose message doesn't say "401" still gets the authentication hint, and the hint now includes the provider's message: `authentication error (<provider message>)`. A plain-object stream error shows its `message` instead of `[object Object]`.

## New in 2.0 (non-breaking)

- An evaluation framework over datasets: manifests, suites and batches (`mst run`, `mst batch`), arms, metrics, result stores, and plugins that add dataset sources, hosts, judges, metrics and result stores under their own namespace. It's in `@gleanwork/mcp-server-tester/evals`. See [Evaluation framework](../evaluation-framework.md).
- Desktop hosts for suites: Claude Cowork (`cowork`) and the ChatGPT desktop app (`chatgpt`), driven through the desktop UI (Computer Use on macOS, AT-SPI on Linux). External-host cases (`mode: 'external_host'`) run a scenario through another host's driver. Their APIs are in `@gleanwork/mcp-server-tester/experimental/hosts`, which may change between minor versions. See [Cowork](../cowork.md) and [ChatGPT desktop](../chatgpt-desktop.md).
- A custom `executeCase` for `runEvalDataset()` and `runEvalCase()`, which returns a typed `CaseExecution` (`direct`, `host` or `failed`).
- LLM gateway support for the `mcp_host` SDK host and LLM judges: `ANTHROPIC_AUTH_TOKEN`, and `MST_LLM_AUTH_COMMAND` for short-lived tokens. See [LLM Gateways](../llm-gateways.md).
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
- `mcp.skills`, skills conformance checks, and `mcpHostConfig.skills` / `runSkillsComparison()`. See [Agent Skills](../skills.md).
- Direct eval cases with `request` instead of `toolName`, and built-in schemas for skills and discover results.
- Eval run metadata records the protocol (`metadata.protocol`, stored `protocolVersion` / `protocolEra`).
