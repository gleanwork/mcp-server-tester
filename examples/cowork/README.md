# Cowork nonce example (experimental, macOS only)

This is one manual-user test of a **preinstalled, read-only MCPB tool** through
Claude Cowork. The source path is `createCoworkHost` → `hostTraceToExecution` →
`runEvalDataset`. Only the canonical runner scores the expected text, one actual
MCP tool call, and its server provenance. The controller receives no expected
nonce. Do not substitute `runEvalSuite`: its ambient environment expansion is
not supported by this provisioned-app host.

## Build and prepare (offline)

Use Node 22+ and the repository's existing dependencies. From the repository root:

```bash
npm run build
node node_modules/typescript/bin/tsc -p examples/cowork/tsconfig.json
node --test build/cowork/offline.test.js
node build/cowork/cli.js prepare /absolute/private/parent/cowork-test-001
```

The parent directory must exist. The setup directory must not exist. `prepare`
creates a private directory with `fixture.mcpb`, `evaluator.json`, and `run.json`.
It packages the checked-in [fixture sources](../../tests/fixtures/cowork-mcpb/)
with macOS `/usr/bin/zip -X`, using explicit filenames in a private temporary
directory that is removed after packaging, including on failure. Each bundle gets
a fresh 256-bit random nonce. The tool response is deterministic for that bundle.
The private evaluator binds the nonce to the bundle's SHA-256 checksum. Temporary
directories use mode `0700`; fixture files and the archive use mode `0600`.
The fixture has no package dependencies. Neither fixture nor builder uses
credentials or makes network/model calls. No additional dependency is needed.

The nonce exists in the bundle and private evaluator file, not in the prompt,
tool description, run config, or controller input. Do not attach these files to
the Cowork task or give it filesystem access to this checkout/setup directory.
The offline smoke test extracts the archive with macOS `/usr/bin/unzip` and
starts only the local fixture server. It does not start Cua or Claude.

## Manual setup and run

1. Use a dedicated test account and an exclusive graphical session. Disable
   unrelated tools/connectors. A live `run` submits a real Claude task and can
   incur model charges; the offline commands above do not.
2. Build the [pinned, patched Cua runtime](./runtime-patch.md). Stock Cua 0.28.0
   lacks required AXURL and clipboard-preserving paste support. Grant macOS
   Accessibility and Screen Recording permissions yourself.
3. In Claude Desktop, manually install `fixture.mcpb` as a local extension and
   approve its read-only `get_eval_nonce` tool. Do not run the tool to reveal the
   answer. Confirm that a fresh Cowork task inherits **Automatically approve**.
   The example never installs extensions, grants consent, or changes approvals.
4. Edit the generated `run.json`. Replace all `REPLACE_ME` values: the absolute
   patched runtime path; the absolute native `local-agent-mode-sessions`
   directory; the installed fixture's actual Node command and absolute script
   path; and its verified native `mcp__<namespace>__` prefix. Copy these from your
   installed extension configuration/native metadata, not from a guessed title.
   Keep the canonical label `nonce-fixture`. This fixture needs no environment,
   auth, or overrides; this small config deliberately rejects them. Do not strip
   fields from a different server's config to make it fit.
5. **Quit Claude completely yourself.** The host refuses any preexisting Claude
   process. Then run once:

```bash
node build/cowork/cli.js check /absolute/private/parent/cowork-test-001/run.json
node build/cowork/cli.js run /absolute/private/parent/cowork-test-001/run.json
```

`check` validates JSON, the bundle checksum, and unused paths offline. It does
**not** verify installation, native prefixes, approvals, or runtime capability.
`run` uses one case and concurrency 1. It requires the full submitted prompt and
correlation marker in native metadata, audit, and transcript. Final text alone
cannot pass: the native trace must contain exactly one fixture MCP tool call and
no unexpected calls. The command reports counts, not the nonce.

## Results, retained workers, and cleanup

- `results/results.json` is the canonical `runEvalDataset` result. The private
  side channels are `results/diagnostics.json`, `results/lifecycle.json`, and
  `results/run-error.json` when a top-level error occurs. Files use exclusive
  creation, mode `0600`, and file/directory sync; directories use mode `0700`.
- Before the sole submit attempt, `armed.json` is durably written beside
  `evaluator.json` and inside `results/`. Any existing output directory or
  fixture-side armed receipt blocks another run, even with a new output path.
  A receipt means submission **may** have happened, not that it succeeded.
- If `record.quarantined` is true, the example does **not** call `cua.close()`.
  If close refuses pending/indeterminate RPCs, it preserves the result and
  diagnostics, records the close error separately, and retains the runtime.
  A referenced timer keeps this JS worker alive even if stdio disconnects.
- On a retained worker, do not press Ctrl-C, terminate the child, retry, or start
  another evaluation. Inspect the receipt's PID/marker and native session files
  manually. Reconcile submission, app ownership, and pending native/clipboard
  operations first. If native work may still be running, leave the worker alive.
  There is no force-close or retry API. Only after you establish that native work
  has stopped and state is safe may you manually quit the app and stop the worker.
- After a clean run or completed manual reconciliation, manually uninstall
  **MCP Server Tester E2E**, restore your previous approval mode/connectors, and
  quit Claude. Retain needed private evidence, then delete only this generated
  setup directory. Use a fresh bundle/directory for any new test; never delete
  an armed receipt to bypass the guard. Build output is disposable `build/cowork/`.

This is not unattended provisioning, a sandbox, profile isolation, or a
cross-process desktop lock. Windows, Linux, remote workers, CI GUI execution,
usage/cost accounting, and changing native formats are not qualified. The
AppKit paste transaction cannot provide an interprocess atomic compare-and-swap
or safely cancel a blocked native provider. Do not use the desktop or clipboard
concurrently. Offline checks do not qualify a live runtime/app pair.
