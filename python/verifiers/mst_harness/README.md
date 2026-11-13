# mst-harness

Run [MST](https://github.com/gleanwork/mcp-server-tester) clients as a [verifiers](https://github.com/PrimeIntellect-ai/verifiers) harness. verifiers loads the taskset, runs the rollout and scores it. MST runs the client.

Each rollout is one MST trial. The harness writes a one-case dataset and an eval config into the rollout's runtime, runs MST's existing `mst run --no-grade`, and returns the client's final answer. The trial MST recorded (transcript, evidence and ending) goes in `trace.info["mst"]`. The harness needs only the `mst` CLI in the runtime: MST 2.0.0-rc.0 or later.

The client's inference goes to verifiers' interception endpoint, so verifiers records every model call. This works only for clients whose model calls MST can route: `api`, `codex-cli`, and `claude-code` where no managed settings pin its endpoint.

The package is laid out as verifiers' own harnesses are: `mst_harness/__init__.py` exports `MSTHarness` through `__all__`, so verifiers loads it by id:

```sh
vf-run acme-tasks -m claude-sonnet-4-6 \
  --env.agent.harness.id mst-harness --env.agent.harness.client codex-cli \
  --env.agent.runtime.type docker --env.agent.runtime.image mst-verifiers-runtime
```

See [python/README.md](../../README.md) for the runtime image, the settings and the supported clients.
