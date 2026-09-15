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

For a direct command-line run, use the short `cowork_cu` driver alias:

```json
{
  "driver": "cowork_cu",
  "scenario": "Reply with exactly: acknowledged.",
  "timeoutMs": 120000,
  "options": {
    "computerUseProvider": "anthropic-computer-use"
  }
}
```

Run it with:

```bash
python3 -m pip install anthropic pyautogui mss Pillow
export ANTHROPIC_API_KEY="..."
npm run build
node dist/cli/index.js run --config cowork.json --output cowork-result.json
```

The command exits `0` only when every query succeeds. Use `queries` instead of `scenario` to run multiple queries sequentially.

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
- the built-in `anthropic-computer-use` provider, or a registered MST Computer Use provider;
- no running Claude process when a custom lifecycle capability requests a fresh environment;
- serialized Cowork eval execution, with no manual Claude launch during a run.

The driver launches Claude, resolves the configured Computer Use provider, and submits one query through a bounded screenshot/action loop. The default `anthropic-computer-use` path uses the Anthropic Computer Use API with `pyautogui` and `mss`; it stops immediately after the first Enter/Return. MST then owns native session correlation, terminal validation, response extraction, tool calls, usage, cost, and trace telemetry. The submission checkpoint is at-most-once, and no failed model action may trigger a second query submission.

MST ships an `anthropic-computer-use` submission provider for the first runnable Mac path, plus `native-macos` and `global-cua` provider adapters. Other CUA implementations can register the same provider contract:

```ts
import { registerMacComputerUseProvider } from '@gleanwork/mcp-server-tester';

registerMacComputerUseProvider({
  id: 'my-cua',
  getApp: async (appName) => myCua.getApp(appName),
});
```

Select it in the Cowork binding with `computerUseProvider: "my-cua"`. The provider must return an app exposing `getAXStateAndScreenshot`, `click`, `setValue`, and `pressKey`; the Cowork state machine and evidence rules are provider-independent.

For the default screenshot/action provider, install its optional Python dependencies first:

```bash
python3 -m pip install anthropic pyautogui mss Pillow
```

Then run the integration command with an Anthropic API key:

```bash
ANTHROPIC_API_KEY=... npm run test:external-host:cowork
```

For another provider, load an ESM plugin without changing MST:

```bash
MST_MAC_CUA_PLUGIN=/absolute/path/my-cua-plugin.mjs \
MST_MAC_CUA_PROVIDER=my-cua \
npm run test:external-host:cowork
```

The plugin may default-export the provider, export `provider`, or export `createProvider()`.

Cowork profile isolation is not available through the built-in driver. In the tested Claude Desktop build, redirecting `CLAUDE_CONFIG_DIR` made Cowork session creation/correlation unreliable. Full Electron profile isolation uses `CLAUDE_USER_DATA_DIR`, which packaged Claude accepts only with Anthropic's signed E2E authorization. Cowork also does not load arbitrary local MCP servers from `.claude.json`.

### Manually provisioned MCP server E2E

Cowork supports three MCP deployment paths:

- a remote custom connector reachable from Anthropic's cloud;
- a plugin-bundled MCP server that runs inside Cowork's Linux sandbox;
- a desktop extension (`.mcpb`) that runs on the host computer.

A plain Claude Desktop or Claude Code `mcpServers` entry is not available to Cowork. For a host-local E2E test, use an MCPB.

This repository includes an opt-in, manually provisioned opaque-nonce fixture whose assertion cannot pass unless Cowork calls the MCP tool. Packaging and the eval command are automated; Claude's install confirmation, task permission selection, and extension removal are explicit prerequisites. The driver also requires a CUA-enabled host that initializes `globalThis.cua.getApp("Claude")`; a normal Node/Vitest process without that runtime fails fast with a clear runtime-unavailable error.

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
