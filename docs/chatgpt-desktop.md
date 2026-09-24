# ChatGPT desktop evaluation

MST submits through the authenticated ChatGPT desktop app. It does not use the
Codex CLI, Codex APIs, or an inference API to run the evaluated query.

## Surface and platform

Use `type: 'openai.chatgpt.agent.desktop-app.macos'` for macOS or
`type: 'openai.chatgpt.agent.desktop-app.linux'` for Linux. The `chatgpt` alias
selects the local platform. Both accept `options.surface: 'chatgpt-work' | 'codex'`,
with `chatgpt-work` as the default. Surface selection controls UI setup and the
expected native originator; MST does not add surface instructions to the evaluated
prompt.

macOS keeps the Anthropic Computer Use submission driver. It receives the selected
surface and must verify the current-mode label before filling the composer. It
requires `ANTHROPIC_API_KEY`, Accessibility and Screen Recording permission.
Linux uses native draft deep links and deterministic AT-SPI actions. It requires
no Anthropic key and rejects Computer Use planner configuration. It does not fall
back to macOS CUA.

Example Linux host settings (inside a V2 evaluation manifest):

```json
{
  "type": "openai.chatgpt.agent.desktop-app.linux",
  "model": "your-native-model-id",
  "reasoningEffort": "medium",
  "timeout": 300000,
  "options": {
    "surface": "chatgpt-work",
    "nativeMaxActions": 24,
    "requireMcpCalls": true,
    "correlation": "exact_prompt"
  }
}
```

Model and effort are installed in the native configuration. MST verifies both
against the completed native turn. Linux does not guess mappings from model IDs
to display labels such as `5.6 Terra Medium`. Linux rejects `options.configPath`
(unless it equals `$HOME/.codex/config.toml`) and `chatgptSessionRoot`.

## Linux runtime contract

The caller (for example, Scio) owns the VM/container, display, D-Bus, keyring,
AT-SPI bus, the fresh HOME and API-key file (creation and deletion), the package
version check, the disposable no-new-privileges container, and uploading `MST_CHATGPT_EVIDENCE_DIR`. It runs MST as the
unprivileged desktop user with this process environment. There is no controller
helper, socket, opener, or attestation variable.

