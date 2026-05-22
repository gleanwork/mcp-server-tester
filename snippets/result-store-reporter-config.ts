import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    [
      '@gleanwork/mcp-server-tester/reporters/mcpReporter',
      {
        outputDir: '.mcp-test-results',
        resultStore: {
          provider: 'gcs',
          bucket: 'my-mcp-eval-results',
          prefix: 'my-server/main',
        },
        runMetadata: {
          branch: process.env.GITHUB_REF_NAME ?? 'local',
          trigger: process.env.GITHUB_EVENT_NAME ?? 'manual',
        },
      },
    ],
  ],
});
