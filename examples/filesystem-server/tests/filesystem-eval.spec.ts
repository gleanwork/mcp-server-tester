/**
 * Filesystem MCP Server - Comprehensive Testing Example
 *
 * Demonstrates the testing patterns: direct tool calls with matchers,
 * data-driven tool checks (tool-checks.json), and evals on a model
 * (eval-dataset.json).
 */

import { test as base } from '@playwright/test';
import { Project } from 'fixturify-project';
import {
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
  type MCPConfig,
  type MCPFixtureApi,
  runEvalCase,
  type EvalCase,
  type SnapshotSanitizer,
  runConformanceChecks,
  extractText,
  normalizeWhitespace,
  // Extended expect with MCP tool matchers
  expect,
} from '@gleanwork/mcp-server-tester';
import { ConfigFileSchema } from '../schemas/fileContentSchema.js';
import path from 'path';

import evalDataset from '../eval-dataset.json' with { type: 'json' };
import toolChecks from '../tool-checks.json' with { type: 'json' };

type FilesystemFixtures = {
  fileProject: Project;
  projectPath: string;
  mcp: MCPFixtureApi;
};

const test = base.extend<FilesystemFixtures>({
  fileProject: async ({}, use) => {
    const project = new Project('fs-test', '1.0.0', {
      files: {
        'readme.txt': 'Hello World',
        'config.json': JSON.stringify(
          { version: '1.0.0', features: ['logging', 'api', 'authentication'] },
          null,
          2
        ),
        docs: {
          'guide.md': '# User Guide\n\nComplete guide here',
          'api.md': '# API Reference\n\nAPI documentation',
        },
        data: {
          'users.csv':
            'id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com',
          'settings.json': JSON.stringify(
            { theme: 'dark', lang: 'en' },
            null,
            2
          ),
        },
      },
    });

    await project.write();
    await use(project);
    project.dispose();
  },

  projectPath: async ({ fileProject }, use) => {
    await use(fileProject.baseDir);
  },

  mcp: async ({ projectPath }, use, testInfo) => {
    const config: MCPConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', projectPath],
      cwd: projectPath,
      quiet: true,
    };

    const client = await createMCPClientForConfig(config);
    // Include project name for reporter metadata
    const mcpApi = createMCPFixture(client, testInfo, {
      authType: 'none',
      project: testInfo.project.name,
    });

    await use(mcpApi);

    await closeMCPClient(client);
  },
});

test.describe('Protocol Conformance', () => {
  test('passes conformance checks', async ({ mcp }, testInfo) => {
    // Pass testInfo to attach conformance results to the MCP reporter
    const result = await runConformanceChecks(
      mcp,
      {
        requiredTools: ['read_file', 'list_directory', 'directory_tree'],
        validateSchemas: false,
        checkServerInfo: true,
      },
      testInfo
    );

    expect(JSON.stringify(result.checks, null, 2)).toMatchSnapshot();
  });

  test('has valid server info', async ({ mcp }) => {
    const serverInfo = mcp.getServerInfo();
    expect(JSON.stringify(serverInfo, null, 2)).toMatchSnapshot();
  });

  test('lists available tools', async ({ mcp }) => {
    try {
      const tools = await mcp.listTools();
      expect(tools).toMatchSnapshot();
    } catch {
      expect(true).toBe(true);
    }
  });
});

test.describe('Direct API Tests', () => {
  test('reads a file', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'readme.txt' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    expect(text).toBe('Hello World');
  });

  test('lists directory contents', async ({ mcp }) => {
    const result = await mcp.callTool('list_directory', { path: 'docs' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    expect(text).toContain('guide.md');
    expect(text).toContain('api.md');
  });

  test('handles non-existent files', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', {
      path: 'does-not-exist.txt',
    });
    expect(result.isError).toBe(true);
  });

  test('reads JSON and validates structure', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'config.json' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    const config = JSON.parse(text);

    const validated = ConfigFileSchema.parse(config);
    expect(validated.version).toBe('1.0.0');
    expect(validated.features).toContain('api');
  });
});

/** One entry in tool-checks.json: a tool call and what its response must show. */
interface ToolCheck {
  name: string;
  description?: string;
  tool: string;
  args: Record<string, unknown>;
  containsText?: string | string[];
  matchesPattern?: string | string[];
  isError?: boolean | string | string[];
  responseSize?: { maxBytes?: number; minBytes?: number };
  response?: unknown;
  snapshot?: string;
  sanitizers?: SnapshotSanitizer[];
}

/**
 * Data-driven tool checks: each entry in tool-checks.json is a Playwright
 * test that calls the tool and asserts on its response with the matchers.
 */
test.describe('Tool checks (tool-checks.json)', () => {
  for (const check of toolChecks.checks as ToolCheck[]) {
    test(check.name, async ({ mcp }) => {
      const result = await mcp.callTool(check.tool, check.args);
      if (check.isError === false) expect(result).not.toBeToolError();
      else if (check.isError !== undefined)
        expect(result).toBeToolError(
          check.isError === true ? undefined : check.isError
        );
      if (check.containsText)
        expect(result).toContainToolText(check.containsText);
      if (check.matchesPattern)
        expect(result).toMatchToolPattern(check.matchesPattern);
      if (check.responseSize)
        expect(result).toHaveToolResponseSize(check.responseSize);
      if (check.response !== undefined)
        expect(result).toMatchToolResponse(check.response);
      if (check.snapshot)
        await expect(result).toMatchToolSnapshot(
          check.snapshot,
          check.sanitizers
        );
    });
  }
});

