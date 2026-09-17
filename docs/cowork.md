# Cowork through the normal MST batch runner

This uses the existing Anthropic Computer Use driver and native Claude telemetry,
with PR #271's managed profile/MCP configuration and the V2 connection adapter.
It borrows interface separation and focused testing from #252, not its Cua runtime,
AXURL checks, clipboard input, approval rules, or strict evidence state machine.

## Run from a source checkout

```bash
COWORK_ENV_FILE=/absolute/path/to/existing.env ./scripts/run-cowork.sh
```

This prepares a local Python environment, builds MST, and runs a one-case READY
smoke test through `batch`. It submits a real Claude task. The invoking terminal
must have Accessibility and Screen Recording permission. Credentials remain in
the existing dotenv file or exported environment; the runner never rewrites or
shell-sources that file. Node loads dotenv before plugins/custom judges start.

Pass `--manifests /absolute/path/to/manifest.json` for a real MCP evaluation.
Use the normal file/GCS dataset sources and plugins. Scio keeps its existing thin
adapter and `batch` invocation. Its custom judges also need
`SCIO_MCP_PROMPTS_DIR` set to Scio's `data/prompts/templates` directory.
`--dry-run` checks configuration, not GUI execution or model behavior.

Use host `cowork` (`cowork_cu` remains an alias). `host.model` selects the Cowork
inference model; `host.options.computerUseModel` independently selects the planner.
The only supported provider is `anthropic`, and the driver selector is
`host.options.computerUseProvider: "anthropic-computer-use"`. See
[`configs/cowork-smoke.json`](../configs/cowork-smoke.json) for both model settings.

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

## Structure and behavior

- `coworkHost.ts`: batching, correlation, native collection, and trace conversion.
- `cowork/platform.ts`: small injectable platform interface and OS selection.
- `cowork/macos.ts`: wiring to the existing setup, recovery, and desktop functions.
- `coworkSetup/`: #271 profile settings, private header helpers, transactional restore.
- `scripts/cowork_computer_use.py`: unchanged screenshot navigation, executor-owned
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
Only the macOS desktop adapter is implemented; live macOS E2E is the release gate.
This does not claim native Windows/Linux Cowork support. Those adapters require separate work
and live qualification; there is no fallback to a different product.

Do not rerun an ambiguous submission blindly. Inspect native completion and retained
setup state. After confirming work has stopped, explicit guarded recovery is:

```bash
node --import tsx scripts/recover-cowork.ts --confirm
```

Never delete managed locks to force a retry. This is the existing managed desktop
workflow, not a sandbox or a transactional guarantee over arbitrary UI actions.
