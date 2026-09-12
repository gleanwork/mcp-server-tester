import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBuiltinHosts } from './builtinHosts.js';
import { getHost } from './frameworkRegistries.js';
import type { HostRunContext } from './evalFrameworkTypes.js';

let directory: string;
beforeEach(() => {
  registerBuiltinHosts();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-cli-test-'));
  fs.writeFileSync(
    path.join(directory, 'claude'),
    `#!${process.execPath}
console.log(JSON.stringify({ type: 'result', result: process.argv[process.argv.indexOf('--model') + 1] }));
`,
    { mode: 0o700 }
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('registered CLI host with a local process', () => {
  it.each(['generated', 'legacy'] as const)(
    'preserves environment precedence in an actual %s CLI command without mutation',
    async (command) => {
      vi.stubEnv('HOST_ENV_SHARED', 'ambient');
      vi.stubEnv('HOST_ENV_REMOVED', 'ambient');
      vi.stubEnv('MCP_PLUGIN_DIR', undefined);
      fs.writeFileSync(
        path.join(directory, 'claude'),
        `#!${process.execPath}
const keys = ['HOST_ENV_SHARED', 'HOST_ENV_HOST_WINS', 'HOST_ENV_SUITE_ONLY', 'HOST_ENV_REMOVED', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS'];
const env = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ env, strict: process.argv.includes('--strict-mcp-config') }) }));
`
      );
      const input = {
        scenario: 'hello',
        servers: [],
        env: {
          PATH: directory,
          HOST_ENV_SHARED: 'suite',
          HOST_ENV_HOST_WINS: 'suite',
          HOST_ENV_SUITE_ONLY: 'suite-only',
        },
      };
      const host = {
        type: 'claude-cli',
        env: {
          HOST_ENV_SHARED: 'host',
          HOST_ENV_HOST_WINS: 'host',
          HOST_ENV_REMOVED: undefined,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      };
      const context: HostRunContext = {
        manifest: { name: 'offline', datasets: [] },
        env: { HOST_ENV_SHARED: 'context' },
        mcpHostConfig: {
          env: {
            HOST_ENV_SHARED: 'case',
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
          },
          ...(command === 'legacy'
            ? {
                cli: {
                  command: path.join(directory, 'claude'),
                  args: [],
                  outputFormat: 'stream-json',
                  env: { HOST_ENV_SHARED: 'cli-case' },
                },
              }
            : {}),
        },
      };
      const before = structuredClone({ input, host, context });
      const result = await getHost('claude-cli').run!(input, host, context);
      expect(result.error).toBeUndefined();
      const observed: {
        env: Record<string, string | null>;
        strict: boolean;
      } = JSON.parse(result.finalText ?? '');
      expect(observed.env).toMatchObject({
        HOST_ENV_SHARED: command === 'legacy' ? 'cli-case' : 'case',
        HOST_ENV_HOST_WINS: 'host',
        HOST_ENV_SUITE_ONLY: 'suite-only',
        HOST_ENV_REMOVED: null,
      });
      if (command === 'generated') {
        expect(observed.strict).toBe(true);
        expect(observed.env).toMatchObject({
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        });
      }
      expect({ input, host, context }).toEqual(before);
      expect(process.env.HOST_ENV_SHARED).toBe('ambient');
      expect(process.env.HOST_ENV_REMOVED).toBe('ambient');
    }
  );

  it('bounds the CLI lifecycle, removes its config and stops only its owned child', async () => {
    const marker = path.join(directory, 'child.json');
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const config = process.argv[process.argv.indexOf('--mcp-config') + 1];
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, config, configExists: fs.existsSync(config) }));
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 5000);
`,
      { mode: 0o700 }
    );
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      { stdio: 'ignore' }
    );
    let ownedPid: number | undefined;
    try {
      const pending = getHost('claude-cli').run!(
        { scenario: 'hello', servers: [], env: { PATH: directory } },
        { type: 'claude-cli', timeout: 1000 },
        { manifest: { name: 'offline', datasets: [] } }
      );
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
      const child = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
        pid: number;
        config: string;
        configExists: boolean;
      };
      ownedPid = child.pid;
      expect(child.configExists).toBe(true);
      const result = await pending;
      expect(result.error).toContain('timed out');
      expect(fs.existsSync(child.config)).toBe(false);
      await vi.waitFor(() => expect(isProcessAlive(child.pid)).toBe(false), {
        timeout: 500,
      });
      expect(unrelated.pid).toBeDefined();
      expect(isProcessAlive(unrelated.pid!)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
      if (ownedPid && isProcessAlive(ownedPid))
        process.kill(ownedPid, 'SIGKILL');
    }
  });

  it('keeps the supplied host deadline when legacy CLI arguments replace the generated config', async () => {
    const pending = getHost('claude-cli').run!(
      { scenario: 'hello', servers: [] },
      { type: 'claude-cli', timeout: 50 },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: {
          cli: {
            command: process.execPath,
            args: [
              '-e',
              'setTimeout(() => console.log(JSON.stringify({ success: true, toolCalls: [], response: "late" })), 150)',
            ],
            outputFormat: 'json',
            timeout: 1000,
          },
        },
      }
    );
    expect((await pending).error).toContain('timed out');
  });

  it('retains an immediate legacy CLI timeout of zero', async () => {
    const result = await getHost('claude-cli').run!(
      { scenario: 'hello', servers: [] },
      { type: 'claude-cli' },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: {
          cli: { command: process.execPath, args: [], timeout: 0 },
        },
      }
    );
    expect(result.error).toContain('timed out after 0 ms');
  });

  it.each([{ temperature: 0.4 }, { maxTokens: 123 }, { maxToolCalls: 0 }])(
    'explicitly rejects unsupported legacy CLI generation settings %j',
    async (mcpHostConfig) => {
      await expect(
        getHost('claude-cli').run!(
          { scenario: 'hello', servers: [] },
          { type: 'claude-cli' },
          { manifest: { name: 'offline', datasets: [] }, mcpHostConfig }
        )
      ).rejects.toThrow();
    }
  );

  it('applies the legacy case model before constructing generated CLI arguments', async () => {
    const result = await getHost('claude-cli').run!(
      { scenario: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-cli', model: 'suite-model' },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: { model: 'legacy-model' },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('legacy-model');
  });

  it('preserves explicit legacy command arguments instead of rewriting them', async () => {
    const result = await getHost('claude-cli').run!(
      { scenario: 'hello', servers: [] },
      { type: 'claude-cli', model: 'suite-model' },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: {
          model: 'legacy-model',
          cli: {
            command: process.execPath,
            args: [
              '-e',
              'console.log(JSON.stringify({ success: true, toolCalls: [], response: process.argv[1] }))',
              '{{scenario}}',
            ],
            outputFormat: 'json',
          },
        },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('hello');
  });
});
