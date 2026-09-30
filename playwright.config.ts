import { defineConfig } from '@playwright/test';
import { protocolMatrix } from './src/config/protocolMatrix.js';

/** Port for the dual-era HTTP mock started by `webServer` below. */
const DUAL_ERA_HTTP_PORT = 3917;

const dualEraSpecs = /(mcp-tests|protocol|skills)\.spec\.ts/;

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
  webServer: {
    command: `node --import tsx tests/mocks/dualEraServer.ts --http ${DUAL_ERA_HTTP_PORT}`,
    port: DUAL_ERA_HTTP_PORT,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'mcp-stdio-mock',
      testMatch: /.*\.spec\.ts/,
      use: {
        // Custom mcpConfig for stdio transport using mock server
        mcpConfig: {
          transport: 'stdio' as const,
          command: process.execPath,
          args: ['--import', 'tsx', 'tests/mocks/simpleMCPServer.ts'],
          capabilities: {
            roots: { listChanged: true },
          },
        },
      },
    },
    // The same specs against a server that speaks both protocol eras, once
    // per protocol setting (projects are named e.g. "dual-stdio@2026-07-28").
    ...protocolMatrix(
      {
        name: 'dual-stdio',
        testMatch: dualEraSpecs,
        use: {
          mcpConfig: {
            transport: 'stdio' as const,
            command: process.execPath,
            args: ['--import', 'tsx', 'tests/mocks/dualEraServer.ts'],
            quiet: true,
          },
        },
      },
      ['legacy', '2025-06-18', '2026-07-28', 'auto']
    ),
    ...protocolMatrix(
      {
        name: 'dual-http',
        testMatch: dualEraSpecs,
        use: {
          mcpConfig: {
            transport: 'http' as const,
            serverUrl: `http://127.0.0.1:${DUAL_ERA_HTTP_PORT}/mcp`,
          },
        },
      },
      ['legacy', '2026-07-28']
    ),
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
