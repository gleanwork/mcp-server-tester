import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coworkDesktopLease } from '../../../evals/cowork/desktopLease.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../index.ts', import.meta.url));
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mst-restore-cli-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run(...args: string[]) {
  return execute(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MST_CLAUDE_AI_DEBUG_PORT: 'invalid',
    },
    timeout: 15_000,
  });
}

describe('cowork restore-connectors CLI registration', () => {
  it('lists recovery separately from setup', async () => {
    const result = await run('cowork', '--help');
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('setup');
    expect(result.stdout).toContain('restore-connectors');
    expect(await readdir(home)).toEqual([]);
  });

  it('offers explicit stale-owner recovery without eval options', async () => {
    const result = await run('cowork', 'restore-connectors', '--help');
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('--recover-stale-lock');
    expect(result.stdout).not.toContain('--config');
    expect(result.stdout).not.toContain('--model');
    expect(await readdir(home)).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')(
    'reclaims an exited local process only with the explicit flag',
    async () => {
      const exited = await execute(process.execPath, [
        '-e',
        'process.stdout.write(String(process.pid))',
      ]);
      const root = join(home, '.mcp-server-tester');
      await mkdir(root, { recursive: true });
      const path = join(root, coworkDesktopLease('', 'darwin').file);
      const owner = JSON.stringify({
        pid: Number(exited.stdout),
        startedAt: new Date().toISOString(),
      });
      await writeFile(path, owner);
      await expect(run('cowork', 'restore-connectors')).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('--recover-stale-lock'),
      });
      expect(await readFile(path, 'utf8')).toBe(owner);
      const result = await run(
        'cowork',
        'restore-connectors',
        '--recover-stale-lock'
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        'No Claude account connector recovery journal'
      );
      expect(await readdir(root)).toEqual([]);
    }
  );

  it.skipIf(process.platform !== 'darwin')(
    'refuses a live local process even with the explicit flag',
    async () => {
      const root = join(home, '.mcp-server-tester');
      await mkdir(root, { recursive: true });
      const path = join(root, coworkDesktopLease('', 'darwin').file);
      const owner = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      await writeFile(path, owner);
      await expect(
        run('cowork', 'restore-connectors', '--recover-stale-lock')
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          `PID ${process.pid} is live or its status is unknown`
        ),
      });
      expect(await readFile(path, 'utf8')).toBe(owner);
      expect(await readdir(root)).toEqual([
        coworkDesktopLease('', 'darwin').file,
      ]);
    }
  );

  it.skipIf(process.platform !== 'darwin')(
    'reports no journal without Chrome or a native app',
    async () => {
      const result = await run('cowork', 'restore-connectors');
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        'No Claude account connector recovery journal was found; no settings were changed.\n'
      );
      expect(await readdir(join(home, '.mcp-server-tester'))).toEqual([]);
    }
  );
});
