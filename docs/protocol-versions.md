# Protocol Versions

MCP has two protocol eras, and a server can support either or both:

| Era        | Revisions                   | How a connection starts                                                                                          |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **legacy** | `2024-11-05` … `2025-11-25` | `initialize` handshake, then a session                                                                           |
| **modern** | `2026-07-28`                | No handshake. Each request carries its version in `_meta`; `server/discover` advertises what the server supports |

MST can connect with either era, pin a specific revision, and run the same tests, conformance checks, and evals against each. It uses the [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) client, which speaks both.

## Table of Contents

- [Choosing a protocol](#choosing-a-protocol)
- [Running a suite against several protocols](#running-a-suite-against-several-protocols)
- [Checking what was negotiated](#checking-what-was-negotiated)
- [Conformance by era](#conformance-by-era)
- [Cross-era checks](#cross-era-checks)
- [Evals and protocol metadata](#evals-and-protocol-metadata)
- [Errors you may see](#errors-you-may-see)

## Choosing a protocol

Set `protocol` on any `mcpConfig` (stdio or HTTP):

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: 'https://example.com/mcp',
  protocol: '2026-07-28',
}
```

| `protocol`           | Behavior                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `'legacy'` (default) | The `initialize` handshake, byte-for-byte what MST 1.x sent. The server accepts the offered revision or answers with its own. |
| `'2025-06-18'` etc.  | A pre-2026 revision is pinned: MST offers only that revision and fails if the server answers with another.                    |
| `'2026-07-28'`       | Pinned modern revision. Connecting fails if the server does not offer it (no fallback).                                       |
| `'auto'`             | Probes with `server/discover` and falls back to legacy if the server is not modern.                                           |

Pin revisions in tests. `'auto'` falls back silently, so a server whose 2026-07-28 support is broken would still pass on the legacy path. On stdio, `'auto'` also starts an extra short-lived copy of the server for the probe (`protocolProbe: { timeoutMs }` bounds it).

You can also override the protocol for a project or file with the `mcpProtocol` fixture option:

```typescript
test.use({ mcpProtocol: '2026-07-28' });
```

## Running a suite against several protocols

`protocolMatrix()` turns one Playwright project into one project per protocol:

```typescript
import { defineConfig } from '@playwright/test';
import { protocolMatrix } from '@gleanwork/mcp-server-tester';

const mcpConfig = {
  transport: 'stdio' as const,
  command: 'node',
  args: ['server.js'],
};

export default defineConfig({
  projects: [
    ...protocolMatrix({ name: 'docs', use: { mcpConfig } }, [
      'legacy',
      '2026-07-28',
    ]),
  ],
});
// → projects "docs@legacy" and "docs@2026-07-28"
```

Each project sets both `mcpProtocol` and `mcpConfig.protocol`, so fixtures, evals, and conformance checks all use the same protocol. Run one with `npx playwright test --project docs@2026-07-28`.

## Checking what was negotiated

`mcp.protocol` reports what the connection asked for and what it got:

```typescript
test('modern-only behavior', async ({ mcp }) => {
  test.skip(mcp.protocol.era !== 'modern', 'needs 2026-07-28');
  // mcp.protocol → { requested: '2026-07-28', negotiated: '2026-07-28', era: 'modern' }
  const discover = await mcp.discover(); // server/discover result; null on legacy
  expect(discover?.supportedVersions).toContain('2026-07-28');
});
```

## Conformance by era

`runConformanceChecks(mcp)` picks checks by the negotiated era:

- **Legacy connections** run the checks MST 1.x ran (`server_info_present`, `list_tools_succeeds`, `invalid_tool_returns_error`, …), with two that are stricter in 2.0 (see the [migration guide](./migrations/migration-2.0.md#conformance-results-severity-skips-and-new-checks)).
- **Modern connections** also run the rules of the 2026-07-28 spec that hold for any server:

| Check                                  | Level  | Rule                                                                              |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `discover_succeeds`                    | MUST   | `server/discover` works and lists the negotiated version                          |
| `discover_server_info`                 | SHOULD | `DiscoverResult` carries `_meta["io.modelcontextprotocol/serverInfo"]`            |
| `result_type_present`                  | MUST   | Every result has `resultType`                                                     |
| `cache_hints_present`                  | MUST   | `ttlMs` ≥ 0 and `cacheScope` on discover, list, and read results                  |
| `result_server_info`                   | SHOULD | Results carry `serverInfo` in `_meta`                                             |
| `tools_list_deterministic`             | SHOULD | `tools/list` returns the same order each time                                     |
| `tools_list_stable_across_connections` | MUST   | A second connection sees the same tool set                                        |
| `cache_scope_consistent_across_pages`  | MUST   | Every page of a paginated list has the same `cacheScope`                          |
| `resource_not_found_error`             | MUST   | A missing resource is `-32602`, not `-32002` or empty `contents`                  |
| `unknown_tool_protocol_error`          | SHOULD | An unknown tool is a JSON-RPC protocol error rather than `isError`                |
| `unsupported_version_rejected`         | MUST   | An unknown version gets `-32022` with `data.supported` (and HTTP 400)             |
| `missing_meta_rejected`                | MUST   | A request whose `_meta` lacks `clientCapabilities` gets `-32602` (HTTP 400)       |
| `header_mismatch_rejected`             | MUST   | HTTP: `Mcp-Method` or `Mcp-Name` that disagrees with the body gets 400 / `-32020` |
| `unknown_method_not_found`             | MUST   | HTTP: an unknown method gets 404 / `-32601`                                       |
| `no_session_id`                        | SHOULD | HTTP: no `Mcp-Session-Id` is minted or echoed back                                |
| `reserved_error_codes`                 | MUST   | No undefined codes in `-32020..-32099`; no retired `-32002` / `-32042`            |

Failing SHOULD checks are **warnings**: they appear in `result.checks` and the report but do not fail `result.pass`. Checks that cannot run (for example HTTP-only rules on stdio) are reported as **skipped**.

Some rules are about how a server rejects bad requests, which the SDK client never sends. For those, MST sends raw **probe** requests: over HTTP to the same endpoint with the same headers and auth, and over stdio to a separate short-lived copy of the server. Pass `probe: false` to skip them.

```typescript
const result = await runConformanceChecks(mcp, { probe: true }, testInfo);
expect(result.pass).toBe(true);
console.log(
  result.protocol,
  result.checks.filter((c) => !c.pass)
);
```

Skills (SEP-2640) checks run in both eras when the server declares the extension. See the [Skills guide](./skills.md#conformance).

The official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance) covers more of the spec but needs servers that implement its fixture tools and speak HTTP. MST's checks work against any server.

## Cross-era checks

A server that supports both eras should serve the same thing in each. `runCrossEraChecks()` connects once per protocol and compares:

```typescript
import { runCrossEraChecks } from '@gleanwork/mcp-server-tester';

test('legacy and 2026-07-28 clients see the same server', async ({}, testInfo) => {
  const result = await runCrossEraChecks(mcpConfig, {}, testInfo);
  expect(result.pass).toBe(true);
});
```

It checks that every protocol connects (`cross_era_connect`), that tools, tool definitions, resources, prompts, and skill entries match, that capabilities match (SHOULD), and that `protocol: 'auto'` picks the modern era (SHOULD). Pass `protocols: ['2025-06-18', '2025-11-25', '2026-07-28']` to compare other revisions.

## Evals and protocol metadata

Eval runs record the protocol they used in `result.metadata.protocol`, and stored artifacts carry `protocolVersion` and `protocolEra`. `compareEvalRuns()` returns `warnings` when the baseline and candidate used different eras or revisions, because a pass-rate change may then come from the protocol rather than the change you are testing.

`mcp_host` evals use the test's connection, so they follow `protocol`. External hosts (Claude Code, Cowork, ChatGPT) open their own connections and are not affected by it.

## Errors you may see

| Message                                                                                          | Meaning                                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `MCP server did not accept protocol "2026-07-28": ...`                                           | You pinned a modern revision and the server only speaks legacy. Use `'legacy'` or `'auto'`.   |
| `MCP server does not support protocol "2025-11-25" (it supports: ...)`                           | The server is modern-only. Pin one of the listed revisions.                                   |
| `MCP connection failed: streamableHttp=http_400; sse=http_405`                                   | A legacy client against a modern-only HTTP server. Pin `'2026-07-28'`.                        |
| `MCP server answered initialize with a different protocol revision than the pinned "2025-06-18"` | The server counter-offered another legacy revision. Pin the one it speaks, or use `'legacy'`. |
