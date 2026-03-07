import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    // Local development server
    {
      name: 'local-dev',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/server.js'],
          env: { NODE_ENV: 'development' },
        },
      },
    },

    // Local production build
    {
      name: 'local-prod',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/server.js'],
          env: { NODE_ENV: 'production' },
        },
      },
    },

    // Staging server
    {
      name: 'staging',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://staging.example.com/mcp',
          headers: {
            Authorization: `Bearer ${process.env.STAGING_TOKEN}`,
          },
        },
      },
    },

    // Production server
    {
      name: 'production',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          headers: {
            Authorization: `Bearer ${process.env.PROD_TOKEN}`,
          },
        },
      },
    },
  ],
});
