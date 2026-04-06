// global-setup.ts
import { performOAuthSetup } from '@gleanwork/mcp-server-tester';

export default async function globalSetup() {
  await performOAuthSetup({
    authServerUrl: 'https://auth.example.com',
    scopes: ['mcp:read', 'mcp:write'],
    outputPath: 'playwright/.auth/mcp-oauth-state.json',
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,

    customLoginFlow: async (page) => {
      // The page is already at the OAuth authorization URL.
      // Automate your IdP's login UI — handle multi-step flows, MFA, etc.
      await page.fill('#username', process.env.TEST_USERNAME!);
      await page.click('#continue');

      // Second page: password
      await page.fill('#password', process.env.TEST_PASSWORD!);
      await page.click('#submit');

      // Handle MFA if present
      if (await page.isVisible('#mfa-input')) {
        await page.fill('#mfa-input', process.env.TEST_MFA_CODE!);
        await page.click('#verify-mfa');
      }

      // Handle consent screen if present
      if (await page.isVisible('#consent-form')) {
        await page.click('#authorize-button');
      }

      // Done — performOAuthSetup waits for the redirect,
      // extracts the authorization code, exchanges it for tokens,
      // and saves the auth state to outputPath.
    },
  });
}