| Variable                                             | Provided by the caller                 | MST checks                                                                            |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `HOME`                                               | Fresh private dir on tmpfs             | Absolute, normalized, owned, mode 0700, not a symlink. `$HOME/.codex` must be absent. |
| `XDG_RUNTIME_DIR`, `TMPDIR`                          | Private dirs inside the fresh area     | Absolute, owned, mode 0700.                                                           |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` | Under HOME                             | Absolute and inside HOME.                                                             |
| `DISPLAY`, `XAUTHORITY` (optional)                   | Xvfb/desktop display                   | `DISPLAY` required.                                                                   |
| `DBUS_SESSION_BUS_ADDRESS`                           | Caller-owned private session bus       | `unix:` address.                                                                      |
| `AT_SPI_BUS_ADDRESS`                                 | From `org.a11y.Bus.GetAddress`         | `unix:` address.                                                                      |
| `GNOME_KEYRING_CONTROL`                              | Caller-owned unlocked keyring          | Absolute path.                                                                        |
| `MST_CHATGPT_APP_PATH`                               | `/usr/bin/chatgpt`                     | Executable file.                                                                      |
| `MST_CHATGPT_CODEX_PATH`                             | The package's bundled `codex` backend  | Executable file. Used for login and the app-server status probe.                      |
| `MST_CHATGPT_API_KEY_FILE`                           | 0600 file containing only the API key  | Owned regular file, no group/other bits, no symlink, at most 8 KiB, printable ASCII.  |
| `MST_CHATGPT_MCP_TOKEN_<n>`                          | Set by MST from `mcpServers[].auth`    | Config uses `bearer_token_env_var`; never written to disk.                            |
| `MST_CHATGPT_EVIDENCE_DIR`                           | Empty 0700 dir that the caller uploads | Owned, mode 0700, empty at start.                                                     |
| `MST_CHATGPT_PYTHON` (optional)                      | `/usr/bin/python3`                     | Absolute path. Needs PyGObject with `gi.repository.Atspi` 2.0.                        |
| Process isolation (no variable)                      | Disposable no-new-privileges container | Not checked. Required: MST turns off the native sandbox (see below).                  |

Any violation fails the case before a prompt with `environment_invalid: <NAME>`
or another fixed code. A set `CODEX_HOME` must equal `$HOME/.codex`.

MST then owns, in order:

1. Create `$HOME/.codex` (exclusive, 0700) and one empty workspace
   `mkdtemp($TMPDIR/mst-chatgpt-workspace-*)`.
2. Write `config.toml` with `cli_auth_credentials_store = "keyring"`, model,
   reasoning effort, MCP entries with `bearer_token_env_var`, and trust for only
   that workspace, `approval_policy = "never"`, and
   `sandbox_mode = "danger-full-access"`.
3. `codex login --with-api-key` with the key on stdin only, then `codex login status`.
4. Direct MCP preflight (connect and list tools for each configured server) and a
   read-only `codex app-server` probe (`initialize`, `initialized`,
   `mcpServerStatus/list` only; server requests abort; 30 s, 256 KiB/line, 4 MiB
   total). Every configured server must be initialized with at least one tool and
   `bearerToken` auth (or `unsupported` for servers without a bearer).
5. Spawn the app with fixed flags (`--no-sandbox --ozone-platform=x11
--force-renderer-accessibility --disable-gpu --disable-dev-shm-usage`) and fixed
   accessibility variables, in its own process group. The app receives only the
   session variables, `CODEX_HOME`, and `MST_CHATGPT_MCP_TOKEN_<n>`.
6. AT-SPI preparation, then per case exactly one draft and one Send.
7. Copy evidence, stop the app group (TERM, then KILL, then verify no member
   remains), restore config, and remove the workspace. The caller deletes HOME.

Host tool policy: code mode hides MCP tools until the model searches for them,
so the model uses the first capable tool it can see. On the headless VM, that
is the bundled browser (`cua_repl`) or web search, and the MCP server under
test is never tried. On Linux, MST writes
`[plugins."unified-computer-use@openai-bundled"] enabled = false` (the plugin
that adds `cua_repl`) and `web_search = "disabled"`.
`nativeReadiness.hostToolPolicy` records both values. The rollout records
the disabled plugin in `turn_context.disabled_plugin_ids`. Shell commands
stay available. Any host tool call is recorded separately from MCP calls.
macOS is unchanged.

Host plugins (Linux only): a fresh profile has no plugins, so the model has no
skills that point it at the MCP server. The host config has two independent
parts: MCP servers (the manifest `servers`, which may be empty) and
`plugins`. MST has no plugin-specific code. The caller supplies each plugin
and, optionally, a declarative override for each of the plugin's own MCP
servers:

```json
"plugins": [
  {
    "name": "glean",
    "marketplace": {
      "source": "gleanwork/codex-plugins",
      "ref": "<40-character commit SHA>"
    },
    "mcp": {
      "glean_plugin": {
        "url": "https://example.glean.com/mcp/default/eval",
        "auth": { "accessTokenEnv": "GLEAN_EVAL_TOKEN" },
        "minTools": 3,
        "env": {
          "GLEAN_MCP_SERVER_URL": "${url}",
          "CLAUDE_PLUGIN_DATA": "${dataDir}",
          "ENABLE_HITL": "false"
        },
        "files": {
          "mcp-credentials.json": {
            "tokens": { "access_token": "${bearerToken}", "token_type": "Bearer" }
          }
        }
      }
    }
  }
]
```

After login and direct MCP preflight, MST runs `codex plugin marketplace add`
and `codex plugin add` for each entry. Git sources require a full commit SHA;
an absolute local path (a pre-staged checkout) is also accepted, and its ref is
only recorded. Each `mcp` key names a stdio server in the plugin's `.mcp.json`.
MST writes a complete `[mcp_servers.<key>]` table under that same name:
`command`, `args`, and `cwd` from the plugin, and the plugin's `env` merged with
the override `env`. A partial env-only table would make the app reject the
transport. `files` are written as JSON into a private per-server data dir,
`$CODEX_HOME/mst-plugin-data/<plugin>/<server>` (directories 0700, files 0600,
exclusive create, no symlinks). Only `${url}`, `${dataDir}`, and
`${bearerToken}` are substituted; any other `${...}` fails validation.
`${bearerToken}` is allowed only in `files`, so it never enters `config.toml`.
The token comes from `auth.accessTokenEnv`, resolved from the same
environment as direct MCP `auth.accessTokenEnv`; a missing token fails before
the app starts. It is never logged, sent to the app environment, or put in a
receipt.

Plugin MCP servers are eval MCP servers. The app-server probe checks each one
by name: it must be initialized with at least `minTools` tools (default 1).
Native `mcp__<server>__<tool>` calls are attributed to `<server>`, and
`requireMcpCalls` accepts them, also when `servers` is empty. A plugin server
must not share a name with a direct server. Without `mcp`, only the plugin's
skills are added. Any install error fails setup with `plugin_setup_failed`
before the app starts. `nativeReadiness.plugins` records the name,
marketplace, version, ref, and overridden server names.

Execution policy: on Linux, MST writes `approval_policy = "never"` and
`sandbox_mode = "danger-full-access"`. Native command execution needs
bubblewrap, which cannot run inside the container, and nobody can answer an
approval request in a headless run, so a sandboxed command would hang the turn.
This relies on the caller's isolation: Scio must run the whole app in a
disposable no-new-privileges container with a fresh tmpfs profile. MST does not
verify this. `nativeReadiness.executionPolicy` records the fixed values. macOS is
unchanged.

There is no setup-only mode. Setup failures carry fixed codes such as
`home_not_fresh`, `login_unverified`, `mcp_preflight_failed`,
`mcp_status_unavailable`, `mcp_server_not_ready`, `app_exited`, and
`app_stop_failed`. Batch telemetry records `nativeReadiness` (login state,
sanitized per-server preflight and app-server status) next to `nativeSetup`
(AT-SPI accounting). No native output, URL, token, or key is recorded.

### Draft hand-off

MST opens drafts by launching the same app binary briefly with
`codex://new?path=<workspace>&prompt=<text>` (both components encoded like Python
`quote(value, safe='')`; the empty setup draft omits `prompt`). The hand-off process
gets no MCP tokens, runs in its own group with a 20-second limit, and must exit 0.
MST then verifies that the original app process is still alive. The URL is one
argv element, so prompts are limited to 120 KiB after encoding (`prompt_too_large`).
Exit 0 acknowledges the hand-off only; it is not a submission.

