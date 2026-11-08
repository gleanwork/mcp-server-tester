import { defineConfig } from '@playwright/test';
import { protocolMatrix } from './src/config/protocolMatrix.js';

/** Port for the docs site's MCP function, started by `webServer` below. */
const SITE_PORT = 3459;

/**
 * Tests for the docs site's MCP server, over the function Vercel deploys
 * (website/api/mcp.mjs) on the built bundle. Build the site first:
 *
 *   (cd website && npm ci && npm run build) && npm run test:site
 *
 * The main config (playwright.config.ts) ignores tests/site/, so its runs
 * don't need a built site.
 */
export default defineConfig({
  testDir: './tests/site',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  webServer: {
    command: 'node website/scripts/serve-mcp.mts',
    env: { PORT: String(SITE_PORT) },
    url: `http://localhost:${SITE_PORT}/mcp`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: protocolMatrix(
    {
      name: 'site',
      use: {
        mcpConfig: {
          transport: 'http' as const,
          serverUrl: `http://localhost:${SITE_PORT}/mcp`,
        },
      },
    },
    ['legacy', '2026-07-28']
  ),
});
