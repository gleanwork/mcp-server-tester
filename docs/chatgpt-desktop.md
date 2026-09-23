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
Linux uses deterministic AT-SPI actions. It requires no Anthropic key and rejects
Computer Use planner configuration. It does not fall back to macOS CUA.

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
  and `GNOME_KEYRING_CONTROL` when needed. Use one worker per desktop.
- `MST_CHATGPT_APP_CONTROLLER`: absolute path to the caller-owned executable
  described below. Optional `MST_CHATGPT_CONTROL_SOCKET` must be absolute.
- `MST_CHATGPT_PYTHON`: optional Python executable (default `python3`). It must
  provide PyGObject with `gi.repository.Atspi` 2.0. MST does not install Linux
  system packages. The app must expose its UI on that AT-SPI bus.
- Install `xclip` and `xdotool` (Debian/Ubuntu packages of the same names) at
  `/usr/bin/xclip` and `/usr/bin/xdotool`. Both are checked before any UI action;
  absence returns `helper_missing`. Typical accessibility dependencies are
  `python3-gi`, `gir1.2-atspi-2.0`, and `at-spi2-core`.
- The display must be an isolated X11 desktop, not a personal desktop or a shared
  clipboard session. Disable clipboard managers and clipboard forwarding. The
  caller's isolation contract covers the X11 CLIPBOARD selection as well as HOME.
  MST does not save or restore a personal clipboard.

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
An acknowledged action without an observed state change gets bounded resnapshots,
not another click. Unknown onboarding, authentication, permission requests, stale
trees, and ambiguous controls fail closed.

Each query re-verifies the selected surface, requires one visible, showing,
enabled, sensitive composer with EDITABLE state, an allowed non-password role,
and a real Text interface (not generic static text), selects New chat once, and
verifies the composer is exactly empty. Chromium can expose EDITABLE and Text
without EditableText. When EditableText is present, MST calls the unbound
`Atspi.EditableText.set_text_contents(node, prompt)` method. Otherwise, its native
input path owns the isolated X11 clipboard with foreground `xclip -quiet`, passes
UTF-8 through stdin (never argv), focuses the same unique composer with unbound
`Atspi.Component.grab_focus(node)`, verifies FOCUSED and emptiness again, and runs
only the fixed `xdotool key ctrl+v` command. It never types the
prompt as keystrokes or presses Enter.

Readback uses unbound `Atspi.Text.get_text(node, 0, -1)` to avoid the PyGObject
Accessible/Text binding collision. Send remains blocked until the complete text
matches the unchanged prompt, including Unicode and terminal line feeds. MST
releases its clipboard owner after readback or failure. Clipboard helper calls
have bounded timeouts, suppress stderr, and use no shell. There is no setter-to-
paste retry after an uncertain setter, repeated paste, approval handler, or
repeated Send.

When two New chat buttons are visible, the driver chooses the one with the nearest
shared ancestor container to the composer; an equal-depth tie fails closed.
Read-only snapshot traversal can restart at most twice on transient GLib errors;
partial trees never authorize actions. Actions are never retried.

Failed receipts retain `status: 'failed'` and an allowlisted `error` code. Unexpected
AttributeError, TypeError, and GLib.Error map to `desktop_attribute_error`,
`desktop_type_error`, and `desktop_glib_error`; other exceptions map to
`desktop_driver_failed`. Raw exception text is never returned. New input failures
are `helper_missing`, `helper_failed`, `helper_timeout`, `clipboard_unavailable`,
`focus_failed`, and `composer_not_empty`. Bounded composer diagnostics add the
boolean `textInterface` alongside `editableState` and `editableInterface`. Callers
that validate error codes or diagnostic fields must accept these additions.

These selectors, native input paths, and hierarchy rules have offline tests.
Chromium compatibility changes have not had a live Linux evaluation run. Verify
them against the caller's pinned image. A native fresh-session binding remains
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