The AT-SPI script does not open drafts itself. When it needs a draft, it writes
`{"open": "<sha256 of the UTF-8 draft>"}` on the socket passed as `--open-fd 3`.
MST accepts one request per invocation, only when the hash matches the draft it
expects (empty for setup, the unchanged prompt for submission), performs the
hand-off, and replies `{"opened": true}` or `{"opened": false}`. The script waits
at most 30 seconds (capped by its deadline). After the hand-off, it polls up to
30 seconds for the draft to appear; this is read-only. Nothing is retried.

The app routes each deep link asynchronously and does not order them. A setup
route that lands after the first submission's route replaces that draft with an
empty new chat, so the composer shows only its placeholder (for example,
`Work with ChatGPT`). Because the UI is already ready before the setup hand-off,
readiness cannot show that the setup route landed. Preparation therefore observes
read-only for 5 seconds after its hand-off, within its deadline, before it checks
the surface. It does not act, read text, or reopen during this time.

If a submission's draft does not appear, the error is `state_transition_unobserved`.
It is `draft_prompt_not_applied` when, at the end of the wait, the surface is
ready and the composer text is exactly the text from before the hand-off. The
comparison uses an in-memory hash only. Both codes fail closed with no Send,
reopen, or retry.

Before each submission, the script checks that the selected surface is idle:
one composer and one Send control. After the previous turn, the app can briefly
show neither. The script then polls up to 30 seconds (read-only, before any
action) for them to appear. A different selected surface fails at once, and a
surface that does not settle fails, both with `surface_mismatch`.

