// global-setup.ts
import {
  performOAuthSetupIfNeeded,
  type OAuthSetupConfig,
} from '@gleanwork/mcp-server-tester';

export default async function globalSetup() {
  const config: OAuthSetupConfig = {
    // OAuth server
    authServerUrl: 'https://auth.example.com',
    scopes: ['mcp:read', 'mcp:write'],
    redirectUri: 'http://localhost:3000/oauth/callback',

    // Login form selectors (customize for your IdP)
    loginSelectors: {
      usernameInput: '#username',
      passwordInput: '#password',
      submitButton: 'button[type="submit"]',
      // Optional: consent screen button
      consentButton: '#authorize-button',
    },

    // Test credentials
    credentials: {
      username: process.env.TEST_USERNAME!,
      password: process.env.TEST_PASSWORD!,
    },

    // Where to save tokens
    outputPath: 'playwright/.auth/mcp-oauth-state.json',

    // Optional: pre-registered client credentials
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,

    // Optional: resource indicator
    resource: 'https://api.example.com/mcp',

    // Browser options
    headless: true,
    timeout: 30000,
  };

  await performOAuthSetupIfNeeded(config);
}
