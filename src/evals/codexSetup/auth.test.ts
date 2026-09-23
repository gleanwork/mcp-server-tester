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

async function fakeCodex(status = 'Logged in using an API key', code = 0) {
  await writeFile(
    codex,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ args, stdinBytes: input.length, keyOnStdin: input.toString() === 'sk-test-key\\n' }) + '\\n');
if (args.join(' ') === 'login status') { console.error(${JSON.stringify(status)}); process.exit(${code}); }
process.exit(0);
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
    expect(JSON.stringify(recorded.map((call) => call.args))).not.toContain(
      'sk-test'
    );
  });

  it.each([
    ['Not logged in', 0],
    ['Logged in using an API key', 1],
  ])('fails closed with a fixed code on status %s/%s', async (status, code) => {
    await fakeCodex(`${status} private-diagnostic`, code);
    const error: unknown = await loginWithApiKey(codex, env(), keyFile).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(CodexSetupError);
    expect(error).toMatchObject({ code: 'login_unverified' });
    expect(String(error)).not.toContain('private-diagnostic');
    expect(await calls()).toHaveLength(2);
  });

  it('never runs status after a failed login and never retries', async () => {
    await writeFile(codex, '#!/bin/sh\necho private >&2\nexit 3\n', {
      mode: 0o700,
    });
    await expect(loginWithApiKey(codex, env(), keyFile)).rejects.toMatchObject({
      code: 'login_failed',
    });
  });

  it.each(['mode', 'symlink', 'empty', 'control'])(
    'rejects an unsafe or invalid key file (%s) before spawning',
    async (kind) => {
      await fakeCodex();
      if (kind === 'mode') await chmod(keyFile, 0o640);
      if (kind === 'symlink') {
        await rm(keyFile);
        await writeFile(join(root, 'target'), 'sk-test-key', { mode: 0o600 });
        await symlink(join(root, 'target'), keyFile);
      }
      if (kind === 'empty') await writeFile(keyFile, ' \n');
      if (kind === 'control') await writeFile(keyFile, 'sk-a\u0001b');
      await expect(readApiKeyFile(keyFile)).rejects.toMatchObject({
        code:
          kind === 'mode' || kind === 'symlink'
            ? 'api_key_file_unsafe'
            : 'api_key_invalid',
      });
      await expect(
        loginWithApiKey(codex, env(), keyFile)
      ).rejects.toBeInstanceOf(CodexSetupError);
      await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );
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
      timeoutMs: 300,
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
