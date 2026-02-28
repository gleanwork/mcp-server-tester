import { test as base } from '@playwright/test';
import { expect } from '../assertions/matchers/index.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import {
  createMCPFixture,
  type MCPFixtureApi,
  type AuthType,
} from '../mcp/fixtures/mcpFixture.js';
import { PlaywrightOAuthClientProvider } from '../auth/oauthClientProvider.js';
import { CLIOAuthClient } from '../auth/cli.js';
import { isHttpConfig, type MCPConfig } from '../config/mcpConfig.js';
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
  /**
   * Internal fixture state - tracks resolved auth type between fixtures
   */
  _mcpFixtureState: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
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
   * 3. HTTP transport with no auth → tries CLI-stored tokens (from `mcp-server-tester login`)
   *    with automatic token refresh
   */
  mcpClient: async ({ _mcpFixtureState }, use, testInfo) => {
    // Extract mcpConfig from project use settings
    const useConfig = testInfo.project.use as { mcpConfig?: MCPConfig };
    const mcpConfig = useConfig.mcpConfig;

    if (!mcpConfig) {
      throw new Error(
        `Missing mcpConfig in project.use for project "${testInfo.project.name}". ` +
          `Please add mcpConfig to your project configuration in playwright.config.ts`
      );
    }

    // Track resolved auth type
    let resolvedAuthType: AuthType = 'none';

    // Narrow to HTTP config once for all auth-related logic (auth is HTTP-only)
    const httpConfig = isHttpConfig(mcpConfig) ? mcpConfig : null;

    // Create auth provider if OAuth authStatePath is configured
    let authProvider: OAuthClientProvider | undefined;
    if (httpConfig?.auth?.oauth?.authStatePath) {
      authProvider = new PlaywrightOAuthClientProvider({
        storagePath: httpConfig.auth.oauth.authStatePath,
        redirectUri:
          httpConfig.auth.oauth.redirectUri ??
          'http://localhost:3000/oauth/callback',
        clientId: httpConfig.auth.oauth.clientId,
        clientSecret: httpConfig.auth.oauth.clientSecret,
      });
      resolvedAuthType = 'oauth';
    }

    // Build effective config - may add CLI tokens if no auth is configured
    let effectiveConfig = mcpConfig;

    // Check for explicit static API token
    if (httpConfig?.auth?.accessToken) {
      resolvedAuthType = 'api-token';
    }

    // If HTTP transport with no explicit auth, try to use CLI-stored tokens
    // This enables the simple flow: `mcp-server-tester login <url>` then run tests
    if (
      httpConfig &&
      !httpConfig.auth?.accessToken &&
      !httpConfig.auth?.oauth?.authStatePath
    ) {
      const cliClient = new CLIOAuthClient({
        mcpServerUrl: httpConfig.serverUrl,
      });

      // Try to get a valid token (will refresh if expired)
      const tokenResult = await cliClient.tryGetAccessToken();

      if (tokenResult) {
        // Use the CLI token as static auth
        effectiveConfig = {
          ...httpConfig,
          auth: {
            ...httpConfig.auth,
            accessToken: tokenResult.accessToken,
          },
        };
        // CLI tokens come from OAuth flow
        resolvedAuthType = 'oauth';
      }
    }

    // Store resolved auth type for mcp fixture
    _mcpFixtureState.resolvedAuthType = resolvedAuthType;

    // Create and connect client
    const client = await createMCPClientForConfig(effectiveConfig, {
      clientInfo: {
        name: '@gleanwork/mcp-server-tester',
        version: packageJson.version,
      },
      authProvider,
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
