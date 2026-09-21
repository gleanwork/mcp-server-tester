# Local ChatGPT desktop evaluations

The V2 host `chatgpt` (canonical identity
`openai.chatgpt.agent.desktop-app.macos`) runs the actual ChatGPT desktop Work
surface on macOS. The qualified app is `/Applications/ChatGPT.app`, bundle ID
`com.openai.codex` (the Work-enabled build). It does not substitute Codex CLI or
an API call, and a different Chat-only app is not interchangeable with this build.

UI navigation uses the same Anthropic screenshot/action loop as macOS Cowork,
with ChatGPT-specific instructions. No accessibility selectors, fixed button
coordinates, or deterministic UI fallback are used. The planner selects Work,
creates a task, selects the model and reasoning level, and focuses the composer.
The harness inserts the exact submitted text once; the planner then submits once.

Sign in before running. Grant macOS Accessibility and Screen Recording permission
to the responsible host, keep ChatGPT on the primary display, and keep the desktop
idle. Screenshots of that display are sent to the Anthropic planner; use a dedicated
desktop without unrelated sensitive windows. Set `ANTHROPIC_API_KEY` for the
controller, independently of ChatGPT login and MCP credentials. Use one worker
and `concurrency: 1`. Python 3.10+ and the packaged Cowork dependencies are required;
the normal runtime prepares them automatically unless a worker interpreter is
configured. Xcode command-line tooling is used only for app start/stop control.

## Manifest

```json
{
  "name": "chatgpt-local",
  "datasets": [{ "type": "file", "path": "cases.json" }],
  "servers": [
    {
      "transport": "http",
      "label": "glean-eval",
      "serverUrl": "https://example.test/mcp/eval",
      "auth": { "accessTokenEnv": "GLEAN_API_TOKEN" }
    }
  ],
  "host": {
    "type": "chatgpt",
    "model": "your-chatgpt-model-id",
    "reasoningEffort": "medium",
    "timeout": 300000,
    "options": {
      "requireMcpCalls": true,
      "computerUseProvider": "anthropic-computer-use",
      "computerUseModel": "claude-sonnet-4-6",
      "computerUseMaxActions": 32
    }
  },
  "concurrency": 1,
  "metrics": [
    "passed",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "tool_count"
  ]
}
```

HTTP bearer-token and stdio servers are supported. HTTP custom headers and
interactive MCP authentication are rejected rather than silently discarded.
HTTP credentials are passed through the application's environment, with the
controller receiving them over stdin rather than process-list arguments.

The `servers` list is the same V2 contract used by Cowork. ChatGPT adapts it to
`mcp_servers` in `~/.codex/config.toml`, with the requested `model` and
`model_reasoning_effort` as launch defaults. These settings are restored together.
The AI controller verifies the visible selection and only changes it if needed;
the completed native turn remains the final authority. Cowork instead writes managed Claude
settings and an exclusive server allowlist. The filename reflects ChatGPT Work's
native storage, not use of Codex CLI. `host.options.configPath` can select an
explicit `config.toml`; the lifecycle forwards its directory as `CODEX_HOME`.

Replace `your-chatgpt-model-id` with a model ID supported by your signed-in Work
build. `host.model` and `reasoningEffort` select the evaluated OpenAI model. In contrast,
`computerUseModel` selects the Anthropic model operating the UI. Planner usage is
stored under `hostTelemetry.computerUse`, never added to ChatGPT native usage or
cost. Both native and planner dollar cost remain unavailable when not reported.

## Prompt fidelity and correlation

The default `host.options.correlation` is `exact_prompt`: the harness submits the
dataset scenario unchanged, with no trace marker or MCP-routing suffix. Native
`UserMessage` text must equal that prompt literally, or equal the prompt plus
one terminal LF as observed in ChatGPT's native serialization. The latter is
explicitly tagged `native_terminal_lf`, not hidden by trimming. Existing spaces,
newlines, Markdown escapes, and Unicode are otherwise preserved: no substring,
fuzzy, general whitespace, or latest-file fallback is used.

For diagnostics only, set `host.options.correlation: "prompt_marker"` (in Scio,
`hostOptions.correlation`). This explicitly appends a marker and changes the
prompt. It does not restore routing instructions. The legacy external-host API
uses `correlation: { strategy: "prompt_marker" }` for the same opt-in.

