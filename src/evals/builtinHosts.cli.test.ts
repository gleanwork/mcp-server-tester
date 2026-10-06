import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHost } from './builtinHosts.js';
import type { ClientRunContext } from './evalFrameworkTypes.js';

let directory: string;
beforeEach(() => {
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

describe('CLI host with a local process', () => {
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
        prompt: 'hello',
        servers: [],
        env: {
          PATH: directory,
          HOST_ENV_SHARED: 'suite',
          HOST_ENV_HOST_WINS: 'suite',
          HOST_ENV_SUITE_ONLY: 'suite-only',
        },
      };
      const host = {
        type: 'claude-code',
        env: {
          HOST_ENV_SHARED: 'host',
          HOST_ENV_HOST_WINS: 'host',
          HOST_ENV_REMOVED: undefined,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      };
      const context: ClientRunContext = {
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
      const result = await getHost('claude-code').run!(input, host, context);
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
    // The fake CLI must boot Node and write its marker before the host deadline.
    // Under full-suite load that can take most of a second, so leave headroom;
    // both sleepers outlive the deadline so only the host can end the child.
    const deadlineMs = 3000;
    const marker = path.join(directory, 'child.json');
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const config = process.argv[process.argv.indexOf('--mcp-config') + 1];
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, config, configExists: fs.existsSync(config) }));
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 30000);
`,
      { mode: 0o700 }
    );
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'ignore' }
    );
    let ownedPid: number | undefined;
    try {
      const pending = getHost('claude-code').run!(
        { prompt: 'hello', servers: [], env: { PATH: directory } },
        { type: 'claude-code', timeout: deadlineMs },
        { manifest: { name: 'offline', datasets: [] } }
      );
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
        timeout: deadlineMs,
      });
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
        timeout: 2000,
      });
      expect(unrelated.pid).toBeDefined();
      expect(isProcessAlive(unrelated.pid!)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
      if (ownedPid && isProcessAlive(ownedPid))
        process.kill(ownedPid, 'SIGKILL');
    }
  }, 15_000);

  it('keeps the supplied host deadline when legacy CLI arguments replace the generated config', async () => {
    const pending = getHost('claude-code').run!(
      { prompt: 'hello', servers: [] },
      { type: 'claude-code', timeout: 50 },
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
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [] },
      { type: 'claude-code' },
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
        getHost('claude-code').run!(
          { prompt: 'hello', servers: [] },
          { type: 'claude-code' },
          { manifest: { name: 'offline', datasets: [] }, mcpHostConfig }
        )
      ).rejects.toThrow();
    }
  );

  it('applies the legacy case model before constructing generated CLI arguments', async () => {
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', model: 'suite-model' },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: { model: 'legacy-model' },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('legacy-model');
  });

  it('preserves explicit legacy command arguments instead of rewriting them', async () => {
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [] },
      { type: 'claude-code', model: 'suite-model' },
      {
        manifest: { name: 'offline', datasets: [] },
        mcpHostConfig: {
          model: 'legacy-model',
          cli: {
            command: process.execPath,
            args: [
              '-e',
              'console.log(JSON.stringify({ success: true, toolCalls: [], response: process.argv[1] }))',
              '{{prompt}}',
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

describe('claude-cli systemPrompt', () => {
  it('reaches the CLI exactly as written', async () => {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const at = process.argv.indexOf('--append-system-prompt');
console.log(JSON.stringify({ type: 'result', result: at < 0 ? 'none' : process.argv[at + 1] }));
`,
      { mode: 0o700 }
    );
    const prompt = 'Use find_skills first; never expand {{prompt}} or $&.';
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', systemPrompt: prompt },
      { manifest: { name: 'offline', datasets: [] } }
    );
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe(prompt);
  });
});

describe('claude-cli isolation', () => {
  function fakeClaude(): void {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.CLAUDE_CONFIG_DIR;
const seen = dir === undefined ? null : { dir, exists: fs.existsSync(dir), entries: fs.existsSync(dir) ? fs.readdirSync(dir).length : -1 };
console.log(JSON.stringify({ type: 'result', result: JSON.stringify(seen) }));
`,
      { mode: 0o700 }
    );
  }
  async function run(host: Record<string, unknown>) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    fakeClaude();
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', ...host },
      { manifest: { name: 'offline', datasets: [] } }
    );
    expect(result.error).toBeUndefined();
    return JSON.parse(result.finalText) as {
      dir: string;
      exists: boolean;
      entries: number;
    } | null;
  }

  it('runs Claude Code with an empty config directory, removed afterwards', async () => {
    const seen = await run({});
    expect(seen).toMatchObject({ exists: true, entries: 0 });
    expect(path.basename(seen!.dir)).toMatch(/^mst-claude-/);
    expect(fs.existsSync(seen!.dir)).toBe(false);
  });

  it('isolates even when the shell exports CLAUDE_CONFIG_DIR', async () => {
    fakeClaude();
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/operator-claude');
    const result = await getHost('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code' },
      { manifest: { name: 'offline', datasets: [] } }
    );
    const seen = JSON.parse(result.finalText) as { dir: string };
    expect(path.basename(seen.dir)).toMatch(/^mst-claude-/);
  });

  it('uses your own configuration with isolate: false', async () => {
    expect(await run({ isolate: false })).toBeNull();
  });

  it('keeps an explicit CLAUDE_CONFIG_DIR', async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'own-claude-'));
    try {
      expect(await run({ env: { CLAUDE_CONFIG_DIR: own } })).toMatchObject({
        dir: own,
        exists: true,
      });
      expect(fs.existsSync(own)).toBe(true);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});
