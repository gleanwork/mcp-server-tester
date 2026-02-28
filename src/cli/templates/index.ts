/**
 * Template generators for project scaffolding
 */

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

  // Reporters: HTML and MCP Eval Reporter
  reporter: [
    ['html'],
    ['@gleanwork/mcp-server-tester/reporters/mcpReporter', {
      outputDir: '.mcp-test-results',
      historyLimit: 10
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

  test('should run eval dataset', async ({ mcp }, testInfo) => {
    // Load dataset (the dataset JSON uses the 'expect' block for assertions)
    const dataset = await loadEvalDataset('./data/example-dataset.json');

    // Run evals - the runner uses validators internally based on 'expect' block
    const result = await runEvalDataset(
      { dataset },
      { mcp, testInfo, expect }
    );

    expect(result.passed).toBeGreaterThan(0);
  });
});
`;
}

export function getDatasetTemplate(_answers: ProjectAnswers): string {
  return `{
  "name": "example-eval-dataset",
  "description": "Example evaluation dataset for MCP server testing",
  "cases": [
    {
      "id": "example-case-1",
      "description": "Example test case - replace with your actual tool",
      "toolName": "your_tool_name",
      "args": {
        "param1": "value1"
      },
      "expect": {
        "containsText": ["expected text"],
        "isError": false
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
    "@modelcontextprotocol/sdk": "^1.0.4",
    "@playwright/test": "^1.49.0",
    "@gleanwork/mcp-server-tester": "^0.9.0",
    "zod": "^3.24.1"
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