### Native UI protocol and limits

The Node adapter uses only the `prepare` and `submit` modes of the packaged
`chatgpt-linux-runtime` script.
It accepts `--timeout-ms` and `--max-actions`, with JSON stdin containing `surface`
and, only for submission, `prompt`. A successful receipt contains `status`
(`ready` or `submitted`), `surface`, `action_count`, and `duration_ms`. The Node
adapter caps each invocation at 60 seconds and validates the receipt. It forwards
only desktop environment variables, not model or MCP credentials, to Python.

The English selectors come from ChatGPT 26.915.31945 observations. Preparation can
select Engineering, advance Continue, skip the specific example-introduction
screen, confirm Go to ChatGPT, and select the requested Switch mode menu item.
Engineering selection uses the unique observed radio/toggle's public AT-SPI
Component WINDOW extents plus its containing frame's SCREEN origin. Integer
geometry must fit within the frame and pass the public Component hit test when
available. The only mouse command is `xdotool mousemove x y click 1`, with no
`--sync`, hard-coded coordinates, or fallback checkbox action. MST then polls for
enabled Continue on the observed profession page; a stale checked bit does not
block it. Unknown onboarding and ambiguous controls fail closed.

Preparation selects the surface and calls `open_prompt('')` exactly once to open
the canonical new chat. After the 5-second read-only settle described in
[Draft hand-off](#draft-hand-off), it verifies the requested surface, one available
editable composer, and one visible Send control (which can be disabled). If the
deep link changed mode, one fixed Switch mode correction is allowed. Setup has
no user prompt: it does not require or claim an empty Text readback. A visible
placeholder can appear as nonempty composer Text. `ready` means the controls and
surface are ready, not that empty text was verified or a model task ran.
Preparation never supplies an evaluation query or activates Send.

Submission re-verifies the prepared surface and asks MST to hand off the original
prompt unchanged, including all Unicode and whitespace. It opens that draft
once and requires matching composer Text **before and after** any optional mode
correction. A match is only `text == prompt` or `text == prompt + '\n'`: the one
additional native terminal LF is a bounded representation, not a query edit.
This is the same allowance as native `exact_prompt` correlation. Two or more
additional LFs, changed prefixes or suffixes, and trimmed spaces do not match.
If the deep link changed mode, MST permits one fixed Switch mode menu selection
back to the requested surface. The draft must still match after that selection.
There is no trimming, newline cleanup, other normalization, reopen, rewrite,
fresh-chat button, File menu, keyboard shortcut, clipboard input, or fallback if
the draft is lost.

The composer must be unique, visible, showing, enabled, sensitive, have EDITABLE
state, an allowed non-password role, and a real Text interface. Nested editable
paragraphs belong to their containing editor; independent fields stay ambiguous.
Readback uses unbound `Atspi.Text.get_character_count` and
`Atspi.Text.get_text(node, 0, count)` to avoid the PyGObject Accessible/Text binding
collision. Bare and `org.a11y.atspi.*` interface advertisements are supported.
For each U+FFFC object character, an advertised Hypertext interface can supply an
explicit reference through `Atspi.Hypertext.get_link_index(node, offset)` and
`get_link(node, index)`. Only a link with exactly one anchor is expanded through
`Atspi.Hyperlink.get_object(link, 0)` and recursive unbound Text reads. An empty
linked paragraph therefore reads as empty. Invalid or ambiguous links fail closed;
they do not trigger a structural fallback.

If Hypertext is not advertised or its link index is -1, a narrow structural
fallback applies only when the **entire Text value is one U+FFFC**. Starting at the
owned editable composer, each expanded node must have exactly one direct child.
That child must be a `paragraph` or `text` with a real Text interface, read with the
same unbound methods. A paragraph can instead contain one visible, showing leaf
with role `static` or `static text` and no children. Only that leaf's accessible
name may supply content when it has no Text interface. Text remains preferred
when available. This fallback follows direct composer descendants only; a
Hypertext target alone does not establish ownership for structural expansion.
Arbitrary labels, buttons, images, password fields, and non-Text paragraph/text
children are rejected. Static leaf content is input validation only and is never
exported as raw diagnostics or used as answer evidence.

Zero or multiple direct children leave the marker literal; there is no child-order
or paragraph-joining guess. Cycles, incomplete reads, invalid metadata, and
exceeded budgets fail closed. Each read permits at most 256 node visits, 16 levels
including the root, and 2 MiB of cumulative source UTF-8 bytes (including object
characters and static leaf content) and expanded output, within the driver deadline.

All other literal text is unchanged, including whitespace, line feeds, and
unresolved U+FFFC. No paragraph separators are invented: missing reported
separators cause the comparison to fail if the prompt contains them. Send stays
blocked until the expanded text equals the unchanged prompt or that prompt plus
one terminal LF, and exactly one enabled Send control exists. This also applies
when the original prompt already ends in LF; only one additional LF is allowed.
MST activates Send once. It never presses Enter or retries an uncertain Send.

The action count records each draft hand-off and each native selection/click
attempt separately. Typical preparation is one action; typical submission is two
(open draft, Send). A mode correction adds two menu actions. These are controller
actions, not model requests or MCP calls. A ready/opened receipt is not evidence
of a submission. Read-only polls do not increment the action count.

An acknowledged action without an observed state change gets bounded resnapshots,
not another click. Read-only snapshot traversal can restart at most twice on
transient GLib errors; partial trees never authorize actions. Authentication and
permission requests are not handled automatically.

Failed receipts retain `status: 'failed'` and an allowlisted `error` code. Unexpected
AttributeError, TypeError, and GLib.Error map to `desktop_attribute_error`,
`desktop_type_error`, and `desktop_glib_error`; other exceptions map to
`desktop_driver_failed`. Raw exception text is never returned. Hand-off failures
are `helper_missing` (no `--open-fd`), `helper_failed`, and `helper_timeout`;
MST adds `open=<code>` to its error when its own hand-off failed; invalid profession
geometry returns `profession_geometry_invalid`. Fixed composer failure steps are
`draft-open`, `draft-surface`, `draft-readback`, and `send`. Failure receipts
carry only `error`, `phase`, `step`, and `draftState`; never prompt text or
accessible names. Failure-only `draftState` measurements use
the same bounded, expanded readback: `textLength`, `embeddedObjectCount`, and
`newlineCount` count observed Unicode code points; `textSha256` hashes the exact
UTF-8 bytes. Resolved object markers are not counted. Unreadable text omits these
measurements. Readback failures return `composer_text_unavailable`, never raw RPC
errors. The successful receipt schema is unchanged.

Offline tests cover these controller contracts. Verify the app flags and hand-off
against the caller's pinned image. A native fresh-session binding remains mandatory even
after a successful UI receipt.

## Evidence and continuation

The existing strict native trace contract is shared across both platforms:
unchanged `exact_prompt` matching (only exact text or one additional native
terminal LF, reported as `native_terminal_lf`; on Linux only, Markdown
punctuation backslash-escaped by the app, reported as
`native_markdown_escaped`), a fresh session and turn for each
query, and complete native final-answer/model/effort evidence. UI text is never
treated as an answer.
Explicit `prompt_marker` correlation remains opt-in.

Native originator acceptance is surface-specific and case-sensitive:

- Default or explicit `options.surface: 'chatgpt-work'` requires exactly
  `session_meta.payload.originator: 'codex_work_desktop'`.
- Explicit `options.surface: 'codex'` requires exactly `'Codex Desktop'`, as
  observed in preserved Linux run `35881948713` (`source: 'vscode'`).
- Neither surface accepts the other surface's originator, CLI identities such as
  `codex_cli_rs` or `codex_cli`, case changes, whitespace changes, or name variants.
  Native metadata never selects or changes the configured surface. `source` alone
  does not establish the surface.

The internal parser API preserves existing callers: `findChatgptTrace` accepts
`surface` in its fifth-argument options; `parseChatgptTrace` accepts an optional
fifth argument `{ surface, mcpServers }` after `observedBeforeMs`. Both default to
Work and no configured labels.
`expectedChatgptOriginator(surface)` provides the same fixed mapping.

On Linux, MST copies the matched (or bound but failed) transcript into
`MST_CHATGPT_EVIDENCE_DIR` before teardown, as `<caseId>-<random>/matched-<name>`
(32 MiB limit). The artifact references the copy and includes its sha256. Copies
read only regular, owned, single-link files inside the session root, without
following symlinks, and are verified after writing. A successful case whose
matched transcript cannot be preserved fails as `host_run_failed`. Unmatched
sessions are not copied. macOS does not copy evidence; its artifact references
the native transcript path.

The preserved Codex trace above contains `gpt-5.6-terra`, medium effort, and the
native terminal-LF prompt form. It ends in `turn_aborted`, without `task_complete`.
It is evidence for originator binding, **not a completed or passing evaluation**.
The parser's `complete` flag means terminal: an abort also sets `error`, and the
adapter returns `host_run_failed` (with partial telemetry) before accepting any
final answer. Offline tests
use a minimized, redacted abort fixture; no model calls are needed.

### Native telemetry

The parser reads only native structure in the matched turn, never tool-result text:

- `response_item` `function_call` / `custom_tool_call`, paired with their
  `*_output` by `call_id`. Duration is the `create_time` difference. A call
  without output is marked `pending` in `toolProvenance`.
- A `function_call` namespace `mcp__<label>` is an MCP call. Configured labels map
  back with the app's namespace form (non-alphanumeric → `_`, so `glean-eval` is
  `mcp__glean_eval`). `executed_tool_calls` must agree. `cua_repl.js` stays a host
  tool. Unknown namespaces remain external MCP calls.
