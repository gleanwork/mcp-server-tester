---
status: proposed
---

# MST clients run as verifiers harnesses

[verifiers](https://github.com/PrimeIntellect-ai/verifiers) is an open-source Python library for building environments to train and evaluate LLMs. Its `verifiers.v1` package splits an eval the way MST does, under other names:

- A **taskset** loads **tasks**. A task has an input, setup and cleanup hooks, rewards, metrics and judges.
- A **harness** is the program that acts on a task with a model, such as Claude Code, Codex or Pi.
- A **runtime** is where a rollout runs: a subprocess, a Docker container, or a remote sandbox.
- An **interception server** sits between the harness and the model provider. It records every model call into the rollout's **trace**, and the task's MCP servers are served to the harness by URL.

Organizations that already write tasksets with verifiers get rewards and judges written once, rollouts recorded call by call, and the same tasksets for evaluation and RL training. What verifiers lacks is MST's clients: its harnesses are agent CLIs, and MST drives agent CLIs, desktop apps and its own `api` client the same way.

The two don't fit together today:

- **Different languages.** verifiers is Python. MST is TypeScript ([ADR 0006](0006-mst-is-written-in-typescript.md)), and its client drivers stay TypeScript.
- **Different owners of the run.** In verifiers, the env owns the rollout: it starts the harness, routes the model's traffic, and scores the result. In MST, the coordinator owns the run: it collects trials, grades them, and compares variants.
- **No TypeScript verifiers.** The only TypeScript port is an alpha of the old API, without tasksets, harnesses, interception or runtimes.

## Options

1. **Port verifiers to TypeScript.** MST would own a copy of a fast-moving library, and every taskset written in Python would need rewriting. Rejected.
2. **MST runs the eval, and verifiers tasksets load into it.** A Python sidecar would give MST a dataset source and a grader for each taskset. The model's traffic would bypass verifiers' interception, which loses the trace that verifiers' rewards and judges read. Rejected.
3. **verifiers runs the eval, and an MST client is its harness.** A Python harness runs MST in the rollout's runtime. Chosen. It has two forms:
   1. **One `mst run` per rollout.** The harness writes a one-case dataset and an eval config, runs `mst run --no-grade`, and reads back the trial. This fits verifiers 0.2's `Harness.launch()` contract, which runs a program to completion, and needs no change to MST.
   2. **A session over the [Agent Client Protocol](https://agentclientprotocol.com).** A new `mst acp` command would serve one client session over stdio, so verifiers can send follow-up turns. verifiers 0.4's `ACPHarness` works this way.

   This decision takes the first form now. The second is the path for multi-turn envs, and needs `mst acp` built.

## Decision

- **verifiers runs the eval.** The taskset, the env, the runtime, the interception server, the trace and the scoring are verifiers'. In this mode MST doesn't grade or compare variants.
- **MST is the harness, through `mst run`.** The `mst-harness` package's `MSTHarness` runs one trial per rollout:
  1. It writes a one-case dataset: the task's prompt is the case's input, unchanged.
  2. It writes an eval config whose servers are the task's MCP servers, by name, with the client, its options and verifiers' model.
  3. It runs `mst run --no-grade` with the client's inference pointed at verifiers' endpoint, and reads the `mst.run/v1` trial file.
  4. It returns the client's final reply as the program's output, and keeps the trial (transcript, evidence, ending, write record) in `trace.info["mst"]`.

  The client code, readiness checks and trial endings are the ones `mst run` uses. verifiers loads a harness by package name, so `harness.id = "mst-harness"` needs no change to verifiers.

- **Only the client's inference goes through verifiers.** The harness sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (or the `OPENAI_` pair) to verifiers' endpoint and rollout secret, and clears the gateway settings a runtime inherits (`MST_LLM_AUTH_COMMAND`, `ANTHROPIC_AUTH_TOKEN`). MST resolves them in `resolveLLMEndpoint()`, as it does a gateway.
- **A rollout whose model calls bypass verifiers fails.** A client can take its endpoint from somewhere MST doesn't control: Claude Code's managed settings override `ANTHROPIC_BASE_URL`. When MST's transcript has model calls and verifiers' trace has none, the harness fails the rollout. Otherwise verifiers would score an empty reply as the client's answer.
- **Supported clients are the ones whose inference MST can route per rollout:** `api` and `codex-cli`, and `claude-code` where no managed settings pin its endpoint. Cowork and ChatGPT in MST's Linux image take inference from a gateway, so they can be added once a verifiers runtime can start that image. These are out of scope: Cowork on macOS and its first-party mode, and ChatGPT and the Codex app on macOS, which run signed in to the user's account.
- **The taskset owns MCP traffic and writes.** A proxy that filters what a server returns, or stops writes, is part of the taskset. MST declares the task's servers `unguarded` by default: their writes reach the taskset's server, which decides what reaches a service. MST's dry-run proxy and write record still apply to servers that MST configures through a connector.
- **A client can leave files.** With `harness.workdir`, the client runs in a working directory the harness keeps, and the files it leaves there come back in `trace.info["mst"]["files"]`. Tasks that ask for a deliverable file read it from there.
- **This amends ADR 0006.** Python is allowed in `python/` and nowhere else, under these rules:
  - It holds no client logic. Starting, driving, resetting and diagnosing a client stay in TypeScript.
  - It holds no grading. Grading belongs to verifiers in this mode, and to MST everywhere else.
  - It has the checks the TypeScript has: format, lint, type check and unit tests, run in CI.
  - It is optional. `mst run` and the npm package never need Python.

## Consequences

- **MST runs in two modes.** `mst run` is unchanged. Under verifiers, the results and scores are verifiers'. MST's transcript reaches them through `trace.info`.
- **One rollout is one turn.** A multi-turn env, such as a simulated user, needs the ACP form.
- **A rollout pays the client's start-up cost.** Each rollout runs `mst run` once. A desktop client would start once per rollout.
- **Each new client needs a routing check.** A client joins the supported list only when MST can send its inference to a per-rollout endpoint.
- **verifiers' version is pinned.** `mst-harness` targets verifiers 0.2, whose `launch()` contract it implements. Moving to 0.4 means the ACP form.
- **Releases cover two packages.** The npm package and `mst-harness` share a version. Publishing `mst-harness` to PyPI is a separate step to add to `RELEASE.md`.
