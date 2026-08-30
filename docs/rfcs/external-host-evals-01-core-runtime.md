# RFC 01: External Host Eval Core Runtime

## Status

Draft.

## Scope

This RFC defines the first implementation phase for external host evals. It is
limited to reusable open-source primitives:

- Normalized external host result types.
- Evidence source and confidence metadata.
- Host driver and trace collector interfaces.
- A CLI-backed driver path using the existing generic CLI host support.
- An optional MCP trace proxy for hosts that can be pointed at a proxy endpoint.
- Reporter fields that make evidence quality visible.

This phase should not depend on Claude Cowork, Glean dashboards, internal trace
stores, or browser automation.

## Why Start Here

CLI hosts and proxy-observed hosts give the cleanest signal with the lowest
operational complexity. They exercise the same abstractions needed by browser
and desktop hosts without starting from the flakiest surface.

This phase also lets open-source users get value immediately:

- Drive a local CLI host.
- Capture stdout/log artifacts.
- Optionally trace MCP JSON-RPC traffic through a proxy.
- Reuse existing eval expectations and reporter views.

## Core Types

```typescript
export type ExternalHostDriverKind = 'cli' | 'browser' | 'desktop' | 'custom';

export type TraceSource =
  | 'mcp-proxy'
  | 'mcp-server-logs'
  | 'host-native-export'
  | 'browser-api'
  | 'dom'
  | 'screenshot'
  | 'manual-import'
  | 'none';

export type ObservationConfidence = 'high' | 'medium' | 'low';

export interface Observed<T> {
  value: T;
  source: TraceSource;
  confidence: ObservationConfidence;
  limitations?: string[];
}

export interface HostArtifact {
  kind: 'stdout' | 'stderr' | 'log' | 'screenshot' | 'video' | 'har' | 'trace';
  name: string;
  path?: string;
  contentType?: string;
  summary?: string;
}

export interface ExternalHostRunResult {
  success: boolean;
  hostName: string;
  hostVariant?: string;
  scenario: string;
  finalAnswer?: Observed<string>;
  toolCalls?: Observed<Array<LLMToolCall>>;
  usage?: Observed<UsageMetrics>;
  conversationHistory?: Observed<
    Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>
  >;
  artifacts: HostArtifact[];
  error?: string;
  durationMs?: number;
}
```

`MCPHostSimulationResult` can either be extended or wrapped. The key requirement
is that existing expectations (`containsText`, `toolsTriggered`, `passesJudge`,
`toolCallCount`) can validate an `ExternalHostRunResult` without losing
evidence metadata.

## Interfaces

```typescript
export interface HostRunContext {
  runId: string;
  caseId: string;
  scenario: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

export interface ExternalHostDriver<Config = unknown> {
  kind: ExternalHostDriverKind;
  setup(config: Config, context: HostRunContext): Promise<HostSession>;
  execute(session: HostSession, scenario: string): Promise<HostExecution>;
  teardown(session: HostSession): Promise<void>;
}

export interface TraceCollector<Config = unknown> {
  source: TraceSource;
  start(config: Config, context: HostRunContext): Promise<void>;
  stop(context: HostRunContext): Promise<Partial<ExternalHostRunResult>>;
}
```

The orchestrator composes one driver with zero or more collectors. A CLI driver
may itself produce stdout, stderr, final answer, and tool calls. A protocol
collector may independently produce MCP tool traces.

## CLI Driver

The existing `hostType: 'cli'` support is the right starting point. Phase one
should reshape it into the external host runtime while preserving current user
behavior.

Example host config:

```yaml
hosts:
  claude-code:
    type: cli
    command: claude
    args:
      - -p
      - '{{scenario}}'
      - --output-format
      - stream-json
      - --verbose
    outputFormat: stream-json
    timeout: 120000
```

The CLI driver should:

- Spawn without a shell.
- Replace `{{scenario}}` in args.
- Capture stdout and stderr as artifacts.
- Parse structured output when configured.
- Return `finalAnswer`, `toolCalls`, and `usage` with source metadata.

## MCP Trace Proxy

The trace proxy is a generic MCP protocol recorder. It is not a Glean service.

For local/CLI/desktop hosts:

```text
host process -> local trace proxy -> target MCP server
```

For hosted web clients that execute MCP calls from the host backend:

```text
host backend -> public trace proxy -> target MCP server
```

Phase one should implement the local form first and design the public form as a
deployment option, not as a requirement.

The proxy should record:

- Run id and case id.
- JSON-RPC request id.
- Method.
- Params.
- Result or error.
- Start/end timestamps.
- Duration.
- Transport metadata that is safe to store.

The proxy should avoid:

- Tool-specific parsing.
- Glean-specific auth assumptions.
- Storing secrets in traces.

Trace output:

```typescript
interface MCPProtocolTraceEvent {
  runId: string;
  caseId: string;
  requestId?: string | number;
  method: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}
```

## Dataset and Config

Minimal phase-one dataset example:

```json
{
  "id": "cli-search-trigger",
  "mode": "external_host",
  "scenario": "Find recent documents about quarterly planning.",
  "host": {
    "name": "claude-code",
    "driver": "cli",
    "observers": ["mcp-proxy"]
  },
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    }
  }
}
```

The implementation can initially support this through `mcpHostConfig` for
backward compatibility, then add `host` as a clearer schema once the runtime
settles.

## Reporter Requirements

The reporter should show:

- Host name and variant.
- Driver kind.
- Evidence sources for final answer, tool calls, usage, and conversation.
- Confidence levels.
- Artifacts.
- Existing pass/fail expectations.

Example display:

```text
Tool calls: 3 calls, source=mcp-proxy, confidence=high
Final answer: source=stdout, confidence=high
Usage: unavailable
```

## Phase-One Outcomes

This phase is complete when:

- A CLI external host can run scenarios through the new runtime.
- Existing CLI host behavior remains compatible.
- The result schema can represent observed values with source/confidence.
- A local MCP trace proxy can capture tool calls for a configurable target MCP
  server.
- Reports distinguish assertion failures from infrastructure failures.
- Reports display evidence source and confidence.

## Explicit Non-Outcomes

- No browser automation yet.
- No Claude Cowork adapter yet.
- No public hosted trace proxy deployment yet.
- No desktop VM orchestration yet.
- No internal Glean dashboard export.

## Risks

- The new schema could duplicate `MCPHostSimulationResult` too much. Prefer a
  small compatibility layer rather than parallel result models.
- The trace proxy could become a second MCP implementation. Keep it as a
  transport-level recorder and forwarder.
- CLI host output formats differ. Start with explicit parsers and artifact
  capture rather than trying to infer every CLI's behavior.
