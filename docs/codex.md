# The Codex client

The `codex` client runs OpenAI's [Codex](https://developers.openai.com/codex) agent headless, through `@openai/codex-sdk` (which runs the Codex CLI's `codex exec`), with the eval's servers as its MCP servers. It is what Codex users get: Codex's own instructions, tool loading (`tool_search`) and shell, with the model you name.

```json
{
  "name": "codex-smoke",
  "client": "codex",
  "model": "gpt-5.5",
  "datasets": ["./cases.json"],
  "servers": {
    "notes": { "transport": "stdio", "command": "node", "args": ["server.js"] }
  }
}
```

Install the SDK beside MST (`npm install @openai/codex-sdk`); it brings the Codex CLI for your platform. MST's Linux image has it, so `--env docker` and environments built on it run `codex` too.

## Model access

Codex reaches its model as every OpenAI-shaped call in MST does, through `resolveLLMEndpoint('openai')` ([llm-gateways.md](./llm-gateways.md)):

- `OPENAI_API_KEY`, for OpenAI's API, with Codex's built-in provider.
- `OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`, for a gateway or proxy that serves the Responses API. MST gives Codex a provider of its own for it, over HTTPS only (Codex would otherwise try a WebSocket first).
- `apiKeyEnvVar` reads the key from another variable.

For `--env` and `--detach` runs, put these in the `--secrets-file`: workers get the run's secrets, not the coordinator's environment.

## Options (`clientOptions`)

| Option            | Meaning                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | The model Codex runs (or the eval config's `model`). Without one, Codex's default.                                                                                                                                           |
| `timeout`         | The trial's limit in ms (default 300000). Each server's tool calls may run that long.                                                                                                                                        |
| `systemPrompt`    | Added to Codex's instructions as `developer_instructions`; Codex's own stay.                                                                                                                                                 |
| `reasoningEffort` | `minimal`, `low`, `medium`, `high` or `xhigh`.                                                                                                                                                                               |
| `sandbox`         | Codex's sandbox for its shell: `read-only` (default), `workspace-write` or `danger-full-access`. Where `MST_JUDGE_SANDBOX=container` (MST's Linux image), the default is `danger-full-access`: the container is the sandbox. |
| `webSearch`       | Let Codex search the web. Default `false`, so answers come from the servers.                                                                                                                                                 |
| `cwd`             | The directory Codex runs in. Default: an empty temporary directory, removed afterwards.                                                                                                                                      |
| `apiKeyEnvVar`    | Read the model key from this variable only.                                                                                                                                                                                  |
| `env`             | Extra environment variables for the Codex process.                                                                                                                                                                           |

## What each trial runs with

- **A fresh, private `CODEX_HOME`** (also its `HOME`), holding only the `config.toml` MST writes (mode 0600): the model provider, the servers and their credentials, and settings that keep extras out of the result. Codex's plugins, apps, memories, bundled skills, history, update check, analytics and OpenAI-bound metrics are off. Nothing secret is on Codex's command line. The directory is removed after the trial.
- **Its environment** is only what Codex needs (`PATH`, locale, proxy and CA settings), the model key, and the client's `env`. Codex's shell gets only core variables (`shell_environment_policy.inherit = "core"`).
- **Servers.** Each server is required: one that doesn't start fails the trial with Codex's reason, instead of Codex answering without it. Tool calls are approved (`approval_policy = "never"`, tools `approve`): the servers, or a connector's dry-run proxy, decide what a write does. A server's `connectTimeoutMs` is Codex's startup timeout (default 60 s). Codex can't forward OAuth, client credentials, mTLS, a proxy, `retryAttempts` or client capabilities; an eval that sets them for a `codex` server fails validation.
- **Server labels** become Codex `mcp_servers` keys (characters other than letters, digits, `_` and `-` become `_`); the trace keeps the eval's labels.
- **Tool metadata** (`tools`) reaches Codex through MST's local MCP proxy, as for other clients that connect to their servers.

## The trace

The trace (`evidence: structured`) is Codex's own record:

- **Events**, from Codex's event stream, timed as they arrived: each MCP call (`source: mcp`, with its server label, arguments, result text and error status), shell command (`shell`), web search (`web_search`) and file change (`apply_patch`), and each `tool_search` Codex ran to load deferred MCP tools, with the tools it returned in `results`.
- **Model calls**, from the session's rollout file: one per model response, with its response ID, model, usage (uncached input, cached input, output, reasoning tokens), times, text and the calls it asked for (`toolCallIds`, Codex's native call IDs, which the events carry too).
- **Usage**: the turn's total, with input uncached as elsewhere in MST. Codex reports no cost; the eval config's `pricing` estimates one.
- **Telemetry**: the model, reasoning effort, Codex's thread ID, time to first token, and call counts.
- **Host telemetry.** With [`telemetry.host`](./telemetry.md#the-hosts-own-telemetry), MST points Codex's OpenTelemetry exporter (`[otel]`) at its receiver, and keeps the trial's records (`codex.api_request`, `codex.tool_result`, `codex.sse_event`, ..., matched by `conversation.id`).

A trial that times out, or whose Codex process fails, records what Codex reported until then, with the error.
