# MCP Server Tester

Tests and evaluates MCP servers: direct tool checks, data-driven evals, and suites that compare hosts and server configurations. Extension follows ESLint's plugin model.

## Language

**Manifest**:
A JSON file describing one evaluation suite: its datasets, servers, host, metrics, judges and arms. `mst run` runs one.
_Avoid_: config, suite file

**Dataset**:
A named list of cases. A manifest names datasets by source: a file, a directory, a GCS object, or a plugin's dataset source.
_Avoid_: eval set, test file

**Case**:
One thing to check: a direct tool call or MCP request, or a scenario a host acts on, with the expectations its result must meet.
_Avoid_: test, example

**Host**:
What runs a case's scenario: an LLM with the servers' tools (MST's SDK host, the Anthropic API), an agent CLI, or a desktop app. A host returns a trace and never a verdict.
_Avoid_: client, agent, runner

**Arm**:
One configuration a suite compares, varying the servers, the host and its options (a system prompt is `host.systemPrompt`), the tool variant, the scenario template, judges or metrics. Every arm runs the same cases.
_Avoid_: variant (a tool variant is one thing an arm can vary), treatment

**Tool variant**:
The tool names, descriptions and input schemas an arm shows the host instead of the servers' own (`toolOverrides`). Calls are recorded under the tools' original names.
_Avoid_: override set, A/B config

**Trace**:
What a host did in one trial, in order: tool calls (MCP or host), skill loads, commands, subagents and tool searches, with usage and the final answer.
_Avoid_: transcript, log, response

**Evidence**:
How far a host's trace can be trusted for tool assertions: `structured` (protocol or host-native records), `observed` (best effort) or `none`. Only `structured` evidence can pass `toolsTriggered` and `toolCallCount`; a host that declares nothing counts as unverified.
_Avoid_: confidence, fidelity

**Verdict**:
Whether a case passed, decided by MST from the trace and the case's expectations; with iterations, whether its trials reached the accuracy threshold. Hosts supply traces and judges scores; MST owns the verdict.
_Avoid_: result, score

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

**Trial**:
One run of a case: one iteration, or the case itself when it runs once. Per-trial metrics average over a case's trials; runs that failed on infrastructure aren't trials.
_Avoid_: attempt, sample

**Endpoint source**:
(Planned.) An extension that supplies the base URL and credentials MST's own LLM calls use. A run uses exactly one; the built-in `env` source reads environment variables.
_Avoid_: gateway config, LLM provider

**Marketplace plugin**:
A Claude or Codex plugin installed into a desktop host under test. Unrelated to an MST plugin.
_Avoid_: plugin (unqualified)
