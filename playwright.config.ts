import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for MCP eval tests
 *
 * This config demonstrates the recommended pattern for MCP testing:
 * - Define custom `mcpConfig` in project `use` blocks
 * - Create separate projects for different transport types
 * - Use the mcp fixture to interact with MCP servers
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'mcp-stdio-mock',
      testMatch: /.*\.spec\.ts/,
      use: {
        // Custom mcpConfig for stdio transport using mock server
        mcpConfig: {
          transport: 'stdio' as const,
          command: 'npx',
          args: ['tsx', 'tests/mocks/simpleMCPServer.ts'],
          capabilities: {
            roots: { listChanged: true },
          },
        },
      },
    },
    // Uncomment to add HTTP transport testing:
    // {
    //   name: 'mcp-http-example',
    //   testMatch: /.*\.spec\.ts/,
    //   use: {
    //     mcpConfig: {
    //       transport: 'http' as const,
    //       serverUrl: 'http://localhost:3000/mcp',
    //       capabilities: {
    //         roots: { listChanged: true },
    //       },
    //     },
    //   },
    // },
  ],
});
