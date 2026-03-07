// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-remote',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'http://localhost:3000/mcp',
        },
      },
    },
  ],
});