`hostTelemetry.externalHost.correlation` records the strategy, `includedInPrompt`,
`promptUnchanged`, and SHA-256 of the exact submitted UTF-8 prompt. Successful
matches also record `nativePromptMatch` (`exact` or `native_terminal_lf`) and the
separate `nativePromptSha256`. `promptUnchanged` describes the harness's submitted
text, not a claim that native serialization has no terminal LF. Its `marker`
field is an internal run identifier only when `includedInPrompt` is false; it is
not evidence that a marker was sent. Native `session.runMarker` is omitted in
marker-free mode. Session/turn IDs identify the native evidence.

## Evidence and safety

- One V2 batch temporarily installs the selected MCP servers and starts the app
  once. Each case creates a fresh Work chat, takes a new native-file baseline,
  submits its unchanged query once, and waits for its own native turn. The app is
  not stopped between queries. After the batch, the app stops and the original
  configuration is restored once. App-written runtime configuration is preserved
  in a private archive. The original app is reopened only if it was initially
  running. Batch host settings, MCP servers, credentials, and environment must
  match; mixed batches are rejected before touching the app.
- `hostTelemetry.batchLifecycle` records a shared batch ID, setup/cleanup status,
  elapsed time, and completed lifecycle operations. This is one shared observation,
  repeated on each case for attribution—not additive per-case usage. `batchCase`
  identifies the case index and total. Per-case duration excludes batch setup and
  teardown. Native turn duration and planner accounting remain separate.
- Exact-prompt discovery reads only rollout files created after a per-query
  metadata baseline; pre-existing files are skipped even if changed. It matches
  the initial native user message from ChatGPT Work within the query's time
  bounds and requires one unique session/turn. Binding is pinned before waiting
  for completion, with a maximum 30-second discovery window after submission.
  Duplicate candidates or changes to the bound session fail closed. Identical
  queries in later cases remain distinguishable by their fresh baselines and
  session IDs. Only the bound turn contributes answer, tools, and usage. Old
  conversations and authentication files are not used to discover exact matches.
- A cross-process desktop lease is acquired before lifecycle operations. A stale
  lease fails closed; inspect the owning process and config transaction before
  manually recovering an interrupted run. Batch cleanup failures retain that
  lease and mark every collected result as failed without discarding its evidence.
- MCP servers are configured at batch startup, not selected through added prompt
  instructions. A recorded external MCP call outside the selected server IDs fails
  the case. `requireMcpCalls` requires at least one call to a configured server;
  built-in host tools cannot satisfy it. These are per-case measurement failures,
  not reasons to skip later queries after a reliably completed native turn. These
  checks do not disable pre-existing app plugins: use an isolated evaluation
  profile if native server selection is ambiguous. Do not fix wrong-server
  calls by silently adding instructions or relabeling telemetry. Use a dedicated
  profile for write-capable evaluations. The Scio example is read-only.
- Screen Recording and Accessibility are checked in the Python driver before
  planner calls or UI actions. Missing permissions fail with a specific code;
  permission is never requested or granted automatically. Screenshots retain only
  the three most recent frames in planner history to bound image context.
- Unexpected permission, authentication, or account-setting dialogs are not
  approved automatically. Prepare the signed-in application before running.
- Model and reasoning settings are verified against the completed native turn.
  Submission errors, ambiguous completion, and cleanup failures stop subsequent
  cases rather than automatically retrying a potentially submitted prompt.
  Missing/reused native sessions, invalid token accounting, and other untrusted
  execution evidence also block the batch. Completed tool-selection misses,
  native tool errors, and unsuccessful answers do not. `hostTelemetry.caseExecution`
  records completion and whether continuation is allowed; `mcpSelection` records
  configured call counts, unexpected external servers, and the selection verdict.
- ChatGPT Work encodes its confirmed `cua_repl.js` built-in as `McpToolCall` too.
  The parser classifies that exact native namespace/tool pair as `source: host`,
  not an external evaluation MCP call. Native `CommandExecution` and
  `Extension` with kind `web.search` are also captured as host tools, with their
  arguments, outputs, errors, and timing. `rawName` and native `toolProvenance`
  retain original identities and item types. Other namespaces/APIs are not implicitly trusted,
  and configured MCP servers cannot use the reserved `cua_repl` label. Arbitrary
  tool-result metadata or a generic tool name such as `js` cannot grant this label.
