# Cowork host

Selecting `host.type: "cowork"` automatically prepares Claude Desktop's managed MCP
configuration, runs cases through the selected driver, and restores the previous
configuration afterward. No manual setup command is required.

## Usage

Start with [the two-server example](../examples/cowork-setup/multi-server.manifest.json).
Replace its reserved `example.test` URLs with your MCP endpoints. After building MST:

```bash
node dist/cli/index.js run \
  --manifest examples/cowork-setup/multi-server.manifest.json \
  --root-dir examples/cowork-setup \
  --secrets-file /absolute/path/to/private.env
```

The host declaration uses the existing driver/capability system:

```json
{
  "type": "cowork",
  "driver": "anthropic.claude.cowork.desktop-app.macos"
}
```

Use `mode: "host"` (or `mcp_host`) for evaluation cases. Legacy `external_host`
cases cannot be mixed into a prepared-host arm because they bypass this lifecycle.
Direct MCP cases and `--dry-run` do not prepare or launch Cowork.

## Inputs and requirements

- **macOS only.** Other platforms fail with `Cowork on <os> is not supported yet.`
- Claude Desktop, Xcode Command Line Tools, and a visible GUI session are required.
  The embedded AppKit controller compiles once per process; it never force-kills
  the app or grants OS permissions.
- Only `~/Library/Application Support/Claude-3p/configLibrary` is supported.
  The originally applied profile must be empty, user-owned, and writable, with no
  conflicting managed preferences. Alternate profile paths are rejected.
- Declare canonical `servers` / `arms[].servers`, including an explicit `[]` for
  no external MCPs. Each server needs a unique label and an HTTPS URL (literal
  loopback HTTP is permitted for fixtures). Only HTTP transport with supported
  static headers or bearer credentials is implemented.
- Supply `ANTHROPIC_API_KEY` and the credentials referenced by `auth.accessTokenEnv`.
  MST resolves its normal environment / `--secrets-file`; Cowork consumes that
  runtime context without a second file parser or credential-store lookup.
  Token acquisition, refresh, and OAuth consent remain external to the run.
- Use `concurrency: 1`. One effective host configuration is reused across an arm's
  cases, iterations, and datasets. Mid-arm driver/configuration changes are
  rejected before execution; use separate arms instead.

## Optional write-tool preapproval

By default, existing Cowork approval behavior is unchanged. To preapprove all tools
on the configured MCP servers, add this top-level manifest option:

```json
"coworkSetup": { "approveWriteTools": true }
```

This emits per-server `toolPolicy: { "*": "allow" }`, covering present **and future
read/write tools**. It does not change built-in shell/filesystem permissions or
bypass authentication and organization restrictions. Arm settings inherit this
option; explicit `false` cancels a parent opt-in. Setup itself invokes no tools.

## Cleanup and limits

Credentials are staged in private, per-server files and delivered through helpers;
settings and diagnostics contain no token values. Profile ownership, symlink,
permission, and content checks protect installation/restoration. A lease prevents
competing runs from controlling the same app. Normal failures attempt rollback;
cleanup failures are surfaced instead of reported as success.

Hard termination or unexpected edits can retain `.mst-session-lock` and
`.mst-setup-lock` in the configuration library, plus private staging referenced by
their receipts. Preserve these for explicit recovery; do not delete locks to retry.
Automatic crash recovery and interactive repair tooling are not included.

Lifecycle tests use fake drivers/controllers and synthetic credentials. Earlier
manual setup testing is not proof of an end-to-end automatic evaluation. Existing
GUI-driver readiness issues, independent native inventory verification, and live
tool-policy verification remain limitations. Native tool provenance is preserved;
calls without source/server provenance fail evaluation rather than being inferred.

Implementation: `coworkHost.ts` adapts the registered driver; `coworkSetup/` owns
settings, private helpers, and the Mac transaction/session. The generic
`HostDefinition.prepareSession()` hook owns per-arm reuse and disposal.

Native reference: [managed MCP configuration](https://claude.com/docs/third-party/claude-desktop/configuration).
