/**
 * Integration tests for the mcp-server-tester CLI.
 *
 * Uses bintastic to run the real compiled binary against a temporary directory,
 * so these tests verify actual file I/O rather than mocked behaviour.
 *
 * Prerequisites: the project must be built before running these tests.
 * Run `npm run build` first, or use `npm run test:all` which builds first.
 */

import { createBintastic, type BintasticProject } from 'bintastic';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../../package.json' with { type: 'json' };
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoredTokens } from '../../auth/types.js';
import { generateServerKey } from '../../auth/storage.js';
import { READINESS_SERVER } from '../../../tests/mocks/readyServers.js';

/** A stdio server with one tool, `tool_1`, that answers "ok". */
const SERVER_COMMAND = `${process.execPath} ${READINESS_SERVER}`;

const { setupProject, teardownProject, runBin } = createBintastic({
  binPath: fileURLToPath(
    new URL('../../../dist/cli/index.js', import.meta.url)
  ),
});

/**
 * Write a stored token file for the given server URL into the project's
 * state directory. Mirrors how FileOAuthStorage persists tokens on disk.
 *
 * project.write() takes a nested object representing the directory tree —
 * directory names are object keys, file contents are string values.
 */
async function writeTokens(
  project: BintasticProject,
  serverUrl: string,
  tokens: StoredTokens
): Promise<void> {
  const serverKey = generateServerKey(serverUrl);
  await project.write({
    [serverKey]: {
      'tokens.json': JSON.stringify(tokens, null, 2),
    },
  });
}

