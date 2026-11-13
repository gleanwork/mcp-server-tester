# mst-smoke

A verifiers taskset that checks `mst-harness` end to end. It is laid out as verifiers' own tasksets are: `mst_smoke/__init__.py` exports `MstSmokeTaskset` through `__all__`, `taskset.py` holds the tasks and reward, and `servers/tool.py` holds the MCP tool.

Each task asks for a project's access code. Only the task's MCP tool, `lookup_code`, knows the code, so a passing rollout shows that:

- the task's prompt reached the MST client,
- the client called the task's MCP server,
- verifiers recorded the client's model calls, and
- the client's final reply reached the reward.

| Score          | Kind   | Meaning                                             |
| -------------- | ------ | --------------------------------------------------- |
| `correct_code` | reward | 1 when the final reply contains the project's code. |

## Run

With verifiers, `mst-harness` and this package installed, and MST on the `PATH`:

```sh
vf-validate mst-smoke --runtime.type subprocess
ANTHROPIC_API_KEY=... vf-run mst-smoke -m claude-sonnet-4-6 \
  --env.agent.harness.id mst-harness --env.agent.harness.client api \
  --env.agent.runtime.type subprocess \
  --client.base-url https://api.anthropic.com --client.api-key-var ANTHROPIC_API_KEY
```

Or from the MST repository root, with MST built (`npm run build`) and [uv](https://docs.astral.sh/uv/) installed, which installs the rest:

```sh
ANTHROPIC_API_KEY=... npx mst verifiers run verifiers/environments/mst_smoke --model claude-sonnet-4-6
```

Results go to `outputs/mst-smoke--<model>--mst-harness--<hash>/traces.jsonl`. Each trace's `info.mst` holds the trial MST recorded.

For an OpenAI-compatible endpoint or another client:

```sh
npx mst verifiers run verifiers/environments/mst_smoke --client codex-cli --model gpt-5 \
  --base-url https://gateway.example.com/v1 --api-key-var GATEWAY_KEY
```

## Clients

`api` and `codex-cli` work anywhere. `claude-code` works where Claude Code takes its endpoint from the environment. Managed settings that set `ANTHROPIC_BASE_URL` override it. The harness then fails the rollout instead of scoring a reply verifiers never saw.
