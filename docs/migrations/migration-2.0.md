# Migration Guide: v1.x to v2.0 (MCP SDK v2 and protocol versions)

MST 2.0 moves to the [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) and adds support for the 2026-07-28 protocol alongside the legacy one. **By default, connections behave exactly as in 1.x**: `protocol` defaults to `'legacy'`, and a golden wire transcript test guards that the default sends the same messages as before.

Other 2.0 changes have their own guides: [dataset sources](./dataset-sources.md), [host traces](./host-traces.md), and [LLM host unification](./llm-host-vercel-unification.md).

## Table of Contents

- [SDK types and imports](#sdk-types-and-imports)
- [`mcp.callTool()` returns protocol errors as error results](#mcpcalltool-returns-protocol-errors-as-error-results)
- [Custom `MCPFixtureApi` objects need new members](#custom-mcpfixtureapi-objects-need-new-members)
- [Conformance results: severity, skips, and new checks](#conformance-results-severity-skips-and-new-checks)
- [`compareEvalRuns()` returns `warnings`](#compareevalruns-returns-warnings)
- [`MCP_PROTOCOL_VERSION` is deprecated](#mcp_protocol_version-is-deprecated)
- [`executeCase` returns a typed `CaseExecution`](#executecase-returns-a-typed-caseexecution)
- [`external_host` results keep tool precision and recall](#external_host-results-keep-tool-precision-and-recall)
- [`.not` works on `toSatisfyToolPredicate` and `toMatchToolSnapshot`](#not-works-on-tosatisfytoolpredicate-and-tomatchtoolsnapshot)
- [LLM judges share one prompt, parser and size limit](#llm-judges-share-one-prompt-parser-and-size-limit)
- [MCP reporter attachments](#mcp-reporter-attachments)
- [Stored results are redacted the same way everywhere](#stored-results-are-redacted-the-same-way-everywhere)
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

Projects created with `mcp-server-tester init` now depend on `@modelcontextprotocol/client` instead of `@modelcontextprotocol/sdk`.

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

The exported `MCP_PROTOCOL_VERSION` constant is the header MST sends on OAuth discovery requests, not the protocol connections speak. It is deprecated and will be removed in a future major. Use `mcpConfig.protocol` to choose a connection's protocol.

## `executeCase` returns a typed `CaseExecution`

**Affects:** code that passes a custom `executeCase` to `runEvalDataset()` or `runEvalCase()`.

`executeCase` now returns a `CaseExecution` that says how the case ran. The runner used to guess this from the shape of `response`.

```typescript
import type { CaseExecution } from '@gleanwork/mcp-server-tester';

// A direct tool result or MCP request result
const direct: CaseExecution = { kind: 'direct', response: toolResult };

// A host run, with the simulation-shaped response validators read
const host: CaseExecution = {
  kind: 'host',
  response: { success: true, response: 'answer', toolCalls: [] },
  evidence: 'structured',
  usage,
};

// Execution that failed before producing a result
const failed: CaseExecution = {
  kind: 'failed',
  response: undefined,
  error: 'host crashed',
};
```

To migrate, add `kind` to what you return. On host executions, rename `hostUsage` to `usage` and `hostTelemetry` to `telemetry`.

`EvalCaseResult` is unchanged. One edge case changes: a `direct` result that happens to look like a host simulation (`success` plus `toolCalls`) no longer gets host-only fields such as `hostUsage` and `mcpHostTrace`. Its expectations are evaluated the same way.

## `external_host` results keep tool precision and recall

**Affects:** reports, baselines or dashboards that average `toolPrecision` / `toolRecall` over `external_host` cases.

When an `external_host` trace is structured enough to grade tool calls, the result now reports `toolPrecision` and `toolRecall` even if `toolsTriggered` fails, as `mcp_host` and suite host results already did. Previously a failing `toolsTriggered` on an `external_host` case dropped both metrics, so dataset averages silently left out exactly the cases that missed tools. Verdicts are unchanged.

Cases whose trace can't support tool assertions (a low-confidence or screenshot trace, or host evidence other than `structured`) still report no metrics.

The reported tool trace now comes from the same match as the metrics. A required call made with the wrong arguments is listed in `mcpHostTrace.missed`, as `toolRecall` already counted it. It used to appear only as an `expected` call.

## `.not` works on `toSatisfyToolPredicate` and `toMatchToolSnapshot`

**Affects:** tests that use `.not.toSatisfyToolPredicate()` or `.not.toMatchToolSnapshot()`.

Both matchers negated their own result and then Playwright negated it again, so `.not` asserted the opposite of what it says. `expect(r).not.toSatisfyToolPredicate(p)` passed when `p` was satisfied, and `.not.toMatchToolSnapshot(name)` passed when the response matched the snapshot. `.not` now means "not", as it does for every other matcher. Assertions without `.not` are unchanged.

A test that relied on the old behaviour now fails. Remove its `.not`. A predicate that throws still fails the assertion, with or without `.not`.

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

**Affects:** code that stores comparisons and reads raw responses back from them, and anything that reads stored eval-runner artifacts, suite summaries or baseline files.

Every API that persists results now uses one policy (`redactStoredResponses` in the result store) with one default. Before, there were six implementations that disagreed.

- **Comparisons redact by default.** `saveEvalRunComparison()`, `saveServerComparison()` and `runServerComparison({ comparisonStore })` used to store every raw tool and host response unless you passed `redactStoredResponses: true`. They now omit them, as the runner, suites and reporter already did. Pass `redactStoredResponses: false` to keep them.
- **What is redacted is the same everywhere.** Every eval case result, wherever it is nested, loses its raw `response` and the exact-match `expect.response` echoed in `request.expect`. The runner's store path, `omitResponsesFromResult()`, suite summaries and baseline files used to keep `request.expect.response`. The reporter and comparisons used to drop any key named `response` at any depth, including tool arguments; they now keep those.
- **One pass rate.** Every run-level pass rate is `passed / total`, and 0 for a run without cases. The reporter's `metrics.passRate` was `NaN` for an empty run, which was stored as `null`.

The reporter's local report (`index.html`, `data.js` and `run-*.json` in its `outputDir`) keeps responses so the report can show them. Its result-store artifacts follow the policy above.

## New in 2.0 (non-breaking)

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
