# Evaluation framework contract

This document describes the framework shape exposed by `mcp-server-tester`.
The first implementation branch defines these contracts; later branches fill in
execution behavior behind them.

## Configuration

A run is described by an `EvalConfig` JSON object. The editor-facing contract
lives in `schema/eval-config.schema.json`, while runtime validation uses
`EvalConfigSchema`.

```json
{
  "name": "tool-selection-search",
  "mode": "tool-selection",
  "evalsetFilePaths": ["evalsets/tool-selection/search.json"],
  "model": "claude-sonnet-4-6",
  "clientHost": "claude-cli",
  "mcpUrl": "https://example.com/mcp",
  "metrics": ["passed", "tool_count"],
  "concurrency": 5
}
```

The contract also reserves fields for SxS evaluation, plugins, judges, native
MCP servers, and runtime limits. Credentials are represented by environment
variable names; secrets do not belong in config files.

## Execution lifecycle

```text
EvalConfig
  -> load and validate config
  -> resolve evalset paths
  -> load plugins and registrations
  -> build runtime EvalDataset cases
  -> execute cases through a host adapter
  -> evaluate expectations and metrics
  -> persist results and optional summaries
```

The public contracts for the suite, batch runner, host adapters, metrics, native
server resolver, and result summary generator are in
`src/evals/evalFrameworkTypes.ts`.

## CLI shape

```bash
mcp-server-tester run --config ./eval-config.json --dry-run
mcp-server-tester batch --configs ./eval-config.json --dry-run
```

The scaffold validates configuration, loads plugins, and emits a run plan. It
does not claim to execute a run until the execution implementation is added.

## Implementation boundaries

- Config loading and schema validation are framework concerns.
- Dataset conversion and suite execution implement the runner contracts.
- Metrics and result summaries implement their extension points.
- Claude CLI, browser, SxS, and native MCP behavior implement host adapters.
- Batch scheduling and publishing implement operational concerns.
