/**
 * Playwright fixtures for MCP OAuth authentication
 *
 * Provides worker-scoped OAuth authentication following Playwright's
 * recommended auth state pattern.
 */

import { test as base } from '@playwright/test';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import type { MCPAuthConfig } from '../config/mcpConfig.js';
import {
  BearerTokenAuthProvider,
  oauthStateProvider,
} from '../auth/credentials.js';
import { ENV_VAR_NAMES } from '../auth/storage.js';

/**
 * Static token auth provider that wraps a pre-acquired token
 *
 * This is a minimal implementation that provides tokens directly
 * without OAuth flow support.
 */
class StaticTokenAuthProvider extends BearerTokenAuthProvider {
  constructor(private readonly token: string) {
    super();
  }

  protected async accessToken(): Promise<string> {
    return this.token;
  }

  protected rejectedMessage(): string {
    return `The server rejected the token in ${ENV_VAR_NAMES.accessToken}. Update or unset it.`;
  }
}

/**
 * Test-scoped auth fixtures interface
 */
export interface MCPAuthFixtures {
  /**
   * OAuth client provider for MCP authentication
   */
  mcpAuthProvider: OAuthClientProvider | undefined;
}

/**
 * Extended Playwright test with MCP auth fixtures
 *
 * Use this when you need OAuth authentication for MCP server testing.
 *
 * @example
 * ```typescript
 * // test.ts
 * import { test } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';
 *
 * test('authenticated MCP call', async ({ mcpAuthProvider }) => {
 *   // mcpAuthProvider can be passed to createMCPClientForConfig
 * });
 * ```
 */
export const test = base.extend<MCPAuthFixtures>({
  /**
   * Create auth provider based on environment configuration
   */
  // eslint-disable-next-line no-empty-pattern
  mcpAuthProvider: async ({}, use) => {
    const authConfig = getAuthConfigFromEnv();

    if (!authConfig) {
      await use(undefined);
      return;
    }

    // OAuth mode (a state file wins over a token, as in resolveCredentials)
    if (authConfig.oauth) {
      const provider = oauthStateProvider(authConfig.oauth);
      await use(provider);
      return;
    }

    // Static token mode
    if (authConfig.accessToken) {
      const provider = new StaticTokenAuthProvider(authConfig.accessToken);
      await use(provider);
      return;
    }

    await use(undefined);
  },
});

/**
 * Gets auth config from environment variables
 *
 * This is a fallback for fixtures that can't access testInfo.project directly.
 * Same precedence as resolveCredentials: an OAuth state file before a token.
 */
function getAuthConfigFromEnv(): MCPAuthConfig | undefined {
  const oauthServerUrl = process.env.MCP_OAUTH_SERVER_URL;
  const authStatePath = process.env.MCP_AUTH_STATE_PATH;
  if (oauthServerUrl || authStatePath) {
    return {
      oauth: {
        serverUrl: oauthServerUrl ?? '',
        authStatePath: authStatePath,
        clientId: process.env.MCP_OAUTH_CLIENT_ID,
        clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
        scopes: process.env.MCP_OAUTH_SCOPES?.split(','),
        resource: process.env.MCP_OAUTH_RESOURCE,
      },
    };
  }

  const accessToken = process.env[ENV_VAR_NAMES.accessToken];
  if (accessToken) {
    return { accessToken };
  }

  return undefined;
}

/**
 * Re-export expect for convenience
 */
export { expect } from '@playwright/test';
