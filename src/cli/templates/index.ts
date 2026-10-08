/**
 * Template generators for project scaffolding
 */
import packageJson from '../../../package.json' with { type: 'json' };

interface ProjectAnswers {
  projectName: string;
  transport: 'stdio' | 'http';
  serverCommand?: string;
  serverUrl?: string;
}

export function getPlaywrightConfigTemplate(answers: ProjectAnswers): string {
  const mcpConfig =
    answers.transport === 'stdio'
      ? `{
          transport: 'stdio' as const,
          command: '${answers.serverCommand?.split(' ')[0] || 'node'}',
          args: [${
            answers.serverCommand
              ?.split(' ')
              .slice(1)
              .map((arg) => `'${arg}'`)
              .join(', ') || "'server.js'"
          }],
          capabilities: {
            roots: { listChanged: true },
          },
        }`
      : `{
          transport: 'http' as const,
          serverUrl: '${answers.serverUrl || 'http://localhost:3000/mcp'}',
          capabilities: {
            roots: { listChanged: true },
          },
        }`;

  return `import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for MCP evaluation tests
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporters: Playwright's HTML report for tests, the MCP reporter for evals
  reporter: [
    ['html'],
    ['@gleanwork/mcp-server-tester/reporters/mcpReporter', {
      outputDir: '.mcp-test-results',
      name: ${JSON.stringify(answers.projectName)}
    }]
  ],

  use: {
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'mcp-tests',
      testMatch: /.*\\.spec\\.ts/,
      use: {
        // MCP server configuration
        mcpConfig: ${mcpConfig},
      },
    },
  ],
});
`;
}

export function getTestFileTemplate(_answers: ProjectAnswers): string {
  return `import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  runConformanceChecks,
  loadEvalDataset,
  runEvalDataset,
} from '@gleanwork/mcp-server-tester';

test.describe('MCP Server Tests', () => {
  test('should connect to MCP server', async ({ mcp }) => {
    const serverInfo = mcp.getServerInfo();
    expect(serverInfo).toBeTruthy();
  });

  test('should list available tools', async ({ mcp }) => {
    const tools = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  test('should run conformance checks', async ({ mcp }) => {
    const result = await runConformanceChecks(mcp, {
      validateSchemas: true,
      checkServerInfo: true,
    });

    expect(result.pass).toBe(true);
  });

  // A direct tool call: replace the tool, its arguments and what it returns.
  test('your_tool_name returns the expected text', async ({ mcp }) => {
    const result = await mcp.callTool('your_tool_name', { param1: 'value1' });
    expect(result).not.toBeToolError();
    expect(result).toContainToolText('expected text');
  });

  // An eval: a model gets your tools and each case's input, and the
  // assertions check what it did. It calls a paid model API, so it needs a key
  // (and \`npm install ai @ai-sdk/anthropic\`).
  test('a model picks the right tools', async ({ mcp }, testInfo) => {
    test.skip(!process.env.ANTHROPIC_API_KEY, 'Set ANTHROPIC_API_KEY to run evals');
    const dataset = await loadEvalDataset('./data/example-dataset.json');
    const result = await runEvalDataset(
      { dataset, client: 'mst', model: 'claude-haiku-4-5' },
      { mcp, testInfo }
    );
    expect(result.passed).toBe(result.total);
  });
});
`;
}

export function getDatasetTemplate(_answers: ProjectAnswers): string {
  return `{
  "name": "example-eval-dataset",
  "description": "Example eval cases: requests a user might make, and the tools a model should call",
  "cases": [
    {
      "id": "example-case-1",
      "description": "Example case - replace with a request your server should handle",
      "input": "Replace with something a user would ask, such as: find the latest planning doc",
      "assertions": {
        "toolsTriggered": {
          "calls": [{ "name": "your_tool_name", "required": true }]
        }
      }
    }
  ],
  "metadata": {
    "version": "1.0",
    "author": "@gleanwork/mcp-server-tester",
    "created": "${new Date().toISOString().split('T')[0]}"
  }
}
`;
}

export function getGitignoreTemplate(): string {
  return `# Dependencies
node_modules/

# Test results
test-results/
playwright-report/
playwright/.cache/
.mcp-test-results/

# Build output
dist/

# Environment variables
.env
.env.local

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
`;
}

export function getPackageJsonTemplate(projectName: string): string {
  return `{
  "name": "${projectName}",
  "version": "1.0.0",
  "description": "MCP server evaluation tests",
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "test:ui": "playwright test --ui",
    "test:headed": "playwright test --headed",
    "report": "playwright show-report"
  },
  "keywords": [
    "mcp",
    "playwright",
    "testing",
    "evals"
  ],
  "dependencies": {
    "@modelcontextprotocol/client": "^2.2.0",
    "@playwright/test": "^1.49.0",
    "@gleanwork/mcp-server-tester": "^${packageJson.version}",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
`;
}

export function getTsconfigTemplate(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "allowJs": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node", "@playwright/test"]
  },
  "include": ["tests/**/*"],
  "exclude": ["node_modules"]
}
`;
}