describe('mst CLI', () => {
  let project: BintasticProject;

  beforeEach(async () => {
    project = await setupProject();
  });

  afterEach(() => {
    teardownProject();
  });

  describe('--help / --version', () => {
    it('shows top-level help', async () => {
      const result = await runBin('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: mst');
      expect(result.stdout).toContain('Also available as `mcp-server-tester`.');
      expect(result.stdout).toContain('init');
      expect(result.stdout).toContain('generate');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('token');
      expect(result.stdout).toContain('cowork');
    });

    it('ships `mst` and `mcp-server-tester` as the same binary', () => {
      expect(packageJson.bin).toEqual({
        'mcp-server-tester': './dist/cli/index.js',
        mst: './dist/cli/index.js',
      });
    });

    it('shows version', async () => {
      const result = await runBin('--version');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('init --help lists --name and --dir options', async () => {
      const result = await runBin('init', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--name');
      expect(result.stdout).toContain('--dir');
    });

    it('generate --help lists --output and --snapshot options', async () => {
      const result = await runBin('generate', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--output');
      expect(result.stdout).toContain('--snapshot');
    });

    it('login --help lists <server-url> and --force', async () => {
      const result = await runBin('login', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('server-url');
      expect(result.stdout).toContain('--force');
    });

    it('token --help lists <server-url> and --format', async () => {
      const result = await runBin('token', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('server-url');
      expect(result.stdout).toContain('--format');
    });

    it('open --help shows --dir option', async () => {
      const result = await runBin('open', '--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--dir');
    });
  });

  describe('ordinary mistakes', () => {
    const cases = JSON.stringify({
      name: 'cases',
      cases: [{ id: 'a', toolName: 'search', args: {} }],
    });

    it.each([
      [['run', '--manifest', 'x.json'], '--manifest is now --config'],
      [['run', '-c', 'x.json', '--arm', 'a'], '--arm is now --variant'],
      [['batch', '--manifests', 'x.json'], '--manifests is now --configs'],
      [['batch', '--manifest-dir', 'd'], '--manifest-dir is now --config-dir'],
      [['run'], "required option '-c, --config <path>' not specified"],
    ])('%j fails naming the replacement', async (args, message) => {
      const result = await runBin(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    });

    it('a missing eval config is one line, with no stack trace', async () => {
      const result = await runBin('run', '--config', 'missing.json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^mst: Eval config not found: /);
      expect(result.stderr).not.toMatch(/\n\s+at /);
    });

    it('a misspelt key names the key, not a raw ZodError', async () => {
      await project.write({
        'cases.json': cases,
        'typo.json': JSON.stringify({
          name: 'm',
          datasets: ['./cases.json'],
          clientt: { type: 'api' },
        }),
      });
      const result = await runBin('run', '--config', 'typo.json', '--dry-run');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('mst: typo.json: Invalid configuration:');
      expect(result.stderr).toContain('Unrecognized key: "clientt"');
      expect(result.stderr).not.toContain('ZodError');
      expect(result.stderr).not.toMatch(/\n\s+at /);
    });

    it('broken JSON names the file', async () => {
      await project.write({ 'broken.json': '{ name: ' });
      const result = await runBin('run', '--config', 'broken.json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(
        /^mst: Eval config .*broken\.json isn't valid JSON: /
      );
    });

    it('batch names each failing eval config, and a missing directory', async () => {
      await project.write({
        'cases.json': cases,
        'typo.json': JSON.stringify({
          name: 'm',
          datasets: ['./cases.json'],
          clientt: {},
        }),
      });
      const result = await runBin(
        'batch',
        '--configs',
        'typo.json',
        '--dry-run'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('typo.json: Invalid configuration:');
      expect(result.stderr).not.toContain('ZodError');
      const missing = await runBin('batch', '--config-dir', 'nowhere');
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toMatch(
        /^mst: Eval config directory not found: nowhere/
      );
    });

    it('DEBUG=mcp-server-tester:cli shows the stack', async () => {
      const result = await runBin('run', '--config', 'missing.json', {
        env: { DEBUG: 'mcp-server-tester:cli' },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/\n\s+at /);
    });

    it('--env-option takes key=value', async () => {
      const result = await runBin(
        'run',
        '--config',
        'x.json',
        '--env-option',
        'shards'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'mst: --env-option takes key=value, got "shards"'
      );
      const twice = await runBin(
        'run',
        '--config',
        'x.json',
        '--env-option',
        'keep=failed',
        '--env-option',
        'keep=always'
      );
      expect(twice.exitCode).toBe(1);
      expect(twice.stderr).toContain('mst: --env-option keep is given twice');
    });

    it('--resume refuses flags that would change the run', async () => {
      const result = await runBin(
        'run',
        '--config',
        'x.json',
        '--resume',
        '7f3c2a',
        '--case',
        'a',
        '--no-grade'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "mst: --resume completes a run as it was started, so it can't take --case, --no-grade."
      );
    });

    it('a dry run says where the trials would run', async () => {
      await project.write({
        'ok-cases.json': JSON.stringify({
          name: 'cases',
          cases: [{ id: 'a', input: 'hello' }],
        }),
        'ok.json': JSON.stringify({
          name: 'm',
          datasets: ['./ok-cases.json'],
          client: 'claude-code',
        }),
      });
      const result = await runBin(
        'run',
        '--config',
        'ok.json',
        '--dry-run',
        '--env',
        'local',
        '--env-option',
        'keep=failed'
      );
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(String(result.stdout))).toMatchObject({
        env: { name: 'local', shards: 1, keep: 'failed' },
      });
      const sharded = await runBin(
        'run',
        '--config',
        'ok.json',
        '--dry-run',
        '--env-option',
        'shards=3'
      );
      expect(sharded.exitCode).toBe(1);
      expect(sharded.stderr).toContain(
        'mst: The local environment runs one shard'
      );
    });

    it('an unknown client lists the clients there are', async () => {
      await project.write({
        'cases.json': cases,
        'host.json': JSON.stringify({
          name: 'm',
          datasets: ['./cases.json'],
          client: 'sdk',
        }),
      });
      const result = await runBin('run', '--config', 'host.json', '--dry-run');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(
        /^mst: Client "sdk" is not available. Available: api, chatgpt, claude-code, codex-app, codex-cli, cowork./
      );
      expect(result.stderr).not.toMatch(/\n\s+at /);
    });
  });

  describe('datasets command', () => {
    const plugin = `export default {
      meta: { name: 'acme-plugin', namespace: 'acme' },
      datasetSources: {
        'info-seeking': {
          description: 'Questions with one right answer.',
          snapshots: true,
          schema: { safeParse: (value) => ({ success: true, data: value }) },
          async load(_config, { request }) {
            return {
              name: 'info-seeking',
              cases: [{ id: 'a', input: 'qa' }],
              snapshot: request.snapshot ?? '2026-10-06',
            };
          },
          async describe() { return { cases: 1, snapshot: '2026-10-06' }; },
        },
      },
    };`;

    it('lists, shows and pulls a plugin dataset', async () => {
      await project.write({ 'plugin.mjs': plugin });
      const list = await runBin('datasets', '--plugins', './plugin.mjs');
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain(
        'acme/dataset/info-seeking  1 cases  snapshot 2026-10-06  Questions with one right answer.'
      );

      const show = await runBin(
        'datasets',
        'show',
        'acme/dataset/info-seeking',
        '--plugins',
        './plugin.mjs',
        '--snapshot',
        '2026-10-01',
        '--json'
      );
      expect(show.exitCode).toBe(0);
      expect(JSON.parse(String(show.stdout))).toMatchObject({
        ref: 'acme/dataset/info-seeking',
        snapshot: '2026-10-01',
        caseCount: 1,
      });

      const pull = await runBin(
        'datasets',
        'pull',
        'acme/dataset/info-seeking',
        '--plugins',
        './plugin.mjs',
        '--out',
        'datasets/info.json'
      );
      expect(pull.exitCode).toBe(0);
      expect(pull.stderr).toMatch(
        /^acme\/dataset\/info-seeking: 1 cases \(snapshot 2026-10-06, hash [0-9a-f]{64}\) -> datasets\/info\.json/
      );
    });

    it('without plugins says how to name them', async () => {
      const result = await runBin('datasets');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--plugins <module...>, or --config');
    });
  });

  describe('judges command', () => {
    it('lists and shows built-in judges without plugins', async () => {
      const list = await runBin('judges');
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toMatch(
        /^rubric +judge +[0-9a-f]{12} +An LLM grades/m
      );
      expect(list.stdout).toMatch(
        /^task-completion +judge +[0-9a-f]{12} +Asks whether/m
      );
      expect(list.stdout).toMatch(
        /^grounded-in-tools {2}judge +[0-9a-f]{12} +Asks whether every claim/m
      );
      expect(list.stdout).toMatch(
        /^tool-use +judge +[0-9a-f]{12} +Asks whether the client/m
      );
      expect(list.stdout).toMatch(
        /^preference +pairwise {2}[0-9a-f]{12} +Asks which run better/m
      );

      const show = await runBin('judges', 'show', 'rubric', '--json');
      expect(show.exitCode).toBe(0);
      expect(JSON.parse(String(show.stdout))).toMatchObject({
        ref: 'rubric',
        kind: 'judge',
        version: expect.stringMatching(/^[0-9a-f]{64}$/),
        options: { type: 'object', required: ['rubric'] },
      });
    });

    it("lists each judge's version, or marks it unversioned", async () => {
      const schema =
        '{ safeParse: (value) => ({ success: true, data: value }) }';
      await project.write({
        'plugin.mjs': `export default {
          meta: { name: 'acme-plugin', namespace: 'acme', version: '1.4.0' },
          judges: {
            declared: { version: 'declared-2', schema: ${schema}, async evaluate() { return { score: 1 }; } },
            inherited: { schema: ${schema}, async evaluate() { return { score: 1 }; } },
          },
        };`,
        'bare.mjs': `export default {
          meta: { name: 'bare-plugin', namespace: 'bare' },
          judges: {
            loose: { schema: ${schema}, async evaluate() { return { score: 1 }; } },
          },
        };`,
      });
      const list = await runBin(
        'judges',
        '--plugins',
        './plugin.mjs',
        './bare.mjs',
        '--json'
      );
      expect(list.exitCode).toBe(0);
      const listed = JSON.parse(String(list.stdout)) as Array<{
        ref: string;
        version?: string;
        unversioned?: true;
      }>;
      const byRef = Object.fromEntries(
        listed.map((entry) => [entry.ref, entry])
      );
      for (const ref of [
        'criteria',
        'grounded-in-tools',
        'rubric',
        'task-completion',
        'tool-use',
        'preference',
      ])
        expect(byRef[ref]?.version).toMatch(/^[0-9a-f]{64}$/);
      expect(byRef['acme/judge/declared']?.version).toBe('declared-2');
      expect(byRef['acme/judge/inherited']?.version).toBe('1.4.0');
      expect(byRef['bare/judge/loose']).toMatchObject({ unversioned: true });
      expect(byRef['bare/judge/loose']).not.toHaveProperty('version');

      const table = await runBin(
        'judges',
        '--plugins',
        './plugin.mjs',
        './bare.mjs'
      );
      expect(table.exitCode).toBe(0);
      expect(table.stdout).toMatch(
        /^acme\/judge\/declared +judge +declared-2$/m
      );
      expect(table.stdout).toMatch(/^acme\/judge\/inherited +judge +1\.4\.0$/m);
      expect(table.stdout).toMatch(/^bare\/judge\/loose +judge +unversioned$/m);
    });
  });

  describe('clients command', () => {
    it('lists and shows built-in clients without plugins', async () => {
      const list = await runBin('clients');
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toMatch(
        /^cowork +Claude Desktop[^\n]*\n +runs on +macOS, Linux/m
      );
      expect(list.stdout).toMatch(
        /^codex-cli +The Codex CLI[^\n]*\n +runs on +any OS/m
      );
      expect(list.stdout).toMatch(/timeout +none \(no time limit\)/);
      expect(list.stdout).toMatch(/timeout +180000/);

      const show = await runBin('clients', 'show', 'codex-cli', '--json');
      expect(show.exitCode).toBe(0);
      expect(JSON.parse(String(show.stdout))).toMatchObject({
        ref: 'codex-cli',
        options: {
          type: 'object',
          properties: { timeout: { default: 300_000 } },
        },
      });

      const unknown = await runBin('clients', 'show', 'nope');
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain('Client "nope" is not available.');
    });
  });

  describe('label command', () => {
    it('serves the page by default, and lists its commands', async () => {
      const none = await runBin('label');
      expect(none.exitCode).toBe(1);
      expect(none.stderr).toContain("missing required argument 'run'");

      const help = await runBin('label', '--help');
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toMatch(/page \[options\] <run>/);
      expect(help.stdout).toMatch(/import \[options\] <run> <file>/);
    });

    it('gives the page its options, and takes a mistyped command as a run', async () => {
      // The page's options reach it, after the run.
      const port = await runBin(
        'label',
        'r1',
        '--judge',
        'x',
        '--port',
        '99999'
      );
      expect(port.exitCode).toBe(1);
      expect(port.stderr).toContain("--port 99999 isn't a port number");

      // A mistyped command is taken as a run, and says there is no such run.
      const typo = await runBin('label', 'exprot', '--judge', 'x');
      expect(typo.exitCode).toBe(1);
      expect(typo.stderr).toContain('"exprot" isn\'t a run directory');
    });

    it("keeps export's own options, without the page's", async () => {
      // export keeps its own --judge, and doesn't take the page's options.
      const exported = await runBin('label', 'export', 'r1', '--judge', 'x');
      expect(exported.stderr).toContain('"r1" isn\'t a run directory');
      const wrong = await runBin('label', 'export', 'r1', '--port', '1');
      expect(wrong.exitCode).toBe(1);
      expect(wrong.stderr).toContain("unknown option '--port'");
    });

    it("still takes mst's --version after a command", async () => {
      const result = await runBin('run', '--version');
      expect(result.exitCode).toBe(0);
      expect(String(result.stdout).trim()).toBe(packageJson.version);
    });
  });

  describe('open command', () => {
    it('exits with code 1 when there is no run in the default directory', async () => {
      const result = await runBin('open');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No eval runs found');
    });

    it('exits with code 1 when --dir points to a directory with no report', async () => {
      const result = await runBin(
        'open',
        '--dir',
        '/tmp/nonexistent-report-dir'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No eval runs found');
    });
  });

  /**
   * bintastic runs the binary without a terminal, as an agent's shell or CI
   * does. init and generate then ask nothing: they take every answer from
   * flags and name the flag they are missing.
   */
  describe('init command', () => {
    it('names the server flags when it has no terminal to ask', async () => {
      const result = await runBin('init');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Pass --command <command> or --url <url>'
      );
      expect(result.stderr).not.toContain('Raw mode');
    });

    it('scaffolds a project from flags', async () => {
      const result = await runBin(
        'init',
        '--name',
        'demo',
        '--url',
        'http://localhost:3000/mcp',
        '--no-install'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Project initialized successfully!');
      const dir = path.join(project.baseDir, 'demo');
      for (const file of [
        'playwright.config.ts',
        'tests/mcp.spec.ts',
        'data/example-dataset.json',
        'package.json',
        'tsconfig.json',
        '.gitignore',
      ]) {
        expect(existsSync(path.join(dir, file)), file).toBe(true);
      }
      expect(
        readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8')
      ).toContain("serverUrl: 'http://localhost:3000/mcp'");
    });

    it('writes into an existing directory only with --force', async () => {
      const args = [
        'init',
        '--name',
        'demo',
        '--command',
        'node server.js',
        '--no-install',
      ];
      expect((await runBin(...args)).exitCode).toBe(0);

      const again = await runBin(...args);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain('Pass --force');

      expect((await runBin(...args, '--force')).exitCode).toBe(0);
    });

    it('rejects --command with --url', async () => {
      const result = await runBin(
        'init',
        '--command',
        'node server.js',
        '--url',
        'http://localhost:3000/mcp'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Pass --command or --url, not both.');
    });
  });

  describe('generate command', () => {
    it('names --tool when it has no terminal to ask', async () => {
      const result = await runBin('generate');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Pass --tool <name>');
      expect(result.stderr).not.toContain('Raw mode');
    });

    it('reports a config file it cannot read', async () => {
      const result = await runBin(
        'generate',
        '--config',
        'nonexistent.json',
        '--tool',
        'tool_1'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Failed to load config');
    });

    it('rejects --args that is not a JSON object before connecting', async () => {
      const result = await runBin(
        'generate',
        '--command',
        SERVER_COMMAND,
        '--tool',
        'tool_1',
        '--args',
        '[1]'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--args must be a JSON object.');
      expect(result.stdout).not.toContain('Connecting');
    });

    it('records one call with --tool, then adds the next to the same spec', async () => {
      const spec = path.join(project.baseDir, 'tests/generated.spec.ts');
      const first = await runBin(
        'generate',
        '--command',
        SERVER_COMMAND,
        '--tool',
        'tool_1'
      );
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain('Tests added: 1');

      const second = await runBin(
        'generate',
        '--command',
        SERVER_COMMAND,
        '--tool',
        'tool_1',
        '--snapshot'
      );
      expect(second.exitCode).toBe(0);

      const source = readFileSync(spec, 'utf8');
      expect(source).toContain('test("tool_1-1"');
      expect(source).toContain('mcp.callTool("tool_1", {})');
      // The next default title skips the one the spec has.
      expect(source).toContain('toMatchToolSnapshot("tool_1-2")');
    });

    it('writes --name, --description, --suite and --exact into a new spec', async () => {
      const result = await runBin(
        'generate',
        '--command',
        SERVER_COMMAND,
        '--tool',
        'tool_1',
        '--name',
        'answers ok',
        '--description',
        'First line\nglobalThis.ran = true;',
        '--suite',
        'Readiness tools',
        '--exact'
      );
      expect(result.exitCode).toBe(0);

      const source = readFileSync(
        path.join(project.baseDir, 'tests/generated.spec.ts'),
        'utf8'
      );
      expect(source).toContain('test.describe("Readiness tools"');
      expect(source).toContain('test("answers ok"');
      expect(source).toContain('// First line\n  // globalThis.ran = true;');
      expect(source).toContain('toMatchToolResponse(');
    });

    it('runs a --command whose quoted path has a space', async () => {
      const dir = path.join(project.baseDir, 'My Server');
      mkdirSync(dir);
      copyFileSync(READINESS_SERVER, path.join(dir, 'server.mjs'));
      const result = await runBin(
        'generate',
        '--command',
        `"${process.execPath}" "${path.join(dir, 'server.mjs')}"`,
        '--tool',
        'tool_1'
      );

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Tests added: 1');
    });

    it('names the tools a server has when --tool is not one of them', async () => {
      const result = await runBin(
        'generate',
        '--command',
        SERVER_COMMAND,
        '--tool',
        'nope'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'The server has no tool "nope". Its tools: tool_1.'
      );
    });
  });

  describe('login command', () => {
    it('rejects an invalid URL without a terminal', async () => {
      const result = await runBin('login', 'not-a-url');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid URL: not-a-url');
      expect(result.stderr).not.toContain('Raw mode');
    });

    it('reports a server it cannot reach without a terminal', async () => {
      const result = await runBin(
        'login',
        'http://127.0.0.1:9/mcp',
        '--state-dir',
        path.join(project.baseDir, 'state')
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        'Authenticating with http://127.0.0.1:9/mcp'
      );
      expect(result.stderr).toContain('Authentication failed');
      expect(result.stderr).not.toContain('Raw mode');
    });
  });

  describe('token command', () => {
    const serverUrl = 'https://api.example.com/mcp';

    const validTokens: StoredTokens = {
      accessToken: 'test-access-token-abc123',
      refreshToken: 'test-refresh-token-xyz789',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
    };

    it('shows an error message when no tokens are stored', async () => {
      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No tokens found');
    });

    it('writes a long token on one line when its output is piped', async () => {
      // Ink wrapped output at 80 columns, so `>> $GITHUB_ENV` got a broken
      // token.
      const accessToken = 'a'.repeat(900);
      await writeTokens(project, serverUrl, {
        accessToken,
        tokenType: 'Bearer',
      });

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(String(result.stdout).split('\n')).toEqual([
        `MCP_ACCESS_TOKEN=${accessToken}`,
        'MCP_TOKEN_TYPE=Bearer',
      ]);
    });

    it('outputs tokens in env format (default)', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'MCP_ACCESS_TOKEN=test-access-token-abc123'
      );
      expect(result.stdout).toContain(
        'MCP_REFRESH_TOKEN=test-refresh-token-xyz789'
      );
      expect(result.stdout).toContain('MCP_TOKEN_TYPE=Bearer');
    });

    it('outputs tokens in env format when --format env is explicit', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'env'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'MCP_ACCESS_TOKEN=test-access-token-abc123'
      );
    });

    it('outputs tokens in JSON format', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'json'
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(String(result.stdout)) as Record<
        string,
        string
      >;
      expect(parsed['MCP_ACCESS_TOKEN']).toBe('test-access-token-abc123');
      expect(parsed['MCP_REFRESH_TOKEN']).toBe('test-refresh-token-xyz789');
      expect(parsed['MCP_TOKEN_TYPE']).toBe('Bearer');
    });

    it('outputs tokens in GitHub CLI format', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'gh'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('gh secret set MCP_ACCESS_TOKEN');
      expect(result.stdout).toContain('test-access-token-abc123');
    });

    it('works with only an access token (no refresh token)', async () => {
      await writeTokens(project, serverUrl, {
        accessToken: 'minimal-token',
        tokenType: 'Bearer',
      });

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('MCP_ACCESS_TOKEN=minimal-token');
      expect(result.stdout).not.toContain('MCP_REFRESH_TOKEN=');
    });

    it('rejects an unknown --format value', async () => {
      await writeTokens(project, serverUrl, validTokens);

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir,
        '--format',
        'not-a-real-format'
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Allowed choices are env, json, gh.');
    });

    it('includes MCP_TOKEN_EXPIRES_AT when expiresAt is set', async () => {
      const expiresAt = Date.now() + 7200 * 1000;
      await writeTokens(project, serverUrl, {
        accessToken: 'expiring-token',
        tokenType: 'Bearer',
        expiresAt,
      });

      const result = await runBin(
        'token',
        serverUrl,
        '--state-dir',
        project.baseDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`MCP_TOKEN_EXPIRES_AT=${expiresAt}`);
    });
  });
});
