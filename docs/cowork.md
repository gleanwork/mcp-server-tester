# Cowork through the normal MST batch runner

Cowork runs through MST's normal `batch` command with a platform-specific desktop
driver and shared native Claude trace collection. macOS uses managed application
setup and Anthropic Computer Use. Linux attaches to an externally prepared desktop
and uses bounded AT-SPI actions; it does not provision or authenticate that runtime.

## First-time macOS setup

Run this once on a new Mac before the first Cowork evaluation:

```bash
node --import tsx src/cli/index.ts cowork setup
```

For an installed package, use the package binary instead:

```bash
mcp-server-tester cowork setup
```

The command creates the minimal empty Claude 3P profile only when the profile
library is missing. It never overwrites an existing profile. After it completes,
launch Claude Desktop, sign in through the normal user-controlled flow, open one
normal conversation, and quit Claude Desktop. The next `batch` run manages a
temporary Cowork profile and restores the empty base profile afterward.

If the profile already exists but is not empty, setup stops without changing it.
Use a dedicated Claude Desktop user/profile or contact the MST owner; do not
manually edit `configLibrary` files.

The batch preflight reports this setup command immediately when the profile is
missing. It does not wait for a case timeout.

## Run on macOS from a source checkout

```bash
COWORK_ENV_FILE=/absolute/path/to/existing.env ./scripts/run-cowork.sh --manifests /absolute/path/to/manifest.json
```

This prepares a local Python environment, builds MST, and runs the supplied
evaluation through `batch`. It submits real Claude tasks. The invoking terminal
must have Accessibility and Screen Recording permission. Credentials remain in
the existing dotenv file or exported environment; the runner never rewrites or
shell-sources that file. Node loads dotenv before plugins/custom judges start.

An explicit `--manifests` or `--manifest-dir` is required; no default evaluation is
bundled. Use the normal file/GCS dataset sources and plugins. Configure custom
judges according to their plugin's requirements.
`--dry-run` checks configuration, not GUI execution or model behavior.

Use host `cowork` (`cowork_cu` remains an alias). `host.model` selects the Cowork
inference model; `host.options.computerUseModel` independently selects the planner.
The inference provider is `anthropic`. On macOS the desktop driver selector is
`host.options.computerUseProvider: "anthropic-computer-use"`.

MST applies a fixed inference model list with discovery disabled. Native telemetry
must report the requested exact model ID; a mismatch or missing model evidence
fails the case. Omitting `host.model` preserves the existing application default.
Configure `servers` with HTTP endpoints and literal or environment-backed bearer
credentials. A nonempty server set or explicit inference model invokes the managed
setup transaction once per batch. An empty server set with an explicit model still
replaces the MCP configuration with an empty set. `coworkSetup.approveWriteTools` defaults to false; setting
it to true explicitly applies #271's server-scoped wildcard allow policy, including
write tools. Do not enable it for servers/tasks you have not authorized.

## Run an installed release

```bash
node --env-file=/absolute/path/to/existing.env node_modules/@gleanwork/mcp-server-tester/dist/cli/index.js batch --manifests /absolute/path/to/manifest.json --workers 1
```

The release bundles the CU script and pinned Python requirements. Resolution does
not depend on the caller's working directory or the location of its Python binary.
Without `MST_COWORK_PYTHON`, MST creates a private temporary Python environment,
installs the bundled requirements, reuses it within the process, and removes it
at process exit. This requires Python 3.10+, pip access, and macOS desktop permissions.
Set `MST_COWORK_PYTHON` to reuse a worker-prepared interpreter instead; MST never
modifies it. `MST_COWORK_DRIVER_ROOT` remains an explicit development override.
The source-checkout wrapper is a convenience, not required by `batch`.

## Install an unreleased source pin

A Git dependency must run the package's `prepare` lifecycle to generate `dist`.
Use an immutable Git commit and explicitly allow this package's build in your
package manager. `--ignore-scripts` is appropriate for prebuilt registry packages,
but leaves a Git source dependency without its CLI. No build tooling is required
when installing the normal published package.

## Attach to a prepared Linux desktop

Use `host.type: "cowork"` and `host.options.computerUseProvider: "linux-desktop"`
with the normal `batch` command. `computerUseModel` is rejected for this backend:
there is no LLM desktop planner. If omitted, the driver defaults to the native
backend for the current OS. Cross-platform provider combinations fail before UI
activity rather than silently selecting another driver.

