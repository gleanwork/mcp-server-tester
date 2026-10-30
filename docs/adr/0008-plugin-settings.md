---
status: accepted
---

# Plugins take settings from the repo that runs evals

Some values belong to the repo that runs evals, not to one extension or one eval config: a cloud project, an internal endpoint, where an organization keeps its datasets. Plugins had nowhere to take them. An extension's options come from its eval config entry, so every eval config had to repeat them, and connectors, credential stores and environments have no entry at all. Plugins worked around it with a factory, `createAcmePlugin({ project })`, called from a wrapper module in the repo. That only works on a laptop: `mst env setup` refuses a file plugin, a worker can't load a file on the coordinator's machine, and `--detach` sends only the eval config ([ADR 0004](./0004-environments-run-shards-over-a-channel.md), [0005](./0005-grading-runs-in-an-environment.md), [0007](./0007-detached-runs-move-the-coordinator.md)).

We follow ESLint's `settings`. A plugin declares `settings: { schema }`, a Zod schema for its section. The repo writes the values in `mst.config.json`, one section per plugin namespace:

```json
{ "settings": { "acme": { "project": "acme-evals" } } }
```

An eval config may set `settings` too. Its section for a namespace replaces the file's section for that namespace, whole, as every eval config key replaces a shared config's. Every extension of the plugin receives the parsed section as `settings`: in the context it already gets (dataset sources, clients, environments, connector `launch`), or as an optional last argument (judges, pairwise judges, metrics, result stores, credential stores, connector auth functions).

- **Finding the file.** `loadEvalConfig` reads the nearest `mst.config.json` at or above the eval config's directory, stopping at the repository root (the directory holding `.git`), and merges it into the eval config's `settings`. Discovery commands with `--plugins` alone read the one at or above `--root-dir`.
- **Checking.** Once the eval's plugins are loaded, `resolveConfigExtends` keeps only the sections of those plugins and parses each plugin's section with its schema, `{}` when it has none, so a missing or wrong value fails before a run starts. A section for a loaded plugin that takes no settings is an error. Sections for plugins the eval doesn't load are dropped: one file serves every eval in the repo.
- **Carried in the eval config.** The settings are part of the resolved eval config, so they go wherever it goes with no new channel: shard bundles, grade bundles, and the eval config `--detach` copies (which now holds the merged settings). Workers read no `mst.config.json` of their own.
- **Identity.** The eval's `contentHash` is computed from the resolved eval config, so a changed setting is a different eval, and `runEvalBatch` doesn't resume a run made with other settings. Another plugin's section doesn't change it.
- **Values, not files.** Settings are JSON. They can name a path, but a path means nothing on another machine, so a judge's prompts and scripts still ship in its package (ADR 0005).

## Considered Options

- **Plugin factories.** A plugin built from options in a wrapper module can't be installed as a package, so it can't run in an environment or detached. Rebuilt copies with different options would also need a namespace each.
- **Options on each extension.** They already exist, but they repeat a repo-wide value in every eval config entry, and connectors, credential stores and environments have no entry to put them in.
- **Environment variables.** They aren't validated, aren't part of the eval's identity, and a worker gets only the `--secrets-file` values, by design.
- **Settings in shared configs.** A plugin's own defaults belong in its schema (`.default()`). A shared config that set settings would mean `extends` could change values the repo set.
- **Process-wide settings.** `runEvalBatch` runs eval configs concurrently in one process, so settings set when plugins load would leak between them. Each eval's settings travel with its eval config instead.
