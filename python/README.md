# Run MST clients under verifiers

> **Experimental.** This follows [ADR 0015](../docs/adr/0015-mst-clients-run-as-verifiers-harnesses.md), which is proposed. Names and settings can change.

[verifiers](https://github.com/PrimeIntellect-ai/verifiers) is a Python library for evaluation and RL environments. If your tasks are already a verifiers taskset, you can run them on MST's clients without rewriting them as MST datasets. verifiers runs the eval and MST runs the client:

- **verifiers** loads the taskset, starts each rollout's runtime, records the model's traffic through its interception server, and scores the result with the task's rewards and judges.
- **MST** is the rollout's harness. `mst-harness`, a verifiers harness plugin, runs MST's existing `mst run` command once per rollout and returns what the client did.

This directory is separate from MST's TypeScript package. It is its own uv workspace, and it calls MST only through the `mst` CLI installed where a rollout runs, so MST itself has no verifiers code.

## Layout

```text
python/
  pyproject.toml, uv.lock        the uv workspace: dev tools, ruff, pyright, pytest
  Dockerfile                     a runtime image with MST installed
  verifiers/mst_harness/         the harness, as verifiers' own verifiers/v1/harnesses/<name>/
  environments/mst_smoke/        a smoke taskset, as verifiers' own environments/<name>/
  tests/                         the harness's unit tests
```

Each package exports its one plugin class through `__all__`: `MSTHarness`, a `Harness`, and `MstSmokeTaskset`, a `Taskset`. verifiers imports a package by its id, with `-` as `_`, and takes that class. The harness targets verifiers 0.4 (`verifiers>=0.4.1,<0.5`) and MST 2.0.0-rc.0 or later.

## How a rollout runs

```text
verifiers                                  rollout runtime (subprocess or container)
─────────                                  ─────────────────────────────────────────
taskset ── task ──► MSTHarness.launch() ──► mst run --no-grade ──► client (api, codex-cli, …)
                     writes dataset.json                             │            │
                     and eval.json                                   │ model      │ MCP
                                                                     ▼            ▼
              interception server ◄──────────────────────────── verifiers'   the task's
                     │                                           endpoint     MCP servers
                     ├──► model provider
                     └──► trace ──► rewards, judges, metrics
```

1. verifiers loads a task, starts the task's MCP servers and the rollout's runtime.
2. `MSTHarness.setup()` checks that MST starts in the runtime, and its version.
3. `MSTHarness.launch()` writes a one-case dataset (the task's prompt, unchanged) and an eval config (the client, its options, the model, and the task's MCP servers by name).
4. It runs `mst run --no-grade` with the client's inference pointed at verifiers' endpoint. The client's model calls go through verifiers, and its MCP calls go to the task's servers.
5. It reads MST's trial file, keeps it in `trace.info["mst"]`, and returns the client's final reply.
6. verifiers scores the trace with the task's rewards and judges.

## Run a taskset

Install `mst-harness` next to verifiers and your taskset, from this directory:

```bash
uv pip install ./python/verifiers/mst_harness   # brings verifiers>=0.4.1,<0.5
```

Then select the harness by its id, with verifiers' own `vf-run`. The rollout's runtime needs `mst` on its `PATH`.

**In a container.** Build the runtime image, which installs MST from Glean's npm registry on Artifact Registry. Pass an `.npmrc` with the registry's token as a build secret (`tools/npm-registry-auth.sh` in Scio writes one), or `--build-arg NPM_REGISTRY=https://registry.npmjs.org/` for public npm:

```bash
docker build -t mst-verifiers-runtime --secret id=npmrc,src=$HOME/.npmrc python/
ANTHROPIC_API_KEY=... vf-run acme-tasks -m claude-sonnet-4-6 \
  --env.agent.harness.id mst-harness --env.agent.harness.client api \
  --env.agent.runtime.type docker --env.agent.runtime.image mst-verifiers-runtime \
  --client.base-url https://api.anthropic.com --client.api-key-var ANTHROPIC_API_KEY
```

`--build-arg MST_VERSION=<version>` pins MST (default: the `rc` dist-tag), and `--build-arg CLIENT_PACKAGES=@openai/codex-sdk` adds a client's SDK (`@anthropic-ai/claude-agent-sdk` for `claude-code`). verifiers runs the taskset, its tool servers and the interception server on the host, and routes the container to them.

**On this machine.** With MST installed (`npm install -g @gleanwork/mcp-server-tester@rc`), use the `subprocess` runtime instead: `--env.agent.runtime.type subprocess`.

Or in a config file, run with `vf-run acme-tasks @ acme.toml`:

```toml
model = "claude-sonnet-4-6"

[env.agent.harness]
id = "mst-harness"
client = "api"

[env.agent.runtime]
type = "docker"
image = "mst-verifiers-runtime"

[client]
base_url = "https://api.anthropic.com"
api_key_var = "ANTHROPIC_API_KEY"
```

`vf-validate acme-tasks --runtime.type subprocess` checks the taskset without a model, as for any harness. [`environments/mst_smoke`](environments/mst_smoke/README.md) is a small taskset that checks the path end to end.

| Setting          | Default         | Meaning                                                                                                                                              |
| ---------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`         | `"claude-code"` | The MST client, by its canonical name (`mst clients` lists them). It must be on the supported list below.                                            |
| `client_options` | `{}`            | The client's options, as in an eval config's `clientOptions`.                                                                                        |
| `dialect`        | `"auto"`        | The model API the client speaks. `auto` is `responses` for `codex-cli` and `anthropic_messages` for the rest.                                        |
| `plugins`        | `[]`            | MST plugins to load, for a plugin client.                                                                                                            |
| `writes`         | `"unguarded"`   | The write mode MST gives the task's servers. The taskset's own proxy decides what reaches a service. An MST without `writes` (2.0.0-rc.0) gets none. |
| `workdir`        | unset           | Subdirectories to create in a working directory the harness keeps. The files the client leaves there come back in `trace.info["mst"]["files"]`.      |
| `mst_command`    | `["mst"]`       | How to start MST in the runtime, for example `["npx", "mst"]`.                                                                                       |

## Develop

```bash
cd python
uv sync --locked
uv run ruff check . && uv run ruff format --check .
uv run pyright
uv run pytest
uv run vf-validate mst-smoke --runtime.type subprocess
```

## Supported clients

verifiers records a rollout from the model calls that go through its endpoint. A client is supported only if MST can send its inference to an endpoint chosen for each rollout.

| Client                 | Runtime           | Status        | Why                                                                                         |
| ---------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `api`                  | any               | Supported     | MST makes the model calls itself, to `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.             |
| `codex-cli`            | any               | Supported     | MST gives Codex a provider for `OPENAI_BASE_URL`.                                           |
| `claude-code`          | any               | Supported     | Takes `ANTHROPIC_BASE_URL`, unless Claude Code's managed settings set it (see below).       |
| `cowork`, `chatgpt`    | MST's Linux image | Not yet       | Take inference from a gateway, but the image needs a runtime that starts it with VM access. |
| `cowork`               | macOS             | Not supported | Takes inference from managed preferences, which MST doesn't set per run.                    |
| `chatgpt`, `codex-app` | macOS             | Not supported | Run signed in to the user's account.                                                        |

**Managed settings win.** Claude Code's managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS) override `ANTHROPIC_BASE_URL`. On such a machine, Claude Code's model calls skip verifiers. The harness fails each such rollout and names the cause, rather than scoring a reply verifiers never saw. Use `api` or `codex-cli` there.

## What MST returns

| verifiers        | From MST                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The trace        | Built by verifiers from the model calls it intercepted. MST adds nothing to it. Each line of `traces.jsonl` is an episode, with its rollouts' traces in `traces`.                   |
| The output       | The client's final reply.                                                                                                                                                           |
| `trace.info.mst` | The client, the trial's ending, the transcript (events, model calls, evidence), the write record, and any files.                                                                    |
| A failed rollout | An infrastructure failure (client app, workspace, network, provider, setup), model calls that skip verifiers, or a client that failed before any model call, such as a missing SDK. |

A reward can read `trace.info["mst"]["transcript"]["events"]` to check the client's tool calls, which the trace's model calls don't separate into MCP and built-in tools.

## Terms

verifiers and MST name the same things differently. In this mode, verifiers' names are used for what verifiers owns.

| verifiers | MST                                      | Note                                                                                   |
| --------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| taskset   | dataset                                  |                                                                                        |
| task      | case                                     | MST avoids "task", which the MCP specification uses for something else.                |
| harness   | client with its model (an agent harness) | `mst-harness` is one harness for every supported MST client.                           |
| rollout   | trial                                    | One rollout is one MST trial.                                                          |
| trace     | transcript                               | verifiers' trace holds the model calls. MST's transcript holds what the client did.    |
| reward    | grader score                             |                                                                                        |
| env       | none                                     | verifiers' control flow. It is not MST's environment, the services behind the servers. |
| runtime   | runner                                   | Where the rollout runs. Under verifiers, MST's runners aren't used.                    |

## Limits

- **One turn per rollout.** A multi-turn env, such as a simulated user, needs a session MST keeps open across turns, which `mst run` doesn't. ADR 0015 names the path: an `mst acp` command and verifiers' `ACPHarness`.
- **verifiers 0.4.** `mst-harness` implements 0.4's `Harness.launch()` contract, and pins `<0.5`.
- **One client start per rollout.** Each rollout runs `mst run` once.
