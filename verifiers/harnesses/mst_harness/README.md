# mst-harness

Run [MST](https://github.com/gleanwork/mcp-server-tester) clients as a [verifiers](https://github.com/PrimeIntellect-ai/verifiers) harness. verifiers loads the taskset, runs the rollout and scores it. MST runs the client.

Each rollout is one MST trial. The harness writes a one-case dataset and an eval config into the rollout's runtime, runs `mst run --no-grade`, and returns the client's final answer. The trial MST recorded (transcript, evidence and ending) goes in `trace.info["mst"]`.

The client's inference goes to verifiers' interception endpoint, so verifiers records every model call. This works only for clients whose model calls MST can route: `api`, `codex-cli`, and `claude-code` where no managed settings pin its endpoint. See [docs/verifiers.md](../../../docs/verifiers.md).

The package is laid out as verifiers' own harnesses are: `mst_harness/__init__.py` exports `MSTHarness` through `__all__`, so verifiers loads it by id.

## Use

Install MST where the rollout runs, and this package next to verifiers. MST's npm package includes it:

```sh
npm install -g @gleanwork/mcp-server-tester
uv pip install "$(npm root -g)/@gleanwork/mcp-server-tester/verifiers/harnesses/mst_harness"
```

Then select it by id:

```sh
vf-run acme-tasks -m claude-sonnet-4-6 \
  --env.agent.harness.id mst-harness --env.agent.harness.client codex-cli \
  --env.agent.runtime.type subprocess
```

or in a `vf-run` config file:

```toml
[env.agent.harness]
id = "mst-harness"
client = "claude-code"
client_options = { timeout = 1800000 }

[env.agent.runtime]
type = "subprocess"
```

`mst verifiers run ./acme-tasks --model claude-sonnet-4-6` does the same with uv, installing verifiers, this package and the taskset first.

| Field            | Default         | What it does                                                                                                                                                                         |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`         | `"claude-code"` | The MST client, by its canonical name.                                                                                                                                               |
| `client_options` | `{}`            | The client's options, as in an eval config's `clientOptions`.                                                                                                                        |
| `plugins`        | `[]`            | MST plugins to load, for a plugin client.                                                                                                                                            |
| `dialect`        | `"auto"`        | The model API the client speaks. `auto` is `responses` for `codex-cli` and `anthropic_messages` for the rest.                                                                        |
| `writes`         | `"unguarded"`   | The write mode of the task's MCP servers. The taskset owns writes.                                                                                                                   |
| `mst_command`    | `["mst"]`       | How to start MST in the runtime, for example `["npx", "mst"]`.                                                                                                                       |
| `workdir`        | unset           | Subdirectories to create in a kept working directory, for example `["answer"]`. The files the client leaves there come back in `info.mst.files`. Only `claude-code` and `codex-cli`. |

The harness runs on verifiers' `subprocess` runtime (`NEEDS_CONTAINER = False`): MST gives each client it starts a fresh config and working directory.

## Develop

The dev environment includes the smoke taskset, [`../../environments/mst_smoke`](../../environments/mst_smoke/README.md).

```sh
uv sync
uv run pytest
uv run ruff check . ../../environments && uv run ruff format --check . ../../environments
uv run pyright
uv run vf-validate mst-smoke --runtime.type subprocess
```
