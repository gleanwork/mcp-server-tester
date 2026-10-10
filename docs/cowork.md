# Cowork in MST

Cowork is the `cowork` client. `mst run --config <eval.json>` runs an eval config
on it, as for any client, and `mst batch` runs several configs. A platform-specific
desktop driver submits each case, and MST builds each trace from Claude's own
session records. macOS uses managed application setup and Anthropic Computer Use.
Linux attaches to an externally prepared desktop and uses bounded AT-SPI actions;
it does not provision or authenticate that runtime.

## First-time macOS setup

Run this once on a new Mac before the first Cowork evaluation:

```bash
node --import tsx src/cli/index.ts cowork setup
```

For an installed package, use the package binary instead:

```bash
npx mst cowork setup
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

### Which Claude Desktop runs

By default, MST runs the installed `/Applications/Claude.app`, whatever its
version, and records that version with every case result as
`clientTelemetry.clientApp`:

```json
{ "name": "Claude Desktop", "version": "2.19675.1", "source": "installed" }
```

MST has no built-in version. To run an exact version instead, for example to
reproduce an earlier result or to keep a series of runs on one version, pin it
in the eval config:

```json
{
  "client": "cowork",
  "clientOptions": {
    "computerUseProvider": "anthropic-computer-use",
    "appVersion": "1.52386.6"
  }
}
```

With `appVersion`, MST downloads that release for the session. No app bundle or
administrator password is required. It resolves the exact version through
Anthropic's release service, downloads into a private temporary directory, and
checks the advertised size and SHA-256, Anthropic code signature, bundle ID, and
embedded version before launch. An unavailable version or failed check stops the
run; MST never falls back to the installed app or the latest release. The
recorded `source` is `pinned`. The earlier `MST_COWORK_APP_VERSION` environment
variable is rejected with a message pointing to `appVersion`.

Pinned or not, the version must not change during a run. MST requests disabled
app updates in its evaluation profile and rechecks the version before accepting
run completion; a changed bundle fails the run. Compare runs on the same
`clientApp.version`: a newer Claude Desktop can change results.

MST does not replace `/Applications/Claude.app` or write managed preferences.
It uses the existing signed-in `Claude-3p` profile. A managed configuration can
override profile settings. MST stops the app it ran, restores the original
profile and running app, and removes any download directory. Cleanup failures
retain the session receipt for `cowork recover`; recovery also removes a
downloaded app. A hard process crash during acquisition can leave the journaled
download until recovery. Do not run two Claude bundles simultaneously.

Claude's workspace disk-space check is separate from MCP authentication. Leave
headroom for Claude's VM/workspace setup, and for the download when pinning. A
successful connector preflight does not bypass a "Not enough disk space" error.
MST removes its own temporary bundle, bridge credentials, and settings on normal
teardown; it does not delete Claude's VM bundles, user workspaces, or caches to
free space. After an interrupted process, use explicit recovery before retrying.

Root-owned, non-writable managed preferences are accepted only when every key is
on the inference-only allowlist: inference routing, credential-helper and model
settings, and the deployment's display name. Managed MCP, plugin, updater,
unknown settings, and unsafe files still block setup. The plist is read, never
modified.

### Inference

Two separate model clients run during a macOS case:

- **Cowork's inference** (the model under test). By default, MST stages
  `ANTHROPIC_API_KEY` for the temporary profile through a private credential
  helper. When managed preferences set `inferenceProvider` (for example, an LLM
  gateway with its own credential helper), they take precedence over the
  profile: MST then requires no key, stages no inference credential, and sets no
  provider in the profile. If those managed preferences change during setup, the
  run fails closed.
- **The Computer Use planner** (`clientOptions.computerUseModel`). It uses MST's
  [LLM gateway settings](./llm-gateways.md): `ANTHROPIC_BASE_URL` with
  `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN`, else `ANTHROPIC_API_KEY`
  against the public API. The gateway must accept the Computer Use beta tool.

So on a Mac whose managed preferences route Claude Desktop through a gateway,
setting the gateway variables for the planner is enough; no API key is needed.

`MST_COWORK_APP_PATH=/absolute/path/to/Claude.app` runs an app installed
somewhere other than `/Applications`. MST neither downloads nor deletes
caller-owned bundles, and records their version too. Don't combine it with
`appVersion`. Linux provisioning is unchanged.

Running an app doesn't prove MCP availability. Managed inference configuration
can take precedence over a profile's MCP list. On macOS, MST now exposes declared
servers through Claude's supported local Developer MCP surface instead:

- HTTP declarations use a local stdio-to-HTTP bridge with the declared headers.
- Plain and private-file-backed stdio declarations run the caller's command,
  including vendor dry-run proxies. Plugin-root placeholders remain Linux-only.
- The temporary `claude_desktop_config.json` contains launcher paths, not tokens.
  Runtime credentials stay in private per-session files. Existing developer
  servers are replaced for isolation, then restored with the original file bytes.
- Cleanup tolerates Claude's JSON whitespace rewrite, but rejects semantic edits
  made concurrently. `cowork recover` also restores the developer configuration.

Use actual tool-call assertions: successful endpoint preflight alone is not proof
that the native session received a connector. A live pinned run has passed with
an eval-endpoint search tool and a login-backed GitHub `get_me` call.

## Run on macOS from a source checkout

```bash
COWORK_ENV_FILE=/absolute/path/to/existing.env ./scripts/run-cowork.sh --configs /absolute/path/to/eval.json
```

This prepares a local Python environment, builds MST, and runs the supplied
eval configs through `batch`. It submits real Claude tasks. The invoking terminal
must have Accessibility and Screen Recording permission. Credentials remain in
the existing dotenv file or exported environment; the runner never rewrites or
shell-sources that file. Node loads dotenv before plugins/custom judges start.

An explicit `--configs` or `--config-dir` is required; no default evaluation is
bundled. Use the normal file/GCS dataset sources and plugins. Configure custom
judges according to their plugin's requirements.
`--dry-run` checks configuration, not GUI execution or model behavior.

Use client `cowork`. The earlier names `cowork_cu` and `anthropic.claude.cowork.desktop-app.macos` fail validation, naming `cowork`. `model` selects the Cowork
inference model; `clientOptions.computerUseModel` independently selects the planner.
The inference provider is `anthropic`. On macOS the desktop driver selector is
`clientOptions.computerUseProvider: "anthropic-computer-use"`.

MST applies a fixed inference model list with discovery disabled. On macOS,
managed settings can override that profile. The submission driver therefore
selects and verifies the requested model in Cowork's visible model picker before
entering the prompt. If the exact model is unavailable or cannot be confirmed,
the case stops without submission; it never substitutes another model. Native
telemetry must still report the requested exact model ID; a mismatch or missing
model evidence fails the case. Omitting `model` preserves the existing
application default.
Configure `servers` with HTTP endpoints and literal or environment-backed bearer
credentials, or stdio commands with declared `env` values. Every macOS batch owns
one setup transaction, including an empty server set, which exposes no user-added
MCP servers. Stdio receives only its declared `env`; omitted `inheritEnv` behaves
like `false`, and `true` is rejected. Credentials are not inferred from arbitrary
environment variable names.

`coworkSetup.approveWriteTools` defaults to false. Mac Computer Use approves only
clearly read-only tools by default. Explicit opt-in stages local connector
defaults for the declared tool inventory before launch, using the same enabled
and content-fingerprint keys as the connector picker (live-verified on Claude
Desktop 1.52386.6 and 2.19675.1). If a later version stores them differently,
its approval prompts remain and cases fail or time out rather than pass.
Both bare `server:tool` and `local:server:tool` names are staged because the
renderer switches naming paths with `cowork_snapshot_sync`. Mac write
opt-in disables the approval-click fallback: staging must work without clicking
a pending approval. Managed wildcard policies do not cover these local
Developer MCP connections.
The existing third-party account-settings file must be unambiguous. The private
session journal restores the original permission entries during cleanup and
recovery; unrelated settings edits are preserved, and conflicting edits fail
closed. MCP config cleanup also preserves unrelated preference changes, such as
Claude's `epitaxyPrefs`, while refusing conflicting MCP edits. This does not grant
permanent permissions or change tool annotations.
Organization restrictions can still require approval. Keep vendor servers behind
the caller's dry-run proxy. Delayed native tool requests trigger at most three further
approval inspections within the original per-case action budget; prompts are
never resubmitted. Follow-up usage is recorded under
`clientTelemetry.computerUse.hitlFollowups`.

MST does not configure or observe connectors added from Cowork's own connector
directory, so disconnect any that could write to real accounts before a run, or
use test accounts.

## Run an installed release

```bash
node --env-file=/absolute/path/to/existing.env node_modules/@gleanwork/mcp-server-tester/dist/cli/index.js run --config /absolute/path/to/eval.json
```

For several eval configs, use `batch --configs <files...> --workers 1`.

The release bundles the CU script and pinned Python requirements. Resolution does
not depend on the caller's working directory or the location of its Python binary.
Without `MST_COWORK_PYTHON`, MST creates a private temporary Python environment,
installs the bundled requirements, reuses it within the process, and removes it
at process exit. This requires Python 3.10+, pip access, and macOS desktop permissions.
Set `MST_COWORK_PYTHON` to reuse a worker-prepared interpreter instead; MST never
modifies it. `MST_COWORK_DRIVER_ROOT` remains an explicit development override.
The source-checkout wrapper is a convenience, not required by `run` or `batch`.

## Install an unreleased source pin

A Git dependency must run the package's `prepare` lifecycle to generate `dist`.
Use an immutable Git commit and explicitly allow this package's build in your
package manager. `--ignore-scripts` is appropriate for prebuilt registry packages,
but leaves a Git source dependency without its CLI. No build tooling is required
when installing the normal published package.

## Attach to a prepared Linux desktop

Use `client: "cowork"` and `clientOptions.computerUseProvider: "linux-desktop"`
with `mst run` (or `batch`). `computerUseModel` is rejected for this backend:
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
approval policy disagree with the eval config. Other `policy-only` entries must
block all tools (`{"*": "blocked"}`). With client `plugins`,
`allowedPluginMarketplaces` must contain exactly one entry per plugin that
matches `coworkPluginMarketplace(plugin)`; without `plugins`, it must be absent
or empty. Stdio eval servers and blocked plugin servers follow the contract in
[Client plugins](#client-plugins). Native sessions default to
`$XDG_CONFIG_HOME/Claude-3p/local-agent-mode-sessions`, or
`$HOME/.config/Claude-3p/local-agent-mode-sessions`; `clientOptions.dataDir` overrides it.
Preparation is read-only. MST does not provision or authenticate the environment,
change its launch policy, or manage its lifecycle.

**Owned-desktop mode.** A worker image that runs several variants on one desktop
([ADR 0004](./adr/0004-environments-run-shards-over-a-channel.md)) sets
`MST_DESKTOP_OWNED=1`, makes the settings file writable by the desktop user, and
sets `MST_DESKTOP_RESTART` to the absolute path of a command that restarts Claude
Desktop and returns once it's back. For each variant, MST then writes the
variant's servers, plugins and model over the image's own settings, keeping the
image's other keys and the `headersHelper` of an HTTP server with the same name
and URL (MST writes no secrets there). It adds `AskUserQuestion` to the image's
`disabledBuiltinTools`, so the image needn't. It runs the restart command, checks the
file as above, and probes. When the variant ends, or if the desktop isn't ready,
the file goes back to what it was. Without `MST_DESKTOP_OWNED=1`, preparation
stays read-only.

**In an environment.** A plugin environment (`mst run --env <namespace>/env/<name>`)
can run Cowork shards on Linux workers in owned-desktop mode. Connector servers
and variants with tool metadata work there as they do locally: the worker
launches each connector with its own paths and gets its access token from the
coordinator, and runs the tool-variant proxy itself. The worker image must
install the plugins the eval loads, at the paths the eval config names. MST
ships no `docker` environment or desktop image yet; both are planned.

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
Built-in Cowork tools ignore managed MCP `toolPolicy` and confirm with an inline
card whose primary action names the write (`Create`/`Update` for artifacts;
`Schedule`/`Update`/`Run`/`Delete` for scheduled tasks) beside `Cancel`. The 3p
desktop offers no Skip all approvals mode, so under `approveWriteTools` HITL
approves that card; read-only runs refuse it. More than one candidate action
fails closed.

`clientTelemetry.computerUse` records `driver: "linux-desktop"`, observed semantic
actions, and elapsed time. Planner tokens and planner cost are **not applicable**,
not synthetic zero-usage Anthropic calls. Native usage and cost retain their own scope.

Installation and configuration checks do not establish end-to-end correctness.
Validate the prepared desktop with representative cases and audit their captured
native evidence.

## Audit a saved Linux native run

Use `auditCoworkNativeRun` from the experimental clients subpath, which may change
between minor versions. It is offline: it does not invoke the desktop, MCP servers,
or judges. No CLI or private parser import is required.

```typescript
import { auditCoworkNativeRun } from '@gleanwork/mcp-server-tester/experimental/clients';

