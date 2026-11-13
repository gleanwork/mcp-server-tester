# Run MST clients under verifiers

> **Experimental.** This follows [ADR 0015](./adr/0015-mst-clients-run-as-verifiers-harnesses.md), which is proposed. Names and settings can change.

[verifiers](https://github.com/PrimeIntellect-ai/verifiers) is a Python library for evaluation and RL environments. If your tasks are already a verifiers taskset, you can run them on MST's clients without rewriting them as MST datasets. verifiers runs the eval and MST runs the client:

- **verifiers** loads the taskset, starts each rollout's runtime, records the model's traffic through its interception server, and scores the result with the task's rewards and judges.
- **MST** is the rollout's harness. `mst-harness`, a verifiers harness plugin, runs one `mst run` trial per rollout and returns what the client did.

The harness is selected like any other verifiers harness, by its id:

```bash
vf-run acme-tasks -m claude-sonnet-4-6 --env.agent.harness.id mst-harness --env.agent.runtime.type subprocess
```

`mst verifiers run <taskset>` is a shortcut for the same `vf-run`. It installs verifiers, the harness and the taskset first, so nothing needs installing but uv:

```bash
ANTHROPIC_API_KEY=... mst verifiers run ./acme-tasks --model claude-sonnet-4-6
```

Use `mst run` when you want MST's datasets, graders, variant comparisons and report. Use verifiers when the tasks and rewards are already written for verifiers, or the same tasks also train a model.

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
2. `MSTHarness.setup()` checks that MST starts in the runtime.
3. `MSTHarness.launch()` writes a one-case dataset (the task's prompt, unchanged) and an eval config (the client, its options, the model, and the task's MCP servers by name).
4. It runs `mst run --no-grade` with the client's inference pointed at verifiers' endpoint. The client's model calls go through verifiers, and its MCP calls go to the task's servers.
5. It reads MST's trial file, keeps it in `trace.info["mst"]`, and returns the client's final reply.
6. verifiers scores the trace with the task's rewards and judges.

## Layout

The Python code is in `verifiers/`, laid out as verifiers lays out its own plugins:

| Path                                                                                | verifiers kind                   | Loaded as                            |
| ----------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| [`verifiers/harnesses/mst_harness`](../verifiers/harnesses/mst_harness/README.md)   | harness (`verifiers/harnesses/`) | `--env.agent.harness.id mst-harness` |
| [`verifiers/environments/mst_smoke`](../verifiers/environments/mst_smoke/README.md) | taskset (`environments/`)        | `vf-run mst-smoke`                   |

Each is a Python package whose `__init__.py` exports one class through `__all__`: `MSTHarness`, a `Harness`, and `MstSmokeTaskset`, a `Taskset`. verifiers imports the package by its id, with `-` as `_`, and takes that class. The harness targets verifiers 0.4 (`verifiers>=0.4.1,<0.5`).

## Run a taskset

You need MST and [uv](https://docs.astral.sh/uv/). MST bundles `mst-harness`. For each run, uv installs it, the taskset and verifiers into a temporary venv, removed after the run, so nothing else needs installing. The bundled `mst-harness` wins over any `mst-harness` the taskset names, so the harness always matches the MST that runs it. A client needs what it needs under `mst run`: `codex-cli` needs `@openai/codex-sdk` installed next to MST, and `claude-code` needs `@anthropic-ai/claude-agent-sdk`.

```bash
mst verifiers run <taskset> --model <model> [options] [-- vf-run options]
```

`<taskset>` is a taskset package directory (a Python package with a `pyproject.toml` that exports its `Taskset` through `__all__`), or the name of a taskset package that uv can install. For a directory, the taskset id is its project name. MST writes a `vf-run` config with the options below and runs `vf-run <taskset-id> @ config`. The rollouts run here, on verifiers' `subprocess` runtime, and the results stay here: `outputs/<taskset>--<model>--mst-harness--<hash>/traces.jsonl`.

| Option                        | Default                                    | Meaning                                                                                                           |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `-m, --model <model>`         | required                                   | The model, as the endpoint names it.                                                                              |
| `--client <client>`           | `api`                                      | The MST client. It must be on the supported list below.                                                           |
| `--api <api>`                 | `openai` for `codex-cli`, else `anthropic` | The API family the client's inference uses. It picks the provider default and, when given, the harness `dialect`. |
| `--base-url <url>`            | the API family's provider                  | The endpoint verifiers forwards model calls to, such as a gateway.                                                |
| `--api-key-var <name>`        | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`    | The variable that holds the endpoint's key. MST stops before starting verifiers when it is unset.                 |
| `--client-option <key=value>` | none                                       | A client option; repeat for more. A JSON value is parsed: `timeout=300000`.                                       |
| `--workdir <dirs...>`         | none                                       | Subdirectories of a working directory the client runs in. Its files come back in `trace.info["mst"]["files"]`.    |
| `-n, --num-tasks <n>`         | all                                        | How many of the taskset's tasks.                                                                                  |
| `-r, --rollouts <n>`          | 1                                          | Rollouts per task.                                                                                                |
| `-c, --concurrency <n>`       | verifiers'                                 | Rollouts at once.                                                                                                 |
| `-o, --output-dir <dir>`      | `outputs/`                                 | Where verifiers writes the run.                                                                                   |
| `--plugins <modules...>`      | none                                       | MST plugins, for a plugin client.                                                                                 |
| `--python <version>`          | `3.12`                                     | The Python uv runs verifiers with.                                                                                |

Options after `--` go to `vf-run` unchanged, and win over the ones above: a taskset's own options (`--env.taskset.<name>`), sampling (`--sampling.reasoning-effort low`), task selection (`--select.include.names aurora`), or a config file (`@ file.toml`).

[`verifiers/environments/mst_smoke`](../verifiers/environments/mst_smoke/README.md) is a small taskset that checks the path end to end: its tasks need one MCP tool call, and its reward checks the client's final reply.

## Use the harness from verifiers

To run verifiers yourself, with your own config, install `mst-harness` next to verifiers where the rollout runs, and MST on its `PATH`. MST's npm package includes the harness:

```bash
npm install -g @gleanwork/mcp-server-tester
uv pip install "$(npm root -g)/@gleanwork/mcp-server-tester/verifiers/harnesses/mst_harness"   # brings verifiers>=0.4.1,<0.5
```

Then select the harness by its id. On the command line:

```bash
vf-run acme-tasks -m claude-sonnet-4-6 \
  --env.agent.harness.id mst-harness --env.agent.harness.client api \
  --env.agent.runtime.type subprocess
```

Or in a config file, run with `vf-run acme-tasks @ acme.toml`:

```toml
model = "claude-sonnet-4-6"

[env.agent.harness]
id = "mst-harness"
client = "api"

[env.agent.runtime]
type = "subprocess"

[client]
base_url = "https://api.anthropic.com"
api_key_var = "ANTHROPIC_API_KEY"
```

`vf-validate acme-tasks --runtime.type subprocess` checks the taskset without a model, as for any harness.

| Setting          | Default         | Meaning                                                                                                                                         |
| ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`         | `"claude-code"` | The MST client, by its canonical name (`mst clients` lists them). It must be on the supported list below.                                       |
| `client_options` | `{}`            | The client's options, as in an eval config's `clientOptions`.                                                                                   |
| `dialect`        | `"auto"`        | The model API the client speaks. `auto` is `responses` for `codex-cli` and `anthropic_messages` for the rest.                                   |
| `plugins`        | `[]`            | MST plugins to load, for a plugin client.                                                                                                       |
| `writes`         | `"unguarded"`   | The write mode MST gives the task's servers. The taskset's own proxy decides what reaches a service.                                            |
| `workdir`        | unset           | Subdirectories to create in a working directory the harness keeps. The files the client leaves there come back in `trace.info["mst"]["files"]`. |
| `mst_command`    | `["mst"]`       | How to start MST in the runtime, for example `["npx", "mst"]`.                                                                                  |

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
