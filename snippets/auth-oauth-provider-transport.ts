import { PlaywrightOAuthClientProvider } from '@gleanwork/mcp-server-tester';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Create provider for MCP SDK
const provider = new PlaywrightOAuthClientProvider({
  storagePath: 'playwright/.auth/mcp-oauth-state.json',
  redirectUri: 'http://localhost:3000/oauth/callback',
  clientId: process.env.MCP_OAUTH_CLIENT_ID,
  clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
});

// Use with StreamableHTTPClientTransport
const serverUrl = new URL('https://api.example.com/mcp');
const transport = new StreamableHTTPClientTransport(serverUrl, {
  authProvider: provider,
});

export { provider, transport };