const report = await auditCoworkNativeRun({
  rawResultsPath: '/archive/runs/20261007T182504Z-a3f9c1/results.json',
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

The input is a run's `results.json` in the `mst.run/v1` format, with the run's `summary.json` beside it.
Each case must have a unique ID and `clientTelemetry.nativeSessionId`. Retain this
archive layout, including the actual saved tool-output bytes:

```text
native/
  local_<UUID>/
    local_<UUID>.json
    audit.jsonl
    .claude/projects/<project>/<CLI UUID>.jsonl
    .claude/projects/<project>/<CLI UUID>/tool-results/<name>.txt
```

The audit uses MST's existing native parser and both client normalizers. It checks
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

- `desktopBatch.ts`: the batch lifecycle shared with the ChatGPT client: the desktop lease, per-case reset policy, native-session de-duplication, redaction, and cleanup.
- `coworkClient.ts`: Cowork's setup, one case (submit, bind, HITL, native collection), reset, and trace conversion.
- `cowork/platform.ts`: small injectable platform interface and OS selection.
- `cowork/macos.ts`: wiring to the existing setup, recovery, and desktop functions.
- `coworkSetup/`: profile/MCP settings, private header helpers, and guarded restore.
  Its `macController.ts` handles only application start/stop, not UI automation.
- `nativeHelper.ts`: builds and runs the macOS Swift controllers for Cowork and
  ChatGPT with one environment policy. The Cowork controller runs with only the
  system `PATH` and a private `TMPDIR`. The ChatGPT controller launches the app
  with the test environment; see [ChatGPT desktop](./chatgpt-desktop.md).
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
retried or resent. Each case is self-contained: after a submit, binding, HITL, or
trace failure, MST records that case's failure and resets the app before the next
case. On Linux the reset opens one empty new-task deep link and waits read-only
(about 10 seconds) for the Cowork start surface. On macOS, the Computer Use planner
stops a task that is still running and declines an open permission prompt, within
eight actions. The driver refuses typing, drags and key presses other than Escape
(a refused proposal does nothing, and the planner may try again within the
budget), and the planner is instructed never to click Send, approve, or answer a
question. If the planner can't conclude the app is idle, MST quits and relaunches
Claude Desktop instead, which stops whatever was running; the session's settings
and MCP servers stay installed. Only if that fails too is the reset a failure. The next case takes its own
session snapshot, so a late session from the failed case cannot be attributed to
it. If the reset fails, the remaining cases are not submitted, and the same
happens after three failed cases in a row: a reset can succeed and still leave a
desktop that every case fails on. Per-case snapshots distinguish
repeated identical prompts. Use a dedicated desktop: do not manually create or
switch tasks during evaluation.

On macOS the driver acts only while Claude is the frontmost app. A click that
misses Claude's window (on the desktop, say) brings another app forward; before
every click, key or scroll, the driver checks, and if another app is in front it
brings Claude back, skips the action and has the planner take a new screenshot.
If Claude can't be brought back, the case stops with `navigation_blocked` and
nothing more is sent. A planner request that can't reach the API (a short network
drop) is sent again after 2, 4, 8 and 16 seconds, on top of the SDK's own two
quick retries: it has no effect on the desktop. If the API stays unreachable,
the case fails with `provider_unavailable`; the driver log names the error's
classes, such as `APIConnectionError <- ConnectError`. Timeouts aren't
retried. MST discards the driver's own log; set
`MST_COWORK_CUA_LOG_FILE` to a path to keep it. The log holds action and app
names, never the query.

Claude Code replaces a large tool result in its transcript with a
`<persisted-output>` placeholder and saves the result to a file, which the model
reads. MST reads that file back while it collects the trial, so the trace (and
any judge) sees the full result, up to 1 MB. A server writes the placeholder's
text and can know the call's `tool_use_id`, so MST reads only a regular file
whose real path is named for that id, in a `tool-results` directory, inside
Claude Desktop's private temporary directory (on macOS, the MST helper's
`mst-cowork-native-*`) or the session's directory; never another path a
placeholder names. The evidence audit replays the transcript without these
files, and accepts a stored result that starts with the placeholder's preview.
A second form Claude Code uses for oversized results (`Output has been saved
to …/tool-results/mcp-<server>-<tool>-<time>.txt`) isn't read back yet.

