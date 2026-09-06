# External host evaluations

External-host mode drives a real host application and maps its observed result back into the same eval model used by MCP Server Tester.

```json
{
  "id": "cowork-answer",
  "mode": "external_host",
  "scenario": "Reply with exactly: acknowledged.",
  "externalHost": {
    "driver": "anthropic.claude.cowork.desktop-app.macos",
    "timeoutMs": 120000,
    "options": {
      "newConversationShortcut": "none"
    }
  },
  "expect": {
    "containsText": "acknowledged"
  }
}
```

## Lifecycle

Every external-host capability can implement three hooks:

- `setup`: snapshot or provision state before any input is sent;
- `run`: control the host, collect evidence, or normalize the result;
- `teardown`: release state after success or failure.

Teardown hooks run in reverse capability order. Use them for processes, temporary profiles, proxy servers, and test artifacts.

The built-in macOS app lifecycle:

1. detects whether the target app is already running;
2. refuses to apply an isolated environment to an existing process;
3. launches through LaunchServices so Electron does not inherit test-runner output handles;
4. records the exact process IDs started by the run;
5. terminates only those process IDs, with a bounded force-quit fallback.

## Claude Cowork

The built-in Cowork driver requires:

- macOS;
- Claude Desktop installed and signed in;
- Automation and Accessibility permission for the process running the tests;
- no running Claude process when a custom lifecycle capability requests a fresh environment;
- serialized Cowork eval execution, with no manual Claude launch during a run.

The driver launches Claude, waits for a real window and hydrated navigation, selects the current **Home** Cowork surface, focuses and verifies the Cowork composer semantically, submits the marked prompt, restores the previous clipboard content, and correlates the result with Claude's local-agent trace.

Cowork profile isolation is not available through the built-in driver. In the tested Claude Desktop build, redirecting `CLAUDE_CONFIG_DIR` made Cowork session creation/correlation unreliable. Full Electron profile isolation uses `CLAUDE_USER_DATA_DIR`, which packaged Claude accepts only with Anthropic's signed E2E authorization. Cowork also does not load arbitrary local MCP servers from `.claude.json`.

### Manually provisioned MCP server E2E

Cowork supports three MCP deployment paths:

- a remote custom connector reachable from Anthropic's cloud;
- a plugin-bundled MCP server that runs inside Cowork's Linux sandbox;
- a desktop extension (`.mcpb`) that runs on the host computer.

A plain Claude Desktop or Claude Code `mcpServers` entry is not available to Cowork. For a host-local E2E test, use an MCPB.

This repository includes an opt-in, manually provisioned opaque-nonce fixture whose assertion cannot pass unless Cowork calls the MCP tool. Packaging and the eval command are automated; Claude's install confirmation, task permission selection, and extension removal are explicit prerequisites because the open-source core does not include a Computer Use backend.

```bash
npx @anthropic-ai/mcpb pack \
  tests/fixtures/cowork-mcpb \
  .cache/mcp-server-tester-e2e.mcpb
open .cache/mcp-server-tester-e2e.mcpb
```

Install the extension through Claude's normal confirmation UI, then set Cowork's task permission mode to **Automatically approve**. Run:

```bash
MCP_SERVER_TESTER_COWORK_MCPB_E2E=1 \
  npm run test:external-host:cowork
```

Remove the extension through Claude Desktop after the test. MCPB installation and the permission selector are intentionally not implemented as hidden file mutations.

## Custom capabilities

A project can register a capability directly or load one from a module:

```json
{
  "capabilities": {
    "control": {
      "uses": "module:file:///absolute/path/driver.mjs#default",
      "provides": ["input", "completion", "trace", "normalize"]
    }
  }
}
```

A module exports an `ExternalHostCapabilityImplementation`. This is the correct location for organization-specific Computer Use drivers, account setup, connector configuration, or proprietary host APIs. Core remains usable without those systems.
