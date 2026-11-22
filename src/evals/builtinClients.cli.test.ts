import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClient } from './builtinClients.js';
import type { ClientRunContext } from './evalFrameworkTypes.js';
import type * as HostReceiver from './telemetry/hostReceiver.js';

// No machine's managed settings keep the fake Claude Code's telemetry.
vi.mock('./telemetry/hostReceiver.js', async (original) => ({
  ...(await original<typeof HostReceiver>()),
  claudeCodeTelemetryClaim: () => undefined,
}));

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

describe('CLI client with a local process', () => {
  it("records Claude Code's own telemetry for its session (telemetry.host)", async () => {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const session = process.argv[process.argv.indexOf('--session-id') + 1];
const event = (name, attrs) => ({
  timeUnixNano: String(BigInt(Date.now()) * 1000000n),
  attributes: [
    { key: 'event.name', value: { stringValue: name } },
    { key: 'session.id', value: { stringValue: session } },
    ...Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
  ],
});
await fetch(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [
    event('api_request', { request_id: 'req_1', ttft_ms: 400 }),
    event('user_prompt', { prompt: 'secret' }),
  ] }] }] }),
});
console.log(JSON.stringify({ type: 'result', result: process.env.OTEL_LOG_USER_PROMPTS }));
`,
      { mode: 0o700 }
    );
    const result = await getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code' },
      {
        evalConfig: {
          name: 'offline',
          datasets: [],
          telemetry: { host: {} },
        },
        env: {},
      }
    );
    expect(result.error).toBeUndefined();
    // Asked for no content.
    expect(result.finalText).toBe('0');
    expect(
      result.hostTelemetry?.events.map((event) => [
        event.name,
        event.attributes,
      ])
    ).toEqual([
      [
        'api_request',
        expect.objectContaining({ request_id: 'req_1', ttft_ms: '400' }),
      ],
      ['user_prompt', expect.not.objectContaining({ prompt: 'secret' })],
    ]);
  });

  it('preserves environment precedence in an actual CLI command without mutation', async () => {
    vi.stubEnv('CLIENT_ENV_SHARED', 'ambient');
    vi.stubEnv('CLIENT_ENV_REMOVED', 'ambient');
    vi.stubEnv('MCP_PLUGIN_DIR', undefined);
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const keys = ['CLIENT_ENV_SHARED', 'CLIENT_ENV_CLIENT_WINS', 'CLIENT_ENV_EVAL_ONLY', 'CLIENT_ENV_REMOVED', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS'];
const env = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ env, strict: process.argv.includes('--strict-mcp-config') }) }));
`
    );
    const input = {
      prompt: 'hello',
      servers: [],
      env: {
        PATH: directory,
        CLIENT_ENV_SHARED: 'eval',
        CLIENT_ENV_CLIENT_WINS: 'eval',
        CLIENT_ENV_EVAL_ONLY: 'eval-only',
      },
    };
    const clientConfig = {
      type: 'claude-code',
      env: {
        CLIENT_ENV_SHARED: 'client',
        CLIENT_ENV_CLIENT_WINS: 'client',
        CLIENT_ENV_REMOVED: undefined,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    };
    const context: ClientRunContext = {
      evalConfig: { name: 'offline', datasets: [] },
      env: { CLIENT_ENV_SHARED: 'context' },
    };
    const before = structuredClone({ input, host: clientConfig, context });
    const result = await getClient('claude-code').run!(
      input,
      clientConfig,
      context
    );
    expect(result.error).toBeUndefined();
    const observed: {
      env: Record<string, string | null>;
      strict: boolean;
    } = JSON.parse(result.finalText ?? '');
    // The client's own env wins over the eval's and the runtime's.
    expect(observed.env).toMatchObject({
      CLIENT_ENV_SHARED: 'client',
      CLIENT_ENV_CLIENT_WINS: 'client',
      CLIENT_ENV_EVAL_ONLY: 'eval-only',
      CLIENT_ENV_REMOVED: null,
    });
    expect(observed.strict).toBe(true);
    expect(observed.env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    });
    expect({ input, host: clientConfig, context }).toEqual(before);
    expect(process.env.CLIENT_ENV_SHARED).toBe('ambient');
    expect(process.env.CLIENT_ENV_REMOVED).toBe('ambient');
  });

  it('bounds the CLI lifecycle, removes its config and stops only its owned child', async () => {
    // The fake CLI must boot Node and write its marker before the client deadline.
    // Under full-eval load that can take most of a second, so leave headroom;
    // both sleepers outlive the deadline so only the client can end the child.
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
      const pending = getClient('claude-code').run!(
        { prompt: 'hello', servers: [], env: { PATH: directory } },
        { type: 'claude-code', timeout: deadlineMs },
        { evalConfig: { name: 'offline', datasets: [] } }
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
    const result = await getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', systemPrompt: prompt },
      { evalConfig: { name: 'offline', datasets: [] } }
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
  async function run(client: Record<string, unknown>) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    fakeClaude();
    const result = await getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', ...client },
      { evalConfig: { name: 'offline', datasets: [] } }
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
    const result = await getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code' },
      { evalConfig: { name: 'offline', datasets: [] } }
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

describe('claude-code model', () => {
  async function modelArg(client: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const at = process.argv.indexOf('--model');
console.log(JSON.stringify({ type: 'result', result: at < 0 ? 'none' : process.argv[at + 1] }));
`,
      { mode: 0o700 }
    );
    const result = await getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', ...client },
      { evalConfig: { name: 'offline', datasets: [] } }
    );
    expect(result.error).toBeUndefined();
    return result.finalText;
  }

  it("uses Claude Code's own default when no model is set", async () => {
    expect(await modelArg({})).toBe('none');
  });

  it('passes the model it is given', async () => {
    expect(await modelArg({ model: 'claude-haiku-4-5' })).toBe(
      'claude-haiku-4-5'
    );
  });
});

describe('claude-code working directory', () => {
  function fakeClaude(): void {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const seen = { cwd: fs.realpathSync(process.cwd()), entries: fs.readdirSync(process.cwd()).length };
console.log(JSON.stringify({ type: 'result', result: JSON.stringify(seen) }));
`,
      { mode: 0o700 }
    );
  }
  async function run(client: Record<string, unknown>) {
    fakeClaude();
    return getClient('claude-code').run!(
      { prompt: 'hello', servers: [], env: { PATH: directory } },
      { type: 'claude-code', ...client },
      { evalConfig: { name: 'offline', datasets: [] } }
    );
  }

  it('runs Claude Code in an empty directory, removed afterwards', async () => {
    const result = await run({});
    expect(result.error).toBeUndefined();
    const seen = JSON.parse(result.finalText) as {
      cwd: string;
      entries: number;
    };
    expect(seen.entries).toBe(0);
    expect(path.basename(seen.cwd)).toMatch(/^mst-workdir-/);
    expect(seen.cwd).not.toBe(fs.realpathSync(process.cwd()));
    expect(fs.existsSync(seen.cwd)).toBe(false);
  });

  it('runs in the cwd it is given, relative to the working directory, and leaves it', async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'own-workdir-'));
    try {
      fs.writeFileSync(path.join(own, 'README.md'), 'project');
      const result = await run({ cwd: path.relative(process.cwd(), own) });
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.finalText)).toEqual({
        cwd: fs.realpathSync(own),
        entries: 1,
      });
      expect(fs.existsSync(path.join(own, 'README.md'))).toBe(true);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('says so when the cwd is not a directory', async () => {
    const missing = path.join(directory, 'missing');
    await expect(run({ cwd: missing })).rejects.toThrow(
      `claude-code: cwd ${missing} is not a directory.`
    );
  });
});

