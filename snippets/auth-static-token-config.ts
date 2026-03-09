// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-authenticated',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          auth: {
            accessToken: process.env.MCP_ACCESS_TOKEN,
          },
        },
      },
    },
  ],
});