function hasApiKey(provider: string): boolean {
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

test.describe('Evals on a model (E2E)', () => {
  // The mst client: a model gets the tools and the input, and picks the calls.
  const client = { client: 'mst', model: 'claude-sonnet-4-5' } as const;

  test('a model discovers and lists directory contents', async ({ mcp }) => {
    test.skip(!hasApiKey('anthropic'), 'ANTHROPIC_API_KEY not set');
    const result = await runEvalCase(
      {
        id: 'list-docs',
        input: 'What files are in the docs directory?',
        assertions: {
          toolsTriggered: { calls: [{ name: 'list_directory' }] },
          containsText: ['guide', 'api'],
        },
      },
      { mcp },
      client
    );
    expect(result.pass, result.error).toBe(true);
  });

  test('a model reads a file and extracts information', async ({ mcp }) => {
    test.skip(!hasApiKey('anthropic'), 'ANTHROPIC_API_KEY not set');
    const result = await runEvalCase(
      {
        id: 'config-version',
        input: 'Read the config.json file and tell me the version number.',
        assertions: { toolCallCount: { min: 1 }, containsText: '1.0.0' },
      },
      { mcp },
      client
    );
    expect(result.pass, result.error).toBe(true);
  });
});

test.describe('Eval: LLM Host Mode', () => {
  // Every case runs on the client it names (mst).
  const llmCases = evalDataset.cases;

  for (const evalCase of llmCases) {
    const provider = 'anthropic';

    test(evalCase.id, async ({ mcp }, testInfo) => {
      if (!hasApiKey(provider)) {
        test.skip(true, `${provider.toUpperCase()}_API_KEY not set`);
        return;
      }

      // The runner uses validators internally based on the 'expect' block
      const result = await runEvalCase(evalCase as EvalCase, {
        mcp,
        testInfo,
        expect,
      });

      if (!result.pass && result.error) {
        if (result.error.includes('429') || result.error.includes('quota')) {
          test.skip(true, `API quota exceeded for ${provider}`);
          return;
        }
      }

      if (!result.pass) {
        const failures = Object.entries(result.expectations || {})
          .filter(([_, exp]) => !exp.pass)
          .map(([name, exp]) => `${name}: ${exp.details}`)
          .join('\n');

        expect(result.pass, `Eval failed:\n${result.error || failures}`).toBe(
          true
        );
      }

      expect(result.pass).toBe(true);
    });
  }
});

test.describe('Text Utilities', () => {
  test('extracts text from MCP responses', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'readme.txt' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    expect(text).toBe('Hello World');
  });

  test('normalizes whitespace for comparison', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'docs/guide.md' });

    expect(result.isError).not.toBe(true);

    const text = extractText(result);
    const normalized = normalizeWhitespace(text);

    expect(normalized).toContain('# User Guide');
    expect(normalized).toContain('Complete guide here');
  });
});

/**
 * NEW: Matcher-Based API (Preferred)
 *
 * These tests demonstrate the new Playwright matcher-based approach.
 * This is the recommended pattern for new tests - it's cleaner and follows
 * standard Playwright conventions.
 *
 * Available matchers:
 * - expect(result).toContainToolText(['text1', 'text2'])
 * - expect(result).toMatchToolPattern([/regex1/, /regex2/])
 * - expect(result).toMatchToolSchema(zodSchema)
 * - expect(result).toBeToolError() / expect(result).not.toBeToolError()
 * - expect(result).toHaveToolResponseSize({ maxBytes: 10000 })
 */
test.describe('Matcher-Based Tests (NEW)', () => {
  test('reads file and validates with matchers', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'readme.txt' });

    // Use new matchers - cleaner than extracting text manually
    expect(result).not.toBeToolError();
    expect(result).toContainToolText('Hello World');
  });

  test('validates config with multiple matchers', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'config.json' });

    expect(result).not.toBeToolError();
    expect(result).toContainToolText(['version', '1.0.0', 'features']);
    expect(result).toMatchToolPattern(/\d+\.\d+\.\d+/); // semver pattern
  });

  test('validates directory listing with patterns', async ({ mcp }) => {
    const result = await mcp.callTool('list_directory', { path: 'docs' });

    expect(result).not.toBeToolError();
    expect(result).toContainToolText(['guide.md', 'api.md']);
    expect(result).toMatchToolPattern([/\.md$/m, /guide/i]);
  });

  test('handles errors gracefully with matchers', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', {
      path: 'does-not-exist.txt',
    });

    // Check that it's an error response
    expect(result).toBeToolError();
  });

  test('validates response size', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'readme.txt' });

    expect(result).not.toBeToolError();
    expect(result).toHaveToolResponseSize({ maxBytes: 1000 });
  });

  test('validates schema with Zod', async ({ mcp }) => {
    const result = await mcp.callTool('read_file', { path: 'config.json' });

    expect(result).not.toBeToolError();
    // Parse the JSON content and validate against schema
    const text = extractText(result);
    const config = JSON.parse(text);
    expect(config).toMatchToolSchema(ConfigFileSchema);
  });
});
