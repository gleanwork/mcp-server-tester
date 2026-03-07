// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-local',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['path/to/server.js'],
        },
      },
    },
  ],
});
