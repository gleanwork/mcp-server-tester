# mst-smoke-v1

A verifiers taskset that checks `mst verifiers run` end to end. It is a Python package that exports its taskset (and an optional environment) through `__all__`, the layout verifiers loads.

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

From the repository root, with MST built (`npm run build`) and [uv](https://docs.astral.sh/uv/) installed:

```sh
ANTHROPIC_API_KEY=... npx mst verifiers run python/environments/mst_smoke_v1 --model claude-sonnet-4-6
```

Results go to `outputs/mst-smoke-v1--<model>--mst-harness/<run>/traces.jsonl`. Each trace's `info.mst` holds the trial MST recorded.

For an OpenAI-compatible endpoint or another client:

```sh
npx mst verifiers run python/environments/mst_smoke_v1 --client codex-cli --model gpt-5 \
  --base-url https://gateway.example.com/v1 --api-key-var GATEWAY_KEY
```

A gateway that wants `Authorization: Bearer` instead of `x-api-key` for the Anthropic API also needs the taskset option `upstream_bearer`, passed through after `--`:

```sh
npx mst verifiers run python/environments/mst_smoke_v1 --model claude-sonnet-4-6 \
  --base-url https://gateway.example.com/anthropic --api-key-var GATEWAY_KEY \
  -- --taskset.upstream_bearer true
```

## Clients

`api` and `codex-cli` work anywhere. `claude-code` works where Claude Code takes its endpoint from the environment. Managed settings that set `ANTHROPIC_BASE_URL` override it. The harness then fails the rollout instead of scoring a reply verifiers never saw.
