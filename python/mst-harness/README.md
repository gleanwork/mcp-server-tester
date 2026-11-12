# mst-harness

Run [MST](https://github.com/gleanwork/mcp-server-tester) clients as [verifiers](https://github.com/PrimeIntellect-ai/verifiers) harnesses. verifiers loads the taskset, runs the rollout and scores it. MST runs the client.

Each rollout is one MST trial. The harness writes a one-case dataset and an eval config into the rollout's runtime, runs `mst run --no-grade`, and returns the client's final answer. The trial MST recorded (transcript, evidence and ending) goes in `trace.info["mst"]`.

The client's inference goes to verifiers' interception endpoint, so verifiers records every model call. This works only for clients whose model calls MST can route: `api`, `claude-code`, `codex-cli`, and Cowork in MST's Linux image when it calls a provider directly. See [docs/verifiers.md](../../docs/verifiers.md).

## Use

Install MST in the rollout's runtime, and `mst-harness` next to verifiers:

```sh
npm install -g @gleanwork/mcp-server-tester
uv add mst-harness
```

Then name it as the harness in a verifiers eval config:

```toml
[harness]
id = "mst-harness"
client = "claude-code"
client_options = { timeout = 1800000 }
```

| Field            | Default         | What it does                                                                                                                                                                         |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`         | `"claude-code"` | The MST client, by its canonical name.                                                                                                                                               |
| `client_options` | `{}`            | The client's options, as in an eval config's `clientOptions`.                                                                                                                        |
| `plugins`        | `[]`            | MST plugins to load, for a plugin client.                                                                                                                                            |
| `api`            | `"anthropic"`   | The API family the client's inference uses: `"anthropic"` or `"openai"`.                                                                                                             |
| `writes`         | `"unguarded"`   | The write mode of the task's MCP servers. The taskset's proxy owns writes.                                                                                                           |
| `mst_command`    | `["mst"]`       | How to start MST in the runtime, for example `["npx", "mst"]`.                                                                                                                       |
| `workdir`        | unset           | Subdirectories to create in a kept working directory, for example `["answer"]`. The files the client leaves there come back in `info.mst.files`. Only `claude-code` and `codex-cli`. |

## Develop

```sh
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run pyright
```
