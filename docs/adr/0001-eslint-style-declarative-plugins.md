---
status: accepted
---

# Plugins are declarative ESLint-style objects in one namespaced table

The suite design proposed `{ name, register(api) }` plugins that call MST's register functions. We chose ESLint's established model instead. A plugin is a plain default-exported object, `{ meta: { name, version, namespace }, datasetSources, hosts, judges, metrics, resultStores, configs }`. Core reads it; it never calls into core. Its extensions are referenced as `namespace/name`, and bare names belong to MST's built-ins, which use the same shape: a record of definitions per kind, kept next to that kind's lookup so a judge lookup never loads the desktop host drivers. Plugin objects (from manifest and CLI specifiers, `runEvalSuite` / `runEvalDataset` options, Playwright `use`, or `installPlugins` for code that calls validators directly) are the only way in. The public `register*` functions are removed.

Loaded extensions live in one process-wide table keyed by `namespace/name`. Manifest validation rejects any namespaced reference whose plugin the manifest does not list. ESLint scopes plugins strictly to the config that lists them. We take the cheaper check: in MST the only way one run could see another's plugins is `batch` running several manifests in one process. The validation check catches that case without threading a per-run set through every lookup. A plugin's `meta.namespace` is required and authoritative, and manifests can't alias it. That keeps a plugin's shared configs, which refer to its own extensions, valid.

## Considered Options

- **`register(api)` with global register functions.** Plugin code would mutate core state, names would collide across plugins, and each plugin would need MST at runtime rather than only as a peer dependency.
- **Per-run extension sets.** These are strictly isolated, but the set would have to be threaded through every lookup, including inline matchers. That costs more than the batch case justifies.
- **Manifest-assigned namespace aliases.** These would break a plugin's shared configs. They can be added later without breaking anything if two plugins ever need the same namespace.

## Known exception

External hosts (`./experimental/hosts`) still have their own extension path. `registerExternalHostCapability` adds capability implementations to a module-level map, and a capability binding's `uses: "module:<specifier>#<export>"` imports one through a separate loader. Converting it means making capabilities a plugin extension kind, referenced as `namespace/name` with built-ins under bare ids, and then deleting both paths. That is the next change; until then, no other kind may add a register function or a loader of its own.