The caller supplies a working Claude Desktop session with the desired model/MCP
settings. MST accesses that session through X11, D-Bus, and AT-SPI (Python `gi`).
Run MST in the prepared desktop's filesystem and session context. `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` are
required. `MST_COWORK_PYTHON` can select a prepared system interpreter; MST does not
install Linux desktop dependencies. The packaged `cowork-linux-runtime` export
resolves the Python driver independently of the working directory.

The driver reads `/etc/claude-desktop/managed-settings.json` (or the absolute
`MST_COWORK_SETTINGS_FILE`) and fails if its model, MCP servers, or wildcard
approval policy disagree with the manifest. Other `policy-only` entries must
block all tools (`{"*": "blocked"}`). With host `plugins`,
`allowedPluginMarketplaces` must contain exactly one entry per plugin that
matches `coworkPluginMarketplace(plugin)`; without `plugins`, it must be absent
or empty. Stdio eval servers and blocked plugin servers follow the contract in
[Host plugins](#host-plugins). Native sessions default to
`$XDG_CONFIG_HOME/Claude-3p/local-agent-mode-sessions`, or
`$HOME/.config/Claude-3p/local-agent-mode-sessions`; `options.dataDir` overrides it.
Preparation is read-only. MST does not provision or authenticate the environment,
change its launch policy, or manage its lifecycle.

Submission opens the native deep link through the prepared environment's `xdg-open`
handler, then attempts one semantic `Start task` action. Alternatively, set
`MST_COWORK_URL_OPENER` to an absolute executable path that accepts the URL as its
sole argument. The caller owns protocol registration and application launch flags;
MST does not select an application binary or sandbox policy. The prompt is preserved
unchanged, and the opener runs without a shell and with a bounded deadline. There is no keyboard fallback or retry after an
uncertain action. The shared native collector still requires a new exact-prompt
session. HITL only operates on approval controls while that bound session is pending;
it never types, creates tasks, or continues onboarding. Unclassified approval prompts
fail closed unless `coworkSetup.approveWriteTools` explicitly permits approval.

`hostTelemetry.computerUse` records `driver: "linux-desktop"`, observed semantic
actions, and elapsed time. Planner tokens and planner cost are **not applicable**,
not synthetic zero-usage Anthropic calls. Native usage and cost retain their own scope.

Installation and configuration checks do not establish end-to-end correctness.
Validate the prepared desktop with representative cases and audit their captured
native evidence.

## Audit a saved Linux native run

Use the supported package-root API. It is offline: it does not invoke the desktop,
MCP servers, or judges. No CLI or private parser import is required.

```typescript
import { auditCoworkNativeRun } from '@gleanwork/mcp-server-tester';

const report = await auditCoworkNativeRun({
  rawResultsPath: '/archive/results/raw-results.json',
  nativeRoot: '/archive/native',
  expectedCases: 2,
  expectedModel: 'claude-opus-4-6', // optional exact native model assertion
});

if (!report.evidencePassed) {
  console.error(
    report.issues,
    report.cases.map(({ id, issues }) => ({ id, issues }))
  );
}
```

The input is MST schema-v1 `raw-results.json`, including `results` and `arms`.
Each case must have a unique ID and `hostTelemetry.nativeSessionId`. Retain this
archive layout, including the actual saved tool-output bytes:

```text
native/
  local_<UUID>/
    local_<UUID>.json
    audit.jsonl
    .claude/projects/<project>/<CLI UUID>.jsonl
    .claude/projects/<project>/<CLI UUID>/tool-results/<name>.txt
```

The audit uses MST's existing native parser and both host normalizers. It checks
exact case count, unique case/session identities, exact initial prompt, final
response, ordered normalized events and tool calls (arguments, output, IDs and
provenance), usage/cache/cost, native/API durations, completion/nonerror flags,
parsed audit and transcript, no parser warnings, and native-derived telemetry in
both saved envelopes. Only live `computerUse` and `hitlWarning` fields are excluded
from telemetry equality. An expected model must match the single observed native
model. Models must use the recognized Claude opus/sonnet/haiku version-ID format.

`Output has been saved to ...` notices require nonempty real `.txt` files. Recorded
absolute paths are never read directly: only the same `local_<UUID>` session's
`.claude/projects/<project>/<CLI UUID>/tool-results/*.txt` suffix can resolve below
`nativeRoot`. Traversal, encoded paths, foreign sessions and symlinks fail closed.
Attachment records contain tool-call indexes, byte sizes and SHA-256 hashes, never
paths or contents. A saved notice alone is not complete evidence.

`CoworkNativeAuditReport` is exported from the package root:

- `schemaVersion: 1`, `expectedCases`, `observedCases`, `issues` (fixed codes).
- `qualityPassed: boolean | null` reflects saved case `pass` values. A failed judge
  does **not** fail evidence. `null` means missing/unknown quality, not success.
- `evidencePassed: boolean`; `status: 'verified' | 'failed'` describes evidence only.
- `cases[]`: `id`, `pass`, `sessionId`, `model`, `usage`, `timing`, `toolCounts`,
  `validity`, `attachments`, `evidencePassed`, `issues`. Validity includes
  `auditParsed`, `transcriptParsed`, `complete`, `nonError`, `hasUsage`, `hasCost`,
  and `noWarnings`. Unknown fields stay `null`, not zero.
- `totals`: `null` unless the entire evidence audit passes. Otherwise native-only
  token/cache/cost/duration sums plus `costScope: 'native-inference-only'`. Unknown
  cache fields stay `null`. This excludes controller and judge cost/time.

Reports never include prompts, answers, tool arguments/results, native paths,
parser error messages, server URLs, or credentials. Numeric `e2e-<digits>` and
`case-<digits>` IDs are retained; other case IDs use SHA-256 pseudonyms. Invalid
session/model identifiers are not echoed. Errors use fixed issue codes.

Bounds: 1–1,000 expected cases, 32 MiB raw results, 16 MiB per native file,
64 MiB per session, 4,096 directory entries per session, depth 12, and 1,024 output
notices per case. The parser reads a private temporary snapshot of the two bounded
trace files, which is removed after parsing. User-controlled symlinks are rejected
(including roots and trace paths); fixed macOS `/tmp` and `/var` system aliases are
allowed. Audit a quiescent archive under trusted filesystem ownership: portable
Node path checks cannot eliminate hostile concurrent directory-replacement races.
A verified report establishes internal consistency, not cryptographic authenticity
or independent verification of the saved judge result. Attachment hashes describe
the bytes present at audit time; notices contain no original digest to authenticate.

## Structure and behavior

- `coworkHost.ts`: batching, correlation, native collection, and trace conversion.
- `cowork/platform.ts`: small injectable platform interface and OS selection.
- `cowork/macos.ts`: wiring to the existing setup, recovery, and desktop functions.
- `coworkSetup/`: profile/MCP settings, private header helpers, and guarded restore.
  Its `macController.ts` handles only application start/stop, not UI automation.
- `cowork/driver.ts`: shared receipts, error classifications, and scoped telemetry.
- `cowork/linux.ts`: readiness checks and execution against a caller-owned desktop.
- `scripts/cowork_linux.py`: bounded semantic UI actions; no lifecycle or answer parsing.
- `cowork/anthropicComputerUse.ts`: the macOS CU driver entry point and process limits.
- `scripts/cowork_computer_use.py`: bounded screenshot navigation, executor-owned
  query insertion, one submit boundary, and bounded first-option HITL handling.

Cases run sequentially: snapshot, submit, bind, HITL, then native collection.
Already-complete native tasks skip unnecessary HITL navigation. An exhausted inspection budget is
recorded as a warning: passing still requires native completion and the normal
assertions/judges. Other HITL errors remain failures. Native paths support
both legacy session folders and the current short-ID/cwd-root layout. Native tool
server names are retained; built-in tools are not attributed to the tested server.

The executor inserts the dataset query unchanged. No marker, prefix, or suffix is
added. Correlation requires exact native `initialMessage` equality, a metadata path
absent from the per-case snapshot, and a recent creation timestamp (five seconds
of clock tolerance). Existing sessions remain excluded even if updated. Answers
and tool output are never prompt matches. MST binds the unique new session within
30 seconds after submission and pins collection to it. A failed case is never
retried or resent. On Linux, each case is self-contained: after a submit, binding,
HITL, or trace failure, MST records that case's failure, opens one empty new-task
deep link, waits read-only (up to 60 seconds) for the Cowork start surface, and
continues. The next case takes its own session snapshot, so a late session from
the failed case cannot be attributed to it. If that reset fails, the remaining
cases are not submitted. macOS has no reset yet; there, a submit or binding
failure stops further submissions. Per-case snapshots distinguish
repeated identical prompts. Use a dedicated desktop: do not manually create or
switch tasks during evaluation.

Results include `hostUsage`, `hostTelemetry`, and `telemetry.totalHostUsage`.
These describe native Claude execution, not the separate Computer Use planner's
API cost. A test assertion or judge failure is distinct from a driver failure.

The shared orchestration is OS-neutral and tested with injected platform doubles.
macOS is live-qualified. Linux has separate qualification requirements described
above. Windows is unsupported; there is no fallback to a different product.

Do not rerun an ambiguous submission blindly. Inspect native completion and retained
setup state. After confirming work has stopped, explicit guarded recovery is:

```bash
node --import tsx scripts/recover-cowork.ts --confirm
```

Never delete managed locks to force a retry. This is the existing managed desktop
workflow, not a sandbox or a transactional guarantee over arbitrary UI actions.

## Host plugins

The config has two independent parts:

- `host.plugins[]` installs plugins (their skills). On Cowork, a plugin can
  also block its own MCP servers with `blockMcpServers`.
- `servers[]` is the MCP server set under test. A stdio entry with `url` is a
  host-resolved eval server. It can launch a file from a plugin.

```json
{
  "host": {
    "type": "cowork",
    "options": {
      "computerUseProvider": "linux-desktop",
      "pluginRoots": { "glean": "/opt/scio/app/plugins/glean/plugins/glean" },
      "mcpDataRoot": "/config/.scio-mcp-data"
    },
    "plugins": [
      {
        "name": "glean",
        "marketplace": {
          "source": "gleanwork/claude-plugins",
          "ref": "<40-character commit SHA>"
        },
        "blockMcpServers": ["glean_plugin"]
      }
    ]
  },
  "servers": [
    {
      "transport": "stdio",
      "label": "glean-eval",
      "command": "/usr/bin/node",
      "args": ["${pluginRoot:glean}/mcp/start.mjs"],
      "url": "https://scio-prod-be.glean.com/mcp/default/eval",
      "auth": { "accessTokenEnv": "GLEAN_API_TOKEN" },
      "minTools": 4,
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
  ]
}
```

### Stdio eval servers

A stdio `servers[]` entry with `url` has these fields: `label`, `command`,
`args`, `env`, `url`, `auth.accessTokenEnv`, `minTools` (default 1), and
`files`. Unknown keys, including `cwd`, fail. Placeholders:

| Placeholder              | Allowed in                | Linux Cowork value                 |
| ------------------------ | ------------------------- | ---------------------------------- |
| `${url}`                 | command, args, env, files | `url`                              |
| `${dataDir}`             | command, args, env, files | `<options.mcpDataRoot>/<label>`    |
| `${pluginRoot:<plugin>}` | command, args, env, files | `options.pluginRoots[<plugin>]`    |
| `${bearerToken}`         | `files` only              | the value of `auth.accessTokenEnv` |

Any other `${...}` fails. `${url}` must appear in `args` or `env`, so the
checked launch proves the endpoint. `<plugin>` must be a declared plugin. A
token never appears in settings, env, args, logs, or receipts; it is only in
`files`. `url` is the eval endpoint: `requireEvalEndpoint` checks it, and it is
recorded in the manifest. Tool calls appear as `mcp__<label>__<tool>` and are
attributed to `label` (for example, `mcp__glean-eval__search`).

Only Linux Cowork (`linux-desktop`) supports stdio eval servers. The macOS
driver, ChatGPT, and direct MCP clients reject them before any UI action or
process launch. On ChatGPT, use `plugins[].mcp` instead. A stdio server without
`url` is still rejected on Cowork.

### Linux managed-settings contract

The caller stages each plugin from its pinned ref, writes the private files,
and writes `/etc/claude-desktop/managed-settings.json` before it starts Claude
Desktop. MST only reads and checks them. For the example above:

```json
{
  "managedMcpServers": [
    {
      "name": "glean-eval",
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": ["/opt/scio/app/plugins/glean/plugins/glean/mcp/start.mjs"],
      "env": {
        "GLEAN_MCP_SERVER_URL": "https://scio-prod-be.glean.com/mcp/default/eval",
        "CLAUDE_PLUGIN_DATA": "/config/.scio-mcp-data/glean-eval",
        "ENABLE_HITL": "false"
      }
    },
    {
      "name": "glean_plugin",
      "transport": "policy-only",
      "toolPolicy": { "*": "blocked" }
    }
  ],
  "allowedMcpServers": [{ "serverName": "glean-eval" }],
  "allowManagedMcpServersOnly": true,
  "allowedPluginMarketplaces": [
    {
      "source": "github",
      "repo": "gleanwork/claude-plugins",
      "ref": "<40-character commit SHA>",
      "installationPreference": "required"
    }
  ]
}
```

And one private file, owned by the desktop-session user that runs MST and
Claude Desktop:

```text
/config/.scio-mcp-data/                                   0700
/config/.scio-mcp-data/glean-eval/                        0700
/config/.scio-mcp-data/glean-eval/mcp-credentials.json    0600
  {"tokens":{"access_token":"<GLEAN_API_TOKEN>","token_type":"Bearer"}}
```

`prepare` fails closed, before any UI action, unless all of these hold:

- Each stdio eval server is one managed entry named `label` with exactly
  `transport: "stdio"`, the resolved `command`, `args`, and `env`. It has no
  other keys, except `toolPolicy: {"*": "allow"}` with
  `coworkSetup.approveWriteTools`. Its `env` has exactly the declared keys, so
  the substituted URL equals `url`, and plugin env such as `ENABLE_HITL: "true"`
  is replaced. Its `label` is in `allowedMcpServers`.
- Each `blockMcpServers` name is a `policy-only` entry with exactly
  `toolPolicy: {"*": "blocked"}`. Claude Desktop names plugin tools
  `mcp__plugin_<plugin>_<server>__<tool>`; the managed entry uses the plugin's
  own server name from its `.mcp.json` (for example, `glean_plugin`).
- HTTP servers match as before, `allowManagedMcpServersOnly` is `true`, and the
  pinned marketplace entries match.
- Each plugin root is an absolute, real (no symlink), non-world-writable
  directory. `mcpDataRoot` and each `<mcpDataRoot>/<label>` are real 0700
  directories owned by MST's user. Each `files` entry is a regular 0600 file
  owned by MST's user, with exactly the substituted JSON (the token from
  `auth.accessTokenEnv` in MST's environment).

Build the expected entries with `coworkManagedPluginSettings({servers, plugins,
paths: {pluginRoots, dataRoot}})` and check a file with `coworkMcpSettingsMatch`.
Both are exported from the package root and never include a token. Append HTTP
entries as before. `materializeHostStdioFiles` writes the private files for TS
callers.

### Readiness

Before the first prompt, MST launches each stdio eval server itself, with the
same resolved command, args, env, and data dir, but without the parent
environment. It fails closed with `too few tools (<n> < <minTools>)` when the
server lists fewer than `minTools` tools. For example, a Glean adapter with a
bad token lists only its static tools. Desktop-side readiness (for example, a
caller's own log check) should also compare each server's `toolCount` with
`minTools`.

### Plugin marketplaces

Cowork installs each plugin from a managed `allowedPluginMarketplaces` entry,
pinned and required. An `owner/repo` source becomes `source: "github"`; an HTTPS
Git URL becomes `source: "git"` with `url`. Local paths are rejected, because
Cowork cannot read them. On macOS, MST writes these entries and the blocked
`policy-only` entries into the MST-owned profile. On Linux, the caller writes
them, and MST checks them before any UI action. Extra keys such as
`expectedName` are allowed.

### Why not `plugins[].mcp` on Cowork

Cowork rejects `plugins[].mcp` overrides with `plugin_unsupported` before any UI
action. Claude Desktop 2.7032.0 has no managed way to give a plugin's own MCP
server a custom endpoint, credential, or data directory:

- Host-bridged plugin stdio servers get only the plugin's declared `env` and
  `CLAUDE_PLUGIN_ROOT`. Placeholders expand only from `HOME`, `LOGNAME`, `PATH`,
  `SHELL`, `TERM`, and `USER`. `${CLAUDE_PLUGIN_DATA}` is left unexpanded, and
  a server that uses `${user_config.*}` is dropped.
- `orgPluginSettings` sets only per-tool permissions. A `managedMcpServers`
  entry with the same name decides only the tool policy.
- The desktop starts local plugin servers only when `allowedPluginMcpServers`
  is unset and local MCP is enabled. Local MCP is enabled when
  `isLocalDevMcpEnabled` is not false and the organization feature flag allows
  it. `allowManagedMcpServersOnly` is not an input to that check.

So declare the eval server as a stdio `servers[]` entry that runs the plugin's
adapter, and block the plugin's own server with `blockMcpServers`.
