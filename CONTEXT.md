# MCP Server Tester

Tests and evaluates MCP servers: direct tool checks, data-driven evals, and suites that compare hosts and server configurations. Extension follows ESLint's plugin model.

## Language

**Plugin**:
A plain object, the default export of a module or package, that contributes named extensions to MST under one namespace. A plugin is data that core reads; it does not call into core to register itself.
_Avoid_: register hook, extension module

**Namespace**:
The prefix a plugin's extensions are referenced by, as `namespace/name` (for example `acme/legacy`). Declared by the plugin's `meta.namespace`.
_Avoid_: scope, prefix

**Extension**:
One named thing a plugin contributes: a dataset source, host, judge, metric or result store.
_Avoid_: contribution, registration, capability

**Built-in**:
An extension that ships with MST and is referenced by a bare name (for example `file` or `correctness`).
_Avoid_: core plugin, default

**Shared config**:
A named, reusable manifest fragment a plugin offers (for example `recommended`), which a suite opts into; a plugin cannot impose it.
_Avoid_: preset, profile

**Endpoint source**:
(Planned.) An extension that supplies the base URL and credentials MST's own LLM calls use. A run uses exactly one; the built-in `env` source reads environment variables.
_Avoid_: gateway config, LLM provider

**Marketplace plugin**:
A Claude or Codex plugin installed into a desktop host under test. Unrelated to an MST plugin.
_Avoid_: plugin (unqualified)