- Work code mode: a `custom_tool_call` `exec` is one host call. MST keeps only the
  nested host tool names (for example `web__run`, `exec_command`), input length,
  and sha256, never the code. Each nested `tools.mcp__<label>__<tool>` reference
  (or `executed_tool_calls` entry) is also an MCP call on that label. These nested
  calls have no separate arguments or latency, and a trace limitation says so.
- `item_completed` `McpToolCall`, `CommandExecution`, and `Extension` `web.search`
  items (other builds) remain supported; a shared id counts once.
- Usage comes from `token_usage_record` (`turn_token_usage`).

A bound turn that times out or aborts still fails (`timeout` or
`host_run_failed`). The result keeps the recorded tool calls, usage, and
conversation, with `telemetry.partial: true`, `traceConfidence: 'low'`, and the
limitation "Turn did not complete; tool calls and usage are partial." Partial
usage duration is the native elapsed time so far.

Native or controller uncertainty blocks the remaining batch. There is no automatic
retry. A completed, reliably attributed turn can fail the configured-MCP
measurement without blocking the next case. Host tool calls remain distinct from
MCP calls; unexpected or unattributed MCP servers fail measurement, and
`requireMcpCalls` requires a call on the configured server selection.

Linux controller accounting is in `externalHost.nativeController`, with
`provider: 'linux-atspi'`, the selected surface, and planner/cost marked
`not-applicable`. It is separate from native model usage and from macOS
`externalHost.computerUse` planner accounting.
