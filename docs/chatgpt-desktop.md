# ChatGPT desktop evaluation

MST submits through the authenticated ChatGPT desktop app. It does not use the
Codex CLI, Codex APIs, or an inference API to run the evaluated query.

## Surface and platform

Use `type: 'openai.chatgpt.agent.desktop-app.macos'` for macOS or
`type: 'openai.chatgpt.agent.desktop-app.linux'` for Linux. The `chatgpt` alias
selects the local platform. Both accept `options.surface: 'chatgpt-work' | 'codex'`,
with `chatgpt-work` as the default. Surface selection is UI setup; MST does not add
surface instructions to the evaluated prompt.

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
    "configPath": "/run/eval/chatgpt-home/.codex/config.toml",
    "surface": "chatgpt-work",
    "nativeMaxActions": 24,
    "requireMcpCalls": true,
    "correlation": "exact_prompt"
  }
}
```

Model and effort are installed in the native configuration. MST verifies both
against the completed native turn. Linux does not guess mappings from model IDs
to display labels such as `5.6 Terra Medium`.

## Prepared Linux runtime contract

The caller (for example, Scio) owns image/VM provisioning, app installation,
credentials, authentication, isolated profile, display, accessibility bus, and
all desktop-session cleanup. MST does not create these resources or authenticate.

Supply these variables through the process environment or evaluation environment:

- `HOME`: an existing, disposable, caller-owned home. Set
  `MST_CHATGPT_ISOLATED_HOME` to exactly the same absolute path. This is an explicit
  caller attestation, not proof of isolation. Never point it at a normal user's
  home. The caller must prevent profile/config symlinks into personal data.
- `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`: the prepared desktop session.
  Forward `XAUTHORITY`, `AT_SPI_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` when needed. Use one worker
  per desktop.
- `MST_CHATGPT_APP_CONTROLLER`: absolute path to the caller-owned executable
  described below. Optional `MST_CHATGPT_CONTROL_SOCKET` must be absolute.
- `MST_CHATGPT_PYTHON`: optional Python executable (default `python3`). It must
  provide PyGObject with `gi.repository.Atspi` 2.0. MST does not install Linux
  system packages. The app must expose its UI on that AT-SPI bus.
- `MST_CHATGPT_URL_OPENER`: an existing absolute executable path to the caller's
  native draft opener, described below. It is checked before UI actions.
- Install `/usr/bin/xdotool` only if the observed profession onboarding page can
  appear. MST uses it for one geometry-derived mouse click, never keyboard input.
  Typical accessibility dependencies are `python3-gi`, `gir1.2-atspi-2.0`, and
  `at-spi2-core`. No clipboard helper or `xclip` dependency is required.
- The display must be an isolated X11 desktop, not a personal desktop. MST does
  not read, overwrite, save, or restore the clipboard.

`options.configPath` must explicitly name `config.toml` inside the isolated HOME.
MST sets `CODEX_HOME` to that directory and reads only its `sessions/` native
JSONL evidence. It does not accept a separate Linux session-root override. Do not
supply conflicting launch `HOME`, display, or D-Bus settings.

### Lifecycle helper protocol

MST runs `MST_CHATGPT_APP_CONTROLLER state|start|stop` directly, without a shell.
Every invocation receives one JSON object on stdin:

```json
{ "environment": {} }
```

For `start`, `environment` contains the evaluation launch variables, including
`CODEX_HOME` and MCP credential variables. These values must reach the app process,
not just the helper. They are not command-line arguments. Do not log them.
For `state` and `stop`, the object is empty. Each operation must return exit status
0 and exactly one JSON object on stdout:

- `state`: `{ "running": true }` or `{ "running": false }`
- `start`: `{ "launched": true }`
- `stop`: `{ "stopped": true }`

No additional keys or stdout logs are accepted. The helper has a 45-second timeout,
16-KiB output limit, and 128-KiB input limit. An error or uncertain receipt is not
retried. `stop` must synchronously stop all app processes that can read/write the
profile. `start` must not return until the launch is accepted. The AT-SPI driver
then polls for UI readiness. The helper must restrict operations to its assigned
isolated app and must terminate pending work when killed. It must never control a
normal user's app. A cleanup `start` with an empty environment restores the caller's
original app launch settings if the app was running before the batch.

MST claims an isolated-HOME lock, stops the app, installs evaluation config, starts
the app, and selects/verifies the surface once per batch. It restores config at
cleanup and restarts the app only if it was running before setup. A failed cleanup
retains the lock for inspection. The caller owns stale-lock recovery.

### Native draft opener protocol

MST runs `MST_CHATGPT_URL_OPENER` directly, without a shell or arguments. It sends
exactly one JSON object on UTF-8 stdin, bounded to 2 MiB:

```json
{ "prompt": "unchanged query text" }
```

The caller-owned helper must use native app IPC to dispatch the documented
[ChatGPT deep links](https://learn.chatgpt.com/docs/reference/commands):

- Empty `prompt`: open `codex://threads/new` (canonical new local chat).
- Nonempty `prompt`: open `codex://new?prompt=<URL-encoded text>`. This prefills
  the composer and **does not send**. Preserve Unicode and all whitespace.

