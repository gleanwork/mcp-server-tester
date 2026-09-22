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

Each query re-verifies the selected surface, requires a visible, enabled,
AT-SPI-editable composer (not generic text), selects New chat once, verifies the
empty composer, fills the exact prompt, reads it back, and activates Send once.
When two New chat buttons are visible, the driver chooses the one with the nearest
shared ancestor container to the composer; an equal-depth tie fails closed.
There is no keyboard fallback, approval handler, or repeated send.

These selectors and hierarchy rules have offline tests. The implementation has
not had a live Linux evaluation run. In particular, editable-text support and the
New chat ancestry rule must be checked against the caller's pinned image. A native
fresh-session binding remains mandatory even after a successful UI receipt.

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
