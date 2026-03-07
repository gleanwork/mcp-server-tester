import { CLIOAuthClient } from '@gleanwork/mcp-server-tester';

const client = new CLIOAuthClient({
  mcpServerUrl: 'https://api.example.com/mcp',
});

// Get a valid access token (cached, refreshed, or new)
const result = await client.getAccessToken();
console.log(`Token: ${result.accessToken}`);
console.log(`Expires: ${new Date(result.expiresAt!).toLocaleString()}`);