The helper must validate the isolated `HOME` and target only that prepared app.
It must not invoke the Codex binary, CLI/API inference, a browser, or a second
app profile. It must not log prompts or URLs. MST sends neither in argv. Only
allowlisted desktop variables, including `HOME`, D-Bus settings, XDG paths, and
`CODEX_HOME`, reach it; model and MCP credential variables do not.

Exit status must be 0, and stdout must contain only `{ "opened": true }`. Extra
or duplicate keys, non-boolean values, raw logs, and uncertain receipts fail
closed. Stdout is bounded to 1 KiB; stderr is discarded. Each invocation has a
15-second timeout capped by the remaining driver deadline. Failed or timed-out
calls are not retried. The helper must terminate pending work when killed.
The receipt acknowledges draft dispatch only, not submission or model execution.

### Native UI protocol and limits

The packaged `chatgpt-linux-runtime` script has two modes: `prepare` and `submit`.
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

Preparation selects the surface, opens the canonical empty chat exactly once,
and verifies the requested surface and one exactly empty composer. It never
supplies an evaluation query or activates Send.

Submission re-verifies the prepared surface, opens the exact prompt once, then
verifies the requested surface. If the deep link changed mode, MST permits one
fixed Switch mode menu selection back to the requested surface. The draft must
survive that selection unchanged. There is no reopen, rewrite, fresh-chat button,
File menu, keyboard shortcut, clipboard input, or fallback if the draft is lost.

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
separators cause an exact comparison to fail if the prompt contains them. Send stays blocked until the expanded text matches the
unchanged prompt and exactly one enabled Send control exists. MST activates Send
once. It never presses Enter or retries an uncertain Send.

The action count records each opener invocation and each native selection/click
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
`desktop_driver_failed`. Raw exception text is never returned. Helper failures
are `helper_missing`, `helper_failed`, and `helper_timeout`; invalid profession
geometry returns `profession_geometry_invalid`. Fixed composer failure steps are
`draft-open`, `draft-surface`, `draft-readback`, and `send`. Bounded composer
diagnostics include `textInterface`, `editableState`, and `editableInterface`,
never prompt text or accessible names. Failure-only `draftState` measurements use
the same bounded, expanded readback: `textLength`, `embeddedObjectCount`, and
`newlineCount` count observed Unicode code points; `textSha256` hashes the exact
UTF-8 bytes. Resolved object markers are not counted. Unreadable text omits these
measurements. Readback failures return `composer_text_unavailable`, never raw RPC
errors. The successful receipt schema is unchanged.

These contracts have offline tests only. No Linux evaluation queries have been
sent; prior live batch setup failed before query submission. Verify the new path
against the caller's pinned image. A native fresh-session binding remains
mandatory even after a successful UI receipt.

## Evidence and continuation

The existing strict native trace contract is shared across both platforms:
unchanged `exact_prompt` matching (including only the existing permitted native
terminal-LF normalization), a fresh session and turn for each query, and complete
native final-answer/model/effort evidence. UI text is never treated as an answer.
Explicit `prompt_marker` correlation remains opt-in.

Native or controller uncertainty blocks the remaining batch. There is no automatic
retry. A completed, reliably attributed turn can fail the configured-MCP
measurement without blocking the next case. Host tool calls remain distinct from
MCP calls; unexpected or unattributed MCP servers fail measurement, and
`requireMcpCalls` requires a call on the configured server selection.

Linux controller accounting is in `externalHost.nativeController`, with
`provider: 'linux-atspi'`, the selected surface, and planner/cost marked
`not-applicable`. It is separate from native model usage and from macOS
`externalHost.computerUse` planner accounting.
