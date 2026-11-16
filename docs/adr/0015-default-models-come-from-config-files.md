---
status: accepted
---

# Default models come from config files

MST names a model in four places when nothing else does: the `api` client, LLM judges, agentic judges and the macOS Computer Use planner. Each default was a string constant in the source, so a newer model needed a new MST release. The constants had also drifted. The `api` client used one Claude model for every provider, so `provider: "openai"` without a `model` sent a Claude model ID to OpenAI. The Vercel adapter's per-provider fallbacks never ran, because the client always passed a model.

We keep a built-in table, `BUILTIN_MODELS` in `src/llm/modelDefaults.ts`, and let config files replace any entry in it. The `models` block has one entry per place:

```json
{
  "models": {
    "api": { "anthropic": "…", "openai": "…" },
    "judge": { "openai": "…" },
    "agentJudge": { "codex": "…" },
    "computerUse": "…"
  }
}
```

`api` and `judge` are keyed by provider, and `agentJudge` by runtime, because a model ID belongs to one provider. The `api` client picks its provider first, from `provider` or the model, and then the model for that provider. So the OpenAI default goes to OpenAI.

- **Where it is set.** MST merges these layers, lowest first: the built-in table; the user's `~/.mcp-server-tester/mst.config.json` (`MST_USER_CONFIG` names another file, and empty reads none); the repo's `mst.config.json` ([ADR 0008](./0008-plugin-settings.md)); the eval config's `models`; and the file `mst --mst-config <path>` names. A later layer replaces only the entries it sets. A model that a case, variant, eval config, judge option or `computerUseModel` names always wins.
- **The user's file sets only `models`.** Plugin settings belong to the repo that runs evals (ADR 0008). A person's choice of model doesn't.
- **Shared configs can't set `models`.** `extends` applies after the files are merged, and it replaces keys whole. A shared config's `models` would replace the user's and the repo's entries, which is the wrong order. A plugin that needs a model names it in its extensions' options.
- **Carried in the eval config.** `loadEvalConfig` resolves the layers into the eval config's `models`, so they go with it to workers, grade shards and a detached coordinator. Those read no file of their own. The eval's `contentHash` covers `models`, so a changed default is a different eval. An eval config that no file changes stays the same object, so its hash doesn't change.
- **Judge identity.** A judge's version covers its built-in model. A configured model isn't in the version, so MST writes it into the judge's options before it computes the judge's identity. The identity, `run.json` and each score then record the model that graded. A judge graded on a configured model has the same identity as one that names that model in its options. A judge definition opts in with `modelSlot(options)`, which names the entry it takes its model from, such as `{ kind: 'judge', key: 'openai' }` for `models.judge.openai`. Built-in LLM and agentic judges have one. A plugin judge without one keeps its own defaults. A judge whose fallback is a model of its own, not MST's built-in one, also names it with `defaultModel(options)`: a configured model still replaces it, and when nothing is configured MST doesn't warn about it or list it in `builtinModels`, because the judge's version covers it. An agentic judge whose defaults name a model works the same way, so `models.agentJudge` replaces that model too.
- **A built-in model is a fallback you can see.** The built-in table still goes stale between releases, wherever it lives. So MST says when it uses it. At the start of a run, MST works out each built-in model the run falls back on: for the `api` client, judges, pairwise judges and, on a Mac that runs its own trials, the Computer Use planner. It prints one warning that names each `models` entry to set. `run.json` records the same list as `builtinModels`, so a run shows which of its models nobody chose. Outside an eval run (Playwright tests, grade workers), a judge or `api` case warns the first time it runs on a built-in model in its process. `mst init` writes a `models` block into the new project's `mst.config.json` (`INIT_MODELS`), so a project owns its models from the start.
- **Playwright.** Tests have no eval config. The fixtures read the user's file and the nearest repo file above the spec, with the `mcpModels` option over both. They set the result for the test's process, and the judge validator and `runEvalDataset` read it. Playwright runs one test at a time in a worker, so the value doesn't leak between tests. The fixtures set it for each test and restore it afterwards.

## Considered Options

- **Bump the constants each release.** This is what we did. It ties model choice to MST's release cadence, and users can't pick a newer model before MST does.
- **Environment variables (`MST_API_MODEL`, ...).** Each place needs one per provider, and environment variables aren't validated. A worker gets only the `--secrets-file` values, so they would also not reach shards. The Computer Use planner keeps `MST_COWORK_CUA_MODEL` as a fallback below the configured default.
- **Fetch a model list at run time.** A run's models would change without any change to its files, and runs could not be reproduced offline.
- **Replace the built-in table's sections whole.** A user who sets only the OpenAI judge model would lose the Anthropic one. Merging entry by entry keeps each layer small.
