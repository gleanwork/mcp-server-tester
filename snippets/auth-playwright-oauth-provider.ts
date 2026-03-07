import { chromium } from '@playwright/test';
import { PlaywrightOAuthClientProvider } from '@gleanwork/mcp-server-tester';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export default async function globalSetup() {
  const provider = new PlaywrightOAuthClientProvider({
    storagePath: 'playwright/.auth/mcp-oauth-state.json',
    redirectUri: 'http://localhost:3000/oauth/callback',
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Automate your IdP's login UI to acquire OAuth tokens.
  // The provider handles PKCE, state management, token exchange, and storage.
  await page.goto('https://auth.example.com/login');
  await page.fill('#username', process.env.TEST_USERNAME!);
  await page.fill('#password', process.env.TEST_PASSWORD!);
  await page.click('#submit-button');

  if (await page.isVisible('#mfa-input')) {
    await page.fill('#mfa-input', process.env.TEST_MFA_CODE!);
    await page.click('#verify-mfa');
  }

  if (await page.isVisible('#consent-form')) {
    await page.click('#authorize-button');
  }

  await browser.close();

  // Use the provider as the authProvider for StreamableHTTPClientTransport
  const serverUrl = new URL('https://api.example.com/mcp');
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: provider,
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  await client.close();
}
