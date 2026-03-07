import { defineConfig } from '@playwright/test';
import type { MCPClientCredentialsConfig } from '@gleanwork/mcp-server-tester';

const clientCredentials: MCPClientCredentialsConfig = {
  // clientId and clientSecret can be omitted when MCP_CLIENT_ID / MCP_CLIENT_SECRET
  // environment variables are set. Provide them here to override the env vars.
  clientId: process.env.MCP_CLIENT_ID,
  clientSecret: process.env.MCP_CLIENT_SECRET,
  tokenEndpoint: 'https://auth.example.com/oauth/token',
  scopes: ['mcp:read', 'mcp:write'],
};

export default defineConfig({
  projects: [
    {
      name: 'mcp-client-credentials',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          auth: {
            clientCredentials,
          },
        },
      },
    },
  ],
});