describe('claude-code raw API bodies', () => {
  const copies: string[] = [];
  afterEach(() => {
    for (const copy of copies.splice(0))
      fs.rmSync(copy, { recursive: true, force: true });
  });
  // Writes what Claude Code writes with OTEL_LOG_RAW_API_BODIES=file:<dir>,
  // unless FAKE_BODIES is none: a request with the token in it, its response
  // and the index. With host telemetry, it posts the request's event, which
  // names the request's file.
  function fakeClaude(): void {
    fs.writeFileSync(
      path.join(directory, 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const value = process.env.OTEL_LOG_RAW_API_BODIES ?? null;
  const dir = value?.startsWith('file:') ? value.slice('file:'.length) : undefined;
  if (dir && process.env.FAKE_BODIES !== 'none') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'r1.request.json'), JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'token ' + process.env.ACME_API_TOKEN }] }));
    fs.writeFileSync(path.join(dir, 'req_1.response.json'), JSON.stringify({ id: 'msg_1' }));
    fs.writeFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ message_id: 'msg_1', request_file: 'r1.request.json', response_file: 'req_1.response.json' }) + '\\n');
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (endpoint && dir) {
    const session = process.argv[process.argv.indexOf('--session-id') + 1];
    const attribute = (key, stringValue) => ({ key, value: { stringValue } });
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: String(BigInt(Date.now()) * 1000000n),
        attributes: [
          attribute('event.name', 'api_request_body'),
          attribute('session.id', session),
          attribute('body_ref', path.join(dir, 'r1.request.json')),
        ],
      }] }] }] }),
    });
  }
  console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ value }) }));
})();
`,
      { mode: 0o700 }
    );
  }
  async function run(
    client: Record<string, unknown>,
    env: Record<string, string> = {},
    context: ClientRunContext = {
      evalConfig: { name: 'offline', datasets: [] },
    }
  ) {
    fakeClaude();
    const result = await getClient('claude-code').run!(
      {
        prompt: 'hello',
        servers: [],
        env: { PATH: directory, ACME_API_TOKEN: 'acme-secret-123456', ...env },
      },
      { type: 'claude-code', ...client },
      context
    );
    if (result.artifacts) copies.push(result.artifacts.dir);
    expect(result.error).toBeUndefined();
    return {
      result,
      value: (JSON.parse(result.finalText) as { value: string | null }).value,
    };
  }

  it('keeps the bodies Claude Code wrote, redacted, as client artifacts, and removes its own directories', async () => {
    // The trial's directories are all made here: only the copy is left.
    const tmp = fs.mkdtempSync(path.join(directory, 'tmp-'));
    vi.stubEnv('TMPDIR', tmp);
    const { result, value } = await run({});
    expect(value).toMatch(
      /^file:.+\/mst-claude-bodies-[^/]+\/claude-raw-api-bodies$/
    );
    expect(value!.startsWith(`file:${tmp}${path.sep}`)).toBe(true);
    expect(result.telemetry?.rawApiBodies).toEqual({
      requests: 1,
      responses: 1,
      files: 3,
      bytes: expect.any(Number),
    });
    expect(result.artifacts).toMatchObject({
      include: ['claude-raw-api-bodies'],
      temporary: true,
    });
    const copy = path.join(result.artifacts!.dir, 'claude-raw-api-bodies');
    expect(fs.readdirSync(copy).sort()).toEqual([
      'index.jsonl',
      'r1.request.json',
      'req_1.response.json',
    ]);
    const request = fs.readFileSync(path.join(copy, 'r1.request.json'), 'utf8');
    expect(request).toContain('[REDACTED]');
    expect(request).not.toContain('acme-secret-123456');
    expect(fs.readdirSync(tmp)).toEqual([path.basename(result.artifacts!.dir)]);
  });

  it('keeps none with rawApiBodies: false', async () => {
    vi.stubEnv('OTEL_LOG_RAW_API_BODIES', undefined);
    const { result, value } = await run({ rawApiBodies: false });
    expect(value).toBeNull();
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry?.rawApiBodies).toBeUndefined();
  });

  it('writes them in a directory of its own over one the shell names', async () => {
    vi.stubEnv('OTEL_LOG_RAW_API_BODIES', `file:${directory}`);
    const { result, value } = await run({});
    expect(value).toMatch(/\/mst-claude-bodies-[^/]+\/claude-raw-api-bodies$/);
    expect(result.telemetry?.rawApiBodies).toMatchObject({
      requests: 1,
      responses: 1,
    });
  });

  it("leaves them where the client's env names, and keeps none", async () => {
    const own = path.join(directory, 'own-bodies');
    const { result, value } = await run({
      env: { OTEL_LOG_RAW_API_BODIES: `file:${own}` },
    });
    expect(value).toBe(`file:${own}`);
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry?.rawApiBodies).toEqual({
      notKept:
        "The client's env sets OTEL_LOG_RAW_API_BODIES, so Claude Code wrote its raw API bodies where that says, and MST kept none.",
    });
    expect(fs.readdirSync(own).sort()).toEqual([
      'index.jsonl',
      'r1.request.json',
      'req_1.response.json',
    ]);
  });

  it('says so when Claude Code wrote none', async () => {
    const { result } = await run({}, { FAKE_BODIES: 'none' });
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry?.rawApiBodies).toEqual({
      requests: 0,
      responses: 0,
      notKept:
        'Claude Code wrote no raw API bodies. Claude Code 2.1.274 or later writes them, unless managed settings turn them off.',
    });
  });

  it("names each body event's file as it is in the trial's artifacts (telemetry.host)", async () => {
    const { result } = await run({}, undefined, {
      evalConfig: { name: 'offline', datasets: [], telemetry: { host: {} } },
      env: {},
    });
    expect(result.hostTelemetry?.events).toEqual([
      expect.objectContaining({
        name: 'api_request_body',
        attributes: expect.objectContaining({
          body_ref: 'claude-raw-api-bodies/r1.request.json',
        }),
      }),
    ]);
    expect(
      fs.existsSync(
        path.join(
          result.artifacts!.dir,
          'claude-raw-api-bodies',
          'r1.request.json'
        )
      )
    ).toBe(true);
  });
});
