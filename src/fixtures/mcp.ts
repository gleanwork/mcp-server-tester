import { test as base } from '@playwright/test';
import { expect } from '../assertions/matchers/index.js';
import type { Client } from '@modelcontextprotocol/client';
import type { ProtocolSetting } from '../types/index.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import {
  createMCPFixture,
  type MCPFixtureApi,
  type AuthType,
} from '../mcp/fixtures/mcpFixture.js';
import { resolveCredentials } from '../auth/credentials.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { installPlugins } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Internal fixture state for passing auth type between fixtures
 */
interface MCPFixtureState {
  /**
   * The resolved authentication type (may differ from config if CLI tokens are used)
   */
  resolvedAuthType: AuthType;
}

/**
 * Extended test fixtures for MCP testing
 */
type MCPFixtures = {
  /**
   * Protocol override for this project or file, used by the `mcp` and
   * `mcpClient` fixtures instead of `mcpConfig.protocol`. Set with
   * `test.use({ mcpProtocol: '2026-07-28' })` or in a project's `use` block.
   * Code that builds its own client from `mcpConfig` does not see it;
   * `protocolMatrix()` sets both. See {@link ProtocolSetting}.
   */
  mcpProtocol: ProtocolSetting | undefined;

  /**
   * Plugins whose extensions this project's tests use, for example a
   * judge referenced as `toPassToolJudge({ judge: 'acme/judge/completeness' })`.
   * Set with `test.use({ mcpPlugins: [acme] })` or in a project's `use` block.
   */
  mcpPlugins: readonly Plugin[];

  /**
   * Raw MCP client instance (automatically connected and cleaned up)
   */
  mcpClient: Client;

  /**
   * High-level MCP API for tests
   */
  mcp: MCPFixtureApi;

  /**
   * Internal fixture state (not for external use)
   */
  _mcpFixtureState: MCPFixtureState;
};

/**
 * Extended Playwright test with MCP fixtures
 *
 * @example
 * import { test, expect } from '@gleanwork/mcp-server-tester';
 *
 * test('lists tools from MCP server', async ({ mcp }) => {
 *   const tools = await mcp.listTools();
 *   expect(tools.length).toBeGreaterThan(0);
 * });
 */
export const test = base.extend<MCPFixtures>({
  mcpProtocol: [undefined, { option: true }],
  mcpPlugins: [[], { option: true }],

  /**
   * Internal fixture state - tracks resolved auth type between fixtures
   */
  _mcpFixtureState: [
    async ({ mcpPlugins }, use) => {
      installPlugins(mcpPlugins);
      // Initialize with 'none', will be updated by mcpClient fixture
      const state: MCPFixtureState = { resolvedAuthType: 'none' };
      await use(state);
    },
    { scope: 'test' },
  ],

  /**
   * mcpClient fixture: Creates and connects an MCP client
   *
   * The client configuration is read from the project's `use.mcpConfig`
   * setting in playwright.config.ts
   *
   * Authentication resolution order:
   * 1. Explicit authStatePath → uses PlaywrightOAuthClientProvider
   * 2. Explicit accessToken → uses static Bearer token
   * 3. HTTP transport with no auth → tries CLI-stored tokens (from `mst login`)
   *    with automatic token refresh
   */
  mcpClient: async ({ _mcpFixtureState, mcpProtocol }, use, testInfo) => {
    // Extract mcpConfig from project use settings
    const useConfig = testInfo.project.use as { mcpConfig?: MCPConfig };
    const mcpConfig = useConfig.mcpConfig;

    if (!mcpConfig) {
      throw new Error(
        `Missing mcpConfig in project.use for project "${testInfo.project.name}". ` +
          `Please add mcpConfig to your project configuration in playwright.config.ts`
      );
    }

    // One place decides the credentials: see resolveCredentials().
    const credentials = await resolveCredentials(mcpConfig);
    _mcpFixtureState.resolvedAuthType = credentials.authType;

    // Create and connect client
    const client = await createMCPClientForConfig(mcpConfig, {
      clientInfo: {
        name: '@gleanwork/mcp-server-tester',
        version: packageJson.version,
      },
      authProvider: credentials.authProvider,
      ...(mcpProtocol !== undefined ? { protocol: mcpProtocol } : {}),
    });

    try {
      // Provide client to test
      await use(client);
    } finally {
      // Cleanup: close the client
      await closeMCPClient(client);
    }
  },

  /**
   * mcp fixture: High-level test API built on mcpClient
   *
   * Depends on mcpClient fixture
   * Automatically tracks all MCP operations for the reporter
   */
  mcp: async ({ mcpClient, _mcpFixtureState }, use, testInfo) => {
    const useConfig = testInfo.project.use as { mcpConfig?: MCPConfig };
    const api = createMCPFixture(mcpClient, testInfo, {
      authType: _mcpFixtureState.resolvedAuthType,
      project: testInfo.project.name,
      callTimeoutMs: useConfig.mcpConfig?.callTimeoutMs,
    });
    await use(api);
  },
});

/**
 * Re-export extended expect with MCP tool matchers
 *
 * @example
 * ```typescript
 * expect(result).toContainToolText('temperature');
 * expect(result).toMatchToolSchema(WeatherSchema);
 * expect(result).not.toBeToolError();
 * ```
 */
export { expect };
