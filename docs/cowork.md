# Cowork through the normal MST batch runner

Cowork runs through MST's normal `batch` command with a platform-specific desktop
driver and shared native Claude trace collection. macOS uses managed application
setup and Anthropic Computer Use. Linux attaches to an externally prepared desktop
and uses bounded AT-SPI actions; it does not provision or authenticate that runtime.

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
bundled. Use the normal file/GCS dataset sources and plugins. Scio keeps its existing thin
adapter and `batch` invocation. Its custom judges also need
`SCIO_MCP_PROMPTS_DIR` set to Scio's `data/prompts/templates` directory.
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
The source-checkout wrapper is a convenience, not required by Scio or `batch`.

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

The caller must prepare an authenticated Claude Desktop session with X11, D-Bus,
AT-SPI (system Python `gi`), genuine nested KVM, and the desired model/MCP settings.
Run MST in that same filesystem and desktop-session context, not in a detached host
shell with different native paths. `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` are
required. `MST_COWORK_PYTHON` can select a prepared system interpreter; MST does not
install Linux desktop dependencies. The packaged `cowork-linux-runtime` export
resolves the Python driver independently of the working directory.

The driver reads `/etc/claude-desktop/managed-settings.json` (or the absolute
`MST_COWORK_SETTINGS_FILE`) and fails if its model, HTTP MCP servers, or wildcard
approval policy disagree with the manifest. Native sessions default to
`$XDG_CONFIG_HOME/Claude-3p/local-agent-mode-sessions`, or
`$HOME/.config/Claude-3p/local-agent-mode-sessions`; `options.dataDir` overrides it.
Preparation is read-only. Disposal does not stop the app, container, or VM. The
caller owns authentication, resource cleanup, host-wide exclusion, and recovery.

Submission uses the native deep link to prefill the unchanged prompt, then attempts
one semantic `Start task` action. There is no keyboard fallback or retry after an
uncertain action. The shared native collector still requires a new exact-prompt
session. HITL only operates on approval controls while that bound session is pending;
it never types, creates tasks, or continues onboarding. Unclassified approval prompts
fail closed unless `coworkSetup.approveWriteTools` explicitly permits approval.

`hostTelemetry.computerUse` records `driver: "linux-desktop"`, observed semantic
actions, and elapsed time. Planner tokens and planner cost are **not applicable**,
not synthetic zero-usage Anthropic calls. Native usage and cost retain their own scope.

Linux qualification requires an authenticated two-case run plus failure/cleanup
checks in the deployment environment. Installation or `desktop-app verify` alone is
not that gate. This branch's fresh-profile VM probe reached the sign-in screen;
there is no claim of authenticated Linux end-to-end qualification yet.

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
30 seconds after submission and pins collection to it. Missing or ambiguous
binding stops further submissions without retrying. Per-case snapshots distinguish
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
