import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginWithApiKey, readApiKeyFile } from './auth.js';
import { CodexSetupError, runBounded, signalGroup } from './native.js';

let root: string;
let codex: string;
let keyFile: string;
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root });

async function fakeCodex(
  status = 'Logged in using an API key',
  code = 0,
  loginExit = 0
) {
  await writeFile(
    codex,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ args, stdinBytes: input.length, keyOnStdin: input.toString() === 'sk-test-key\\n' }) + '\\n');
if (args.join(' ') === 'login status') { console.error(${JSON.stringify(status)}); process.exit(${code}); }
process.exit(${loginExit});
`,
    { mode: 0o700 }
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-codex-auth-'));
  codex = join(root, 'codex.cjs');
  keyFile = join(root, 'key');
  await writeFile(keyFile, '  sk-test-key\n', { mode: 0o600 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function calls() {
  return (await readFile(join(root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; keyOnStdin: boolean });
}

describe('native API-key login', () => {
  it('feeds the key on stdin only, then verifies login status', async () => {
    await fakeCodex();
    await expect(loginWithApiKey(codex, env(), keyFile)).resolves.toEqual({
      loginVerified: true,
      method: 'api-key',
    });
    const recorded = await calls();
    expect(recorded.map((call) => call.args)).toEqual([
      ['login', '--with-api-key'],
      ['login', 'status'],
    ]);
    expect(recorded[0]!.keyOnStdin).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('sk-test');
  });

  // Status never runs after a failed login, and nothing is retried.
  it.each([
    ['Not logged in', 0, 0, 'login_unverified', 2],
    ['Logged in using an API key', 1, 0, 'login_unverified', 2],
    ['Logged in using an API key', 0, 3, 'login_failed', 1],
  ])(
    'fails closed on %s/%s, login %s',
    async (status, exit, login, code, n) => {
      await fakeCodex(`${status} private-diagnostic`, exit, login);
      const error = await loginWithApiKey(codex, env(), keyFile).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(CodexSetupError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain('private-diagnostic');
      expect(await calls()).toHaveLength(n);
    }
  );

  async function symlinkKey() {
    await rm(keyFile);
    await writeFile(join(root, 'target'), 'sk-test-key', { mode: 0o600 });
    await symlink(join(root, 'target'), keyFile);
  }
  it.each([
    ['mode', 'api_key_file_unsafe', () => chmod(keyFile, 0o640)],
    ['symlink', 'api_key_file_unsafe', symlinkKey],
    ['empty', 'api_key_invalid', () => writeFile(keyFile, ' \n')],
    ['control', 'api_key_invalid', () => writeFile(keyFile, 'sk-a\u0001b')],
  ])('rejects a %s key file with %s before spawning', async (_, code, fn) => {
    await fakeCodex();
    await fn();
    await expect(readApiKeyFile(keyFile)).rejects.toMatchObject({ code });
    const login = loginWithApiKey(codex, env(), keyFile);
    await expect(login).rejects.toMatchObject({ code });
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toThrow();
  });
});

describe('bounded native commands', () => {
  it('kills the owned process group on timeout', async () => {
    const script = join(root, 'sleep.sh');
    await writeFile(
      script,
      `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(join(root, 'child'))}\nwait\n`,
      { mode: 0o700 }
    );
    const result = await runBounded(script, [], {
      env: env(),
      cwd: root,
      timeoutMs: 2000,
      maxOutputBytes: 0,
    });
    expect(result.failure).toBe('timeout');
    const child = Number(await readFile(join(root, 'child'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(child, 0)).toThrow();
  });

  it('bounds captured output', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(100000))'],
      { env: env(), cwd: root, timeoutMs: 10_000, maxOutputBytes: 1024 }
    );
    expect(result.failure).toBe('output_limit');
    expect(result.output.length).toBeLessThanOrEqual(1024);
  });

  it('reports a missing group as stopped', () => {
    expect(signalGroup(2 ** 22 - 3, 0)).toBe(false);
  });
});