- Native tools, arguments, results, errors, durations, model, turn/session IDs,
  conversation history and usage remain in the result. V2 `hostUsage.inputTokens`
  is uncached input; native inclusive totals remain in host telemetry. This avoids
  counting cache reads twice in framework metrics.
- Native telemetry reports separate `mcpToolCallCount`/`hostToolCallCount` and
  error counts. `toolCallCount` (and the framework's `tool_count`) still counts all
  captured native tools. MCP duration/wall time exclude host tools; `hostToolDurationMs`
  reports their elapsed durations. USD cost remains unavailable, not zero.
  LLM-only duration is derived from turn duration minus the union of **all**
  captured native tool intervals; it is not measured API time.

## Local validation

On 2026-09-21, the locally packaged candidate completed one Scio read-only case
through the existing runner, native trace collection, and task-completion judge:

- Anthropic controller: `claude-sonnet-4-6`, five planner responses/actions,
  about 27 seconds, 28,258 input tokens and 533 output tokens.
- ChatGPT native execution: requested model ID, medium reasoning; successful
  `enterprise_search` and `read_document` calls attributed to `glean-eval`.
- The judge passed (1/1); config bytes/mode were restored and the desktop lease
  released. Controller usage remained separate from native usage.

After rebasing onto MST `2.0.0-beta.3` main and current Scio master, the candidate
also passed the normal `pnpm run test:eval` path (1/1): four AI controller actions,
the same exact native model/effort, both MCP calls on `glean-eval`, and verified
config restoration and lease cleanup. The unreleased package was installed as a
local tarball; no published dependency was changed. This path uses no alternate
runtime runner or source-build step during evaluation.

The batch-scoped lifecycle was then qualified with the first three unchanged
queries from Scio's GOLDEN `info-seeking` evalset and its existing
`glean-completeness` judge: 3/3 passed. One install/launch preceded all three
queries, and one stop/restore followed them. OS process sampling observed the
same ChatGPT PID across 163 samples spanning the native turns and their gaps.
All three sessions, turns, and markers were distinct. All 14 MCP calls were
attributed to `glean-eval`, with no tool errors. Raw and Scio-exported telemetry,
answers, call identities, and token totals matched the exact native artifacts.
Config bytes/mode and both locks were restored. A completeness pass is not a
factual-correctness assessment. This run retained prompt markers and routing
instructions; it predates the marker-free default and is not evidence of
unchanged native prompt submission.

The marker-free default was exercised next. The first attempt failed correlation:
ChatGPT serialized the submitted user message with one extra terminal LF. That
query had completed and used `glean-eval`; its failed run was not relabeled as a
pass. The matcher now recognizes only that explicit native LF representation
and records separate submitted/native hashes. In the next run, exact-prompt
binding and telemetry verification passed, but the model chose `cua_repl` rather
than `glean-eval`. Before the built-in classification/continuation fix, the
server-selection guard failed the case and the
remaining two cases were not submitted. Native prompt, answer, tool identities,
and usage were audited against the bound transcript; configuration and both
locks were restored. This validates matching and fail-closed attribution, **not**
a successful three-case quality run with the new default. No routing instructions
were reintroduced to force a pass.

After separating host-tool provenance and batch blockers, the same three queries
were run again with the previously missed case first (query text, tags, and
expectations unchanged). The first query completed using native command/web
search actions but no `glean-eval` call, so its MCP requirement failed. Both later
queries still ran, used `glean-eval`, and passed the configured completeness judge:
**3 attempted, 2 passed, 1 failed, 0 skipped**. Telemetry preserved 7 host actions
and 8 evaluation MCP calls separately. The audit checked native user text/hashes,
action IDs/provenance, errors, token totals, and elapsed-time unions against all
three bound transcripts. One ChatGPT PID persisted across 142 process samples;
one setup/cleanup transaction restored configuration and both locks. The CLI
returned nonzero because a case failed, not because the batch stopped early.

Earlier attempts lacked Screen Recording permission despite having Accessibility
permission. They are failed runs, not evidence of successful AI navigation. The
permission guard now prevents planner calls in that state. This is one local
smoke qualification, not a guarantee across app versions or task types.

This change is macOS-only. A deterministic Linux adapter for a pinned ChatGPT
image is a separate follow-up; no Linux execution or compatibility is claimed.
