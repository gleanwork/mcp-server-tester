import { describe, it, expect } from 'vitest';
import {
  getPlaywrightConfigTemplate,
  getTestFileTemplate,
  getDatasetTemplate,
  getGitignoreTemplate,
  getPackageJsonTemplate,
  getTsconfigTemplate,
} from './index.js';

describe('CLI template generators', () => {
  describe('getPlaywrightConfigTemplate', () => {
    describe('stdio transport', () => {
      it('generates valid TypeScript with stdio transport config', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'stdio',
          serverCommand: 'node server.js',
        });

        expect(config).toContain("transport: 'stdio' as const");
        expect(config).toContain("command: 'node'");
        expect(config).toContain("'server.js'");
      });

      it('uses the correct fixture import path', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'stdio',
          serverCommand: 'node server.js',
        });

        // Should reference the mcp-server-tester reporter
        expect(config).toContain(
          '@gleanwork/mcp-server-tester/reporters/mcpReporter'
        );
      });

      it('does not include serverUrl for stdio transport', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'stdio',
          serverCommand: 'node server.js',
        });

        expect(config).not.toContain("transport: 'http' as const");
      });

      it('splits multi-argument server command correctly', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'stdio',
          serverCommand: 'npx ts-node src/server.ts',
        });

        expect(config).toContain("command: 'npx'");
        expect(config).toContain("'ts-node'");
        expect(config).toContain("'src/server.ts'");
      });

      it('is valid TypeScript (no obvious syntax errors)', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'stdio',
          serverCommand: 'node server.js',
        });

        // Should export a default config
        expect(config).toContain('export default defineConfig');
        // Should import defineConfig from @playwright/test
        expect(config).toContain(
          "import { defineConfig } from '@playwright/test'"
        );
      });
    });

    describe('http transport', () => {
      it('generates valid TypeScript with http transport config', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'http',
          serverUrl: 'http://localhost:3000/mcp',
        });

        expect(config).toContain("transport: 'http' as const");
        expect(config).toContain("serverUrl: 'http://localhost:3000/mcp'");
      });

      it('uses the correct fixture import path', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'http',
          serverUrl: 'http://localhost:8080/mcp',
        });

        expect(config).toContain(
          '@gleanwork/mcp-server-tester/reporters/mcpReporter'
        );
      });

      it('does not include command for http transport', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'http',
          serverUrl: 'http://localhost:3000/mcp',
        });

        expect(config).not.toContain("transport: 'stdio' as const");
      });

      it('embeds the serverUrl in the config', () => {
        const serverUrl = 'https://my-server.example.com/mcp';
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'http',
          serverUrl,
        });

        expect(config).toContain(serverUrl);
      });

      it('uses fallback URL when serverUrl is not provided', () => {
        const config = getPlaywrightConfigTemplate({
          projectName: 'my-tests',
          transport: 'http',
        });

        expect(config).toContain('http://localhost:3000/mcp');
      });
    });

    it('includes outputDir and historyLimit in reporter config', () => {
      const config = getPlaywrightConfigTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
        serverCommand: 'node server.js',
      });

      expect(config).toContain('outputDir');
      expect(config).toContain('historyLimit');
    });
  });

  describe('getTestFileTemplate', () => {
    it('does NOT import extractTextFromResponse (deprecated function)', () => {
      const testFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      expect(testFile).not.toContain('extractTextFromResponse');
    });

    it('imports from the correct fixture path', () => {
      const testFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      expect(testFile).toContain('@gleanwork/mcp-server-tester/fixtures/mcp');
    });

    it('imports runConformanceChecks and runEvalDataset from @gleanwork/mcp-server-tester', () => {
      const testFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      expect(testFile).toContain('runConformanceChecks');
      expect(testFile).toContain('runEvalDataset');
      expect(testFile).toContain('@gleanwork/mcp-server-tester');
    });

    it('includes a basic connectivity test', () => {
      const testFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      expect(testFile).toContain('mcp.listTools');
    });

    it('does not include extractText import by default (uses text matchers instead)', () => {
      const testFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      // The generated test should use the matcher API, not extractText helper
      expect(testFile).not.toContain('import { extractText }');
    });

    it('works for both stdio and http transport modes', () => {
      const stdioFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      const httpFile = getTestFileTemplate({
        projectName: 'my-tests',
        transport: 'http',
      });

      // Both should be valid test files with the same structure
      expect(stdioFile).toContain('test.describe');
      expect(httpFile).toContain('test.describe');
    });
  });

  describe('getPackageJsonTemplate', () => {
    it('includes @gleanwork/mcp-server-tester as a dependency', () => {
      const pkg = getPackageJsonTemplate('my-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.dependencies).toHaveProperty(
        '@gleanwork/mcp-server-tester'
      );
    });

    it('includes @playwright/test as a dependency', () => {
      const pkg = getPackageJsonTemplate('my-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.dependencies).toHaveProperty('@playwright/test');
    });

    it('includes @modelcontextprotocol/sdk as a dependency', () => {
      const pkg = getPackageJsonTemplate('my-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    });

    it('sets the project name correctly', () => {
      const pkg = getPackageJsonTemplate('awesome-mcp-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.name).toBe('awesome-mcp-tests');
    });

    it('includes a test script', () => {
      const pkg = getPackageJsonTemplate('my-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.scripts).toHaveProperty('test');
      expect(parsed.scripts.test).toContain('playwright');
    });

    it('generates valid JSON', () => {
      const pkg = getPackageJsonTemplate('my-tests');

      expect(() => JSON.parse(pkg)).not.toThrow();
    });

    it('sets type to module for ESM support', () => {
      const pkg = getPackageJsonTemplate('my-tests');
      const parsed = JSON.parse(pkg);

      expect(parsed.type).toBe('module');
    });
  });

  describe('getDatasetTemplate', () => {
    it('generates valid JSON', () => {
      const dataset = getDatasetTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      expect(() => JSON.parse(dataset)).not.toThrow();
    });

    it('includes an example case', () => {
      const dataset = getDatasetTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      const parsed = JSON.parse(dataset);
      expect(parsed.cases).toBeDefined();
      expect(Array.isArray(parsed.cases)).toBe(true);
      expect(parsed.cases.length).toBeGreaterThan(0);
    });

    it('includes a dataset name', () => {
      const dataset = getDatasetTemplate({
        projectName: 'my-tests',
        transport: 'stdio',
      });

      const parsed = JSON.parse(dataset);
      expect(parsed.name).toBeDefined();
      expect(typeof parsed.name).toBe('string');
    });
  });

  describe('getGitignoreTemplate', () => {
    it('includes node_modules', () => {
      const gitignore = getGitignoreTemplate();

      expect(gitignore).toContain('node_modules');
    });

    it('includes .env for secret protection', () => {
      const gitignore = getGitignoreTemplate();

      expect(gitignore).toContain('.env');
    });

    it('includes mcp test results directory', () => {
      const gitignore = getGitignoreTemplate();

      expect(gitignore).toContain('.mcp-test-results');
    });

    it('includes playwright report directories', () => {
      const gitignore = getGitignoreTemplate();

      expect(gitignore).toContain('playwright-report');
    });
  });

  describe('getTsconfigTemplate', () => {
    it('generates valid JSON', () => {
      const tsconfig = getTsconfigTemplate();

      expect(() => JSON.parse(tsconfig)).not.toThrow();
    });

    it('enables strict mode', () => {
      const tsconfig = getTsconfigTemplate();
      const parsed = JSON.parse(tsconfig);

      expect(parsed.compilerOptions.strict).toBe(true);
    });

    it('targets ES2022 or later', () => {
      const tsconfig = getTsconfigTemplate();
      const parsed = JSON.parse(tsconfig);

      const target = parsed.compilerOptions.target;
      expect(target).toBeDefined();
      // Should be at least ES2022
      expect(['ES2022', 'ES2023', 'ES2024', 'ESNext']).toContain(target);
    });

    it('includes @playwright/test types', () => {
      const tsconfig = getTsconfigTemplate();
      const parsed = JSON.parse(tsconfig);

      expect(parsed.compilerOptions.types).toContain('@playwright/test');
    });
  });
});