Results include `clientUsage`, `clientTelemetry`, and `telemetry.totalClientUsage`.
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

One run drives a desktop at a time. MST claims it with a lease file,
`~/.mcp-server-tester/cowork-desktop-<id>.lock`, where `<id>` identifies the
desktop by its native data directory. A second run on the same desktop, even in
another process, refuses to share it; runs on separate desktops (for example,
several Linux displays) don't block each other. If cleanup or restoration fails, MST prints why,
every case result in that batch says so (an infrastructure failure, since the
desktop's state is unknown), and the lease is kept, so later batches stop until
you have inspected the desktop and removed the file. In a run with several
variants, those batches' trials are recorded as infrastructure failures that
name the lease, and the run's results are still written. An interrupted run
leaves the lease behind in the same way. If a case fails unexpectedly mid-batch,
the cases before it keep their results and the rest are recorded as not submitted.

## Client plugins

The config has two independent parts:

- `clientOptions.plugins[]` installs plugins (their skills). On Cowork, a plugin can
  also block its own MCP servers with `blockMcpServers`.
- `servers` is the MCP servers under test, keyed by label. Both plain stdio and
  client-resolved stdio entries are supported on macOS and Linux, alongside HTTP.
  A client-resolved entry can launch a native proxy with private credential files
  or, on Linux, resolve a file from a declared plugin.

```json
{
  "client": "cowork",
  "clientOptions": {
    "computerUseProvider": "linux-desktop",
    "pluginRoots": {
      "acme": "/opt/example-app/plugins/acme"
    },
    "mcpDataRoot": "/config/mcp-data",
    "plugins": [
      {
        "name": "acme",
        "marketplace": {
          "source": "acme/claude-plugins",
          "ref": "<40-character commit SHA>"
        },
        "blockMcpServers": ["acme_plugin"]
      }
    ]
  },
  "servers": {
    "acme-eval": {
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": ["${pluginRoot:acme}/mcp/start.mjs"],
      "url": "https://mcp.example.com/eval",
      "auth": {
        "accessTokenEnv": "ACME_API_TOKEN"
      },
      "minTools": 4,
      "env": {
        "ACME_MCP_SERVER_URL": "${url}",
        "CLAUDE_PLUGIN_DATA": "${dataDir}",
        "ENABLE_HITL": "false"
      },
      "files": {
        "mcp-credentials.json": {
          "tokens": {
            "access_token": "${bearerToken}",
            "token_type": "Bearer"
          }
        }
      }
    }
  }
}
```

### Stdio eval servers

Cowork accepts plain stdio `servers` entries without a URL, plugin, or proxy:

```json
{
  "servers": {
    "local-tools": {
      "transport": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["server.mjs"],
      "cwd": "/opt/mcp/local-tools",
      "env": { "NODE_ENV": "test" },
      "inheritEnv": false
    }
  }
}
```

Use paths that exist on the desktop client. `command` is required;
`args`, `env`, and `cwd` are optional, and the key (`local-tools`) is the
server's label. `cwd` must resolve to an absolute
path. Desktop has no `cwd` field, so MST converts it to a fixed `/bin/sh` wrapper
with cwd, command, and arguments passed as separate argv values, never
interpolated into shell source. `inheritEnv: true` is unsupported: declare all
required server environment variables in `env`. Omitting `inheritEnv` has the
same Cowork behavior as `false`.

Client-resolved entries can also set `url`, `auth.accessTokenEnv`, `files`, and
`minTools` (default 1). The readiness client accepts `connectTimeoutMs`,
`requestTimeoutMs`, `callTimeoutMs`, and `quiet`; these are not Desktop settings.
Unknown keys fail; Cowork does not currently accept the general MCP client's
`protocol` or `probe` options. Supported placeholders are:

- `${url}`: the declared `url`; allowed in command, args, env, cwd, and files.
- `${dataDir}`: the private per-server directory; allowed in command, args,
  env, cwd, and files. On Linux it is `<clientOptions.mcpDataRoot>/<label>`; on macOS
  it is `<transaction staging directory>/stdio/<label>`.
- `${pluginRoot:<plugin>}`: `clientOptions.pluginRoots[<plugin>]` on Linux; allowed
  in command, args, env, cwd, and files. `<plugin>` must be a declared plugin.
- `${bearerToken}`: the value of `auth.accessTokenEnv`; allowed only in files.

Any other `${...}` fails. If `url` is declared, include `${url}` in the launch
command, args, or env, not only in files or cwd. `requireEvalEndpoint` checks
that declared endpoint; MST does not invent an endpoint for plain stdio.
Resolved bearer tokens stay in private files, not settings, env, args, logs, or
receipts. Tool calls appear as `mcp__<label>__<tool>` and are attributed to
`label` (for example, `mcp__acme-eval__search`).

Both macOS (`anthropic-computer-use`) and Linux (`linux-desktop`) support these
stdio forms. The package-root export `COWORK_STDIO_PLATFORMS` is
`['darwin', 'linux']`. On macOS, `${pluginRoot:...}` is rejected because
marketplace installation paths are unknown before Desktop starts. This is not
a native-proxy requirement: use a known local command or adapter path instead.
For the Linux example above, a Mac config must omit `pluginRoots` and
`mcpDataRoot`, select the Mac provider, and replace the plugin-root argument
with a known local adapter path. The private files and URL/env substitutions
remain supported, including in mixed HTTP/stdio server sets.

ChatGPT Work/Codex and direct MCP clients support plain stdio, but not Cowork's
client-resolved fields. For ChatGPT plugin overrides, use `plugins[].mcp` as
described in [chatgpt-desktop.md](chatgpt-desktop.md#linux-runtime-contract).

MST's transport does not make a server read-only. Native-proxy write
interception is a client/catalog policy responsibility, not a stdio guarantee.

### Dry-run proxy

To let a client use a real HTTP MCP server without writing to it, put MST's
dry-run proxy in front of it. The proxy is a stdio MCP server. The client sees
the upstream server's real tools. Read-only tool calls go upstream. Every
other tool call returns a planned-write result and never reaches the server:

```json
{
  "_mst_planned_write": {
    "server": "slack",
    "tool_name": "send_message",
    "arguments": {}
  }
}
```

It fails closed. A tool is read-only only when it is annotated
`readOnlyHint: true` and not `destructiveHint: true`. A tool without
annotations, or one the server does not list, is a write. `readOnlyTools`
allows reads on a server that annotates nothing; `alwaysWriteTools` intercepts
tools annotated as reads.

`dryRunProxyServer()` (from `@gleanwork/mcp-server-tester/evals`) returns the
stdio server entry. It holds the path of a token file, never a token:

```ts
import { dryRunProxyServer } from '@gleanwork/mcp-server-tester/evals';

const slack = dryRunProxyServer({
  label: 'slack',
  upstreamUrl: 'https://mcp.slack.com/mcp',
  tokenFile: '/private/run/slack.json', // { "version": 1, "accessToken": "..." }
  minTools: 10,
});
```

The proxy re-reads the token file when it is replaced, so a renewed token
takes effect on the next request without restarting the MCP session. After a
401 it waits up to 90 seconds for a new token, then retries once. If none
arrives, it logs `CONNECTOR_AUTH_EXPIRED` to stderr. It never logs a token.

#### Simulated writes

A planned-write result tells the client its write didn't happen, and a model
that knows that may retry, apologize or answer differently. To grade it as it
behaves after a real write, set `"simulateWrites": true` in the eval config.
The proxy then answers a write with a success reply. It still never forwards
the write, and it records it. The reply, in order of preference:

1. The connector's template for the tool (`simulateWrites.replies`).
2. A minimal object that satisfies the tool's `outputSchema`, as structured
   content, when it declares one.
3. `{ "ok": true, "id": "<id>", "result": <the call's arguments> }`.

In a template, a string that is exactly `{{arguments.<path>}}` becomes that
argument's value; inside a longer string, its text. `{{id}}` is a fresh ID for
the call, `{{now}}` the time (ISO 8601) and `{{unixTime}}` seconds with
microseconds, as in Slack's `ts`:

```ts
const slack = dryRunProxyServer({
  label: 'slack',
  upstreamUrl: 'https://mcp.slack.com/mcp',
  tokenFile,
  // From the connector's launch context; absent without simulateWrites.
  ...(simulateWrites && {
    simulateWrites: {
      ...simulateWrites,
      replies: {
        slack_send_message: {
          ok: true,
          channel: '{{arguments.channel_id}}',
          ts: '{{unixTime}}',
          message: { text: '{{arguments.message}}' },
        },
      },
    },
  }),
});
```

With the flag, MST passes each connector's `launch` a private file,
`simulateWrites.file`, for its proxy to record writes in: one JSONL line per
write (`mst.simulated-write/v1`: server, tool, arguments, reply). A connector
whose launch doesn't pass it on keeps planned-write results, and the run says
so. After each trial, MST marks the trial's tool calls the proxy answered
(same server, tool and arguments) `simulatedWrite: true`, in its trace events
and in the client response's `events` and `toolCalls`, so judges and reports
know the write never happened; `output` is the reply.
The files are deleted when the run ends. A write the proxy can't record gets
the planned-write result instead.

The model can't read back what it "wrote": a search for the message it sent
won't find it.

### macOS setup contract

MST validates the full server set before changing the app or profile. HTTP,
plain stdio, and private-file-backed proxies all use the local Developer MCP
surface, not the managed profile's MCP list. Even an empty eval config temporarily
replaces the user's local MCP list. The profile transaction owns inference
settings and private stdio files: directories use mode 0700 and JSON files use
mode 0600. Credentials are resolved from the supplied runtime environment, not
embedded in the eval config or public app configuration.

Setup returns transaction-owned `stdioPaths`, which the shared readiness check
uses after installation. Do not supply Linux-only `pluginRoots` or
`mcpDataRoot` options on macOS. Setup status remains `applied-not-verified`:
installing settings or starting the app does not prove Desktop adopted the MCP
inventory or tool policy.

Cleanup restores the original local MCP configuration before removing private
stdio files. The private-file transaction validates inventory, ownership,
permissions, and content hashes during cleanup and explicit recovery; it removes
only recorded files and empty directories. Unexpected or changed state fails
closed and retains recovery state. Do not delete locks or modify staged
credential files to force cleanup.

### Linux managed-settings contract

The caller stages each plugin from its pinned ref, writes the private files,
and writes `/etc/claude-desktop/managed-settings.json` before it starts Claude
Desktop. MST only reads and checks them. For the example above:

```json
{
  "managedMcpServers": [
    {
      "name": "acme-eval",
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": ["/opt/example-app/plugins/acme/mcp/start.mjs"],
      "env": {
        "ACME_MCP_SERVER_URL": "https://mcp.example.com/eval",
        "CLAUDE_PLUGIN_DATA": "/config/mcp-data/acme-eval",
        "ENABLE_HITL": "false"
      }
    },
    {
      "name": "acme_plugin",
      "transport": "policy-only",
      "toolPolicy": { "*": "blocked" }
    }
  ],
  "allowedMcpServers": [{ "serverName": "acme-eval" }],
  "allowManagedMcpServersOnly": true,
  "disabledBuiltinTools": ["AskUserQuestion"],
  "allowedPluginMarketplaces": [
    {
      "source": "github",
      "repo": "acme/claude-plugins",
      "ref": "<40-character commit SHA>",
      "installationPreference": "required"
    }
  ]
}
```

And one private file, owned by the desktop-session user that runs MST and
Claude Desktop:

```text
/config/mcp-data/                                   0700
/config/mcp-data/acme-eval/                        0700
/config/mcp-data/acme-eval/mcp-credentials.json    0600
  {"tokens":{"access_token":"<ACME_API_TOKEN>","token_type":"Bearer"}}
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
  own server name from its `.mcp.json` (for example, `acme_plugin`).
- HTTP servers match as before, `allowManagedMcpServersOnly` is `true`, and the
  pinned marketplace entries match.
- `disabledBuiltinTools` contains `AskUserQuestion`
  (`coworkHeadlessSettings()` builds it). A headless run has nobody to answer a
  clarifying question, so Claude proceeds on its best assumption instead. Other
  disabled tools are allowed. If a desktop still asks, the task stops as a
  verified failed case (`clientTelemetry.awaitingUser`) instead of waiting.
  The macOS eval profile MST writes sets the same key.
- Each plugin root is an absolute, real (no symlink), non-world-writable
  directory. `mcpDataRoot` and each `<mcpDataRoot>/<label>` are real 0700
  directories owned by MST's user. Each `files` entry is a regular 0600 file
  owned by MST's user, with exactly the substituted JSON (the token from
  `auth.accessTokenEnv` in MST's environment).

Build the expected entries with `coworkManagedPluginSettings({servers, plugins,
paths: {pluginRoots, dataRoot}})` and check a file with `coworkMcpSettingsMatch`.
Both are exported from the package root and never include a token. Append HTTP
entries as before. `materializeClientStdioFiles` writes the private files for TS
callers.

### Readiness

Before the first prompt, MST launches each stdio eval server itself, with the
same resolved command, args, env, and data dir (when used), but without the parent
environment. On macOS it uses the paths returned by the setup transaction; on
Linux it uses the caller-owned paths checked during prepare. Every server, stdio
or HTTP, must connect and list at least one tool (the same rule as the ChatGPT
client). It fails closed with `too few tools (<n> < <minTools>)` when the server
lists fewer than `minTools` tools. For example, an adapter with a bad
token may list only its static tools. Desktop-side readiness (for example, a
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

- Client-bridged plugin stdio servers get only the plugin's declared `env` and
  `CLAUDE_PLUGIN_ROOT`. Placeholders expand only from `HOME`, `LOGNAME`, `PATH`,
  `SHELL`, `TERM`, and `USER`. `${CLAUDE_PLUGIN_DATA}` is left unexpanded, and
  a server that uses `${user_config.*}` is dropped.
- `orgPluginSettings` sets only per-tool permissions. A `managedMcpServers`
  entry with the same name decides only the tool policy.
- The desktop starts local plugin servers only when `allowedPluginMcpServers`
  is unset and local MCP is enabled. Local MCP is enabled when
  `isLocalDevMcpEnabled` is not false and the organization feature flag allows
  it. `allowManagedMcpServersOnly` is not an input to that check.

So declare the eval server as a stdio `servers` entry that runs the plugin's
adapter, and block the plugin's own server with `blockMcpServers`.
