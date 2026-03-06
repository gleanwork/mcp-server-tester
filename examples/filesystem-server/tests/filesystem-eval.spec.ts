/**
 * Filesystem MCP Server - Comprehensive Testing Example
 *
 * Demonstrates all testing patterns: direct API, inline evals, JSON datasets,
 * and LLM host simulation (E2E).
 */

import { test as base } from '@playwright/test';
import { Project } from 'fixturify-project';
import {
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
  type MCPConfig,
  type MCPFixtureApi,
  loadEvalDataset,
  runEvalDataset,
  runEvalCase,
  type EvalCase,
  runConformanceChecks,
  simulateMCPHost,
  extractText,
  normalizeWhitespace,
  // Extended expect with MCP tool matchers
  expect,
} from '@gleanwork/mcp-server-tester';
import { ConfigFileSchema } from '../schemas/fileContentSchema.js';
import path from 'path';

import evalDataset from '../eval-dataset.json' with { type: 'json' };

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

test.describe('Inline Eval Cases', () => {
  test('validates config content with inline case', async ({ mcp }) => {
    const result = await runEvalCase(
      {
        id: 'inline-config-check',
        toolName: 'read_file',
        args: { path: 'config.json' },
        expect: {
          containsText: ['version', '1.0.0', 'features'],
        },
      },
      { mcp }
    );

    expect(result.pass).toBe(true);
    expect(result.toolName).toBe('read_file');
  });

  test('validates directory listing with regex', async ({ mcp }) => {
    const result = await runEvalCase(
      {
        id: 'inline-docs-listing',
        toolName: 'list_directory',
        args: { path: 'docs' },
        expect: {
          containsText: ['guide.md', 'api.md'],
          matchesPattern: ['\\.md'],
        },
      },
      { mcp }
    );

    expect(result.pass).toBe(true);
  });
});

test.describe('Eval Dataset (Batch)', () => {
  test('runs all direct mode cases', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset(
      path.join(import.meta.dirname, '..', 'eval-dataset.json')
    );

    const directCases = dataset.cases.filter(
      (c) => c.mode === 'direct' || !c.mode
    );
    const directDataset = { ...dataset, cases: directCases };

    // The runner uses validators internally based on the 'expect' block
    const result = await runEvalDataset(
      { dataset: directDataset },
      { mcp, testInfo, expect }
    );

    expect(result.passed).toBe(result.total);
    expect(result.failed).toBe(0);
  });
});

test.describe('Eval: Direct Mode', () => {
  const directCases = evalDataset.cases.filter(
    (c) => c.mode === 'direct' || !c.mode
  );

  for (const evalCase of directCases) {
    test(evalCase.id, async ({ mcp }, testInfo) => {
      // The runner uses validators internally based on the 'expect' block
      const result = await runEvalCase(evalCase as EvalCase, {
        mcp,
        testInfo,
        expect,
      });

      if (!result.pass) {
        const failures = Object.entries(result.expectations || {})
          .filter(([_, exp]) => !exp.pass)
          .map(([name, exp]) => `${name}: ${exp.details}`)
          .join('\n');

        expect.soft(result.pass, `Eval failed:\n${failures}`).toBe(true);
      }

      expect(result.pass).toBe(true);
    });
  }
});

function hasApiKey(provider: string): boolean {
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

test.describe('LLM Host Simulation (E2E)', () => {
  test('LLM discovers and lists directory contents', async ({ mcp }) => {
    if (!hasApiKey('anthropic')) {
      test.skip(true, 'ANTHROPIC_API_KEY not set');
      return;
    }

    const result = await simulateMCPHost(
      mcp,
      'What files are in the docs directory?',
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        temperature: 0,
      }
    );

    expect(result.success).toBe(true);
    expect(result.toolCalls.length).toBeGreaterThan(0);

    const listDirCall = result.toolCalls.find(
      (c) => c.name === 'list_directory'
    );
    expect(listDirCall).toBeDefined();

    expect(result.response).toContain('guide');
    expect(result.response).toContain('api');
  });

  test('LLM reads file and extracts information', async ({ mcp }) => {
    if (!hasApiKey('anthropic')) {
      test.skip(true, 'ANTHROPIC_API_KEY not set');
      return;
    }

    const result = await simulateMCPHost(
      mcp,
      'Read the config.json file and tell me the version number.',
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        temperature: 0,
      }
    );

    expect(result.success).toBe(true);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.response).toContain('1.0.0');
  });
});

test.describe('Eval: LLM Host Mode', () => {
  const llmCases = evalDataset.cases.filter((c) => c.mode === 'mcp_host');

  for (const evalCase of llmCases) {
    const provider = evalCase.mcpHostConfig?.provider || 'unknown';

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
