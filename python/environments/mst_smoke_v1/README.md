# mst-smoke-v1

A verifiers environment that runs an MST client end to end through `mst-harness`. It has the same layout as an enterprise-bench environment: a package that exports its taskset and environment through `__all__`, and a `configs/eval.toml`.

Each task in `mst_smoke_v1/tasks.jsonl` asks for a project's access code. Only the taskset's MCP tool, `lookup_code`, knows the code, so a passing rollout shows that:

- the task's prompt reached the MST client,
- the client called the task's MCP server,
- verifiers recorded the client's model calls, and
- the client's final reply reached the reward.

| Score          | Kind   | Meaning                                             |
| -------------- | ------ | --------------------------------------------------- |
| `correct_code` | reward | 1 when the final reply contains the project's code. |
| `called_tool`  | metric | 1 when MST's transcript shows a `lookup_code` call. |

## Run

MST must be on `PATH` (or set `harness.mst_command`). From this directory:

```sh
uv sync
ANTHROPIC_API_KEY=... uv run eval @ configs/eval.toml
```

Results go to `outputs/<taskset>--<model>--<harness>/<run>/traces.jsonl`. Each trace's `info.mst` holds the trial MST recorded.

For a gateway, override the client. A gateway that wants `Authorization: Bearer` instead of `x-api-key` also needs `--taskset.upstream_bearer true`:

```sh
uv run eval @ configs/eval.toml --taskset.upstream_bearer true \
  --client.base_url https://gateway.example.com/anthropic --client.api_key_var GATEWAY_KEY
```

`uv run eval` here is this package's entrypoint (`mst_smoke_v1/eval.py`). It runs verifiers' `eval`, but builds the Environment the package exports, as enterprise-bench's `eval` does.

## Clients

The config uses MST's `api` client. `claude-code` works too, but only where Claude Code takes its endpoint from the environment. Managed settings that set `ANTHROPIC_BASE_URL` override it. The harness then fails the rollout instead of scoring a reply verifiers never saw.
