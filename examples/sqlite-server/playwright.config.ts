import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for SQLite MCP Server example
 *
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    [
      '@gleanwork/mcp-server-tester/reporters/mcpReporter',
      {
        outputDir: '.mcp-test-results',
        autoOpen: !process.env.CI,
      },
    ],
  ],

  // Shared settings for all the projects below
  use: {
    // Collect trace when retrying the failed test
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'sqlite-mcp-direct',
      testMatch: '**/sqlite-eval.spec.ts',
      // Direct mode tests only (no LLM)
    },
  ],
});
