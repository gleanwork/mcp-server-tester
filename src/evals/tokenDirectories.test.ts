import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOKEN_DIRECTORY_PREFIX,
  claimTokenDirectory,
  liveTokenDirectoriesForTests,
  releaseTokenDirectory,
  sweepStaleTokenDirectories,
} from './tokenDirectories.js';

const moduleUrl = new URL('./tokenDirectories.ts', import.meta.url).href;
let parent: string;

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-token-dirs-'));
});
afterEach(async () => {
  for (const directory of [...liveTokenDirectoriesForTests()])
    await releaseTokenDirectory(directory);
  await fs.rm(parent, { recursive: true, force: true });
});

/** A pid that no longer runs. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return child.pid;
}

async function tokenDirectory(
  name: string,
  owner?: { pid: number } | 'garbage',
  mode = 0o700
): Promise<string> {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { mode });
  await fs.chmod(directory, mode);
  await fs.writeFile(path.join(directory, 'acme.slack.json'), '{}', {
    mode: 0o600,
  });
  if (owner)
    await fs.writeFile(
      path.join(directory, '.owner'),
      owner === 'garbage' ? 'not json' : JSON.stringify(owner)
    );
  return directory;
}

describe('sweepStaleTokenDirectories', () => {
  it('removes directories whose owner is gone, and nothing else', async () => {
    const dead = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}dead`, {
      pid: deadPid(),
    });
    const mine = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}mine`, {
      pid: process.pid,
    });
    const other = await tokenDirectory('unrelated-dir', { pid: deadPid() });
    const shared = await tokenDirectory(
      `${TOKEN_DIRECTORY_PREFIX}shared`,
      { pid: deadPid() },
      0o755
    );
    const unreadable = await tokenDirectory(
      `${TOKEN_DIRECTORY_PREFIX}garbage`,
      'garbage'
    );

    expect(await sweepStaleTokenDirectories(parent)).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    for (const kept of [mine, other, shared, unreadable])
      expect(existsSync(kept)).toBe(true);
  });

  it('removes an unowned directory only after a day', async () => {
    const unowned = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}unowned`);
    expect(await sweepStaleTokenDirectories(parent)).toEqual([]);
    const dayLater = Date.now() + 24 * 60 * 60 * 1000 + 1000;
    expect(
      await sweepStaleTokenDirectories(parent, { now: () => dayLater })
    ).toEqual([unowned]);
  });

  it('never removes a directory this process holds', async () => {
    const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}held`);
    await claimTokenDirectory(directory);
    const dayLater = Date.now() + 48 * 60 * 60 * 1000;
    expect(
      await sweepStaleTokenDirectories(parent, { now: () => dayLater })
    ).toEqual([]);
    expect(existsSync(directory)).toBe(true);
  });

  it('tolerates a missing parent', async () => {
    expect(await sweepStaleTokenDirectories(path.join(parent, 'nope'))).toEqual(
      []
    );
  });
});

describe('claim / release', () => {
  it('guards while held, and uninstalls its handlers after release', async () => {
    const before = process.listenerCount('SIGTERM');
    const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}a`);
    await claimTokenDirectory(directory);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    const owner = JSON.parse(
      await fs.readFile(path.join(directory, '.owner'), 'utf8')
    );
    expect(owner.pid).toBe(process.pid);
    await releaseTokenDirectory(directory);
    expect(existsSync(directory)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

/** A child that claims a token directory, prints READY, and waits. */
async function child(
  directory: string,
  extra = ''
): Promise<{
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: number;
  output: () => string;
}> {
  const script = `
    import { claimTokenDirectory } from ${JSON.stringify(moduleUrl)};
    await claimTokenDirectory(${JSON.stringify(directory)});
    ${extra}
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  proc.stdout.on('data', (chunk) => (output += chunk));
  proc.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child never became ready: ${output}`)),
      20_000
    );
    proc.stdout.on('data', () => {
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { exited, pid: proc.pid!, output: () => output };
}

describe('an interrupted run', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    it(`removes the token directory on ${signal} and still exits by it`, async () => {
      const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}sig`);
      const run = await child(directory);
      process.kill(run.pid, signal);
      expect(await run.exited).toEqual({ code: null, signal });
      expect(existsSync(directory)).toBe(false);
    }, 30_000);

  it("removes it but leaves stopping to the run's own handler", async () => {
    const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}own`);
    const run = await child(
      directory,
      `process.on('SIGTERM', () => { process.stdout.write('OWN\\n'); setTimeout(() => process.exit(7), 50); });`
    );
    process.kill(run.pid, 'SIGTERM');
    expect(await run.exited).toEqual({ code: 7, signal: null });
    expect(run.output()).toContain('OWN');
    expect(existsSync(directory)).toBe(false);
  }, 30_000);

  it('removes it when the run exits without stopping', async () => {
    const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}exit`);
    const run = await child(
      directory,
      `setTimeout(() => process.exit(3), 50);`
    );
    expect(await run.exited).toEqual({ code: 3, signal: null });
    expect(existsSync(directory)).toBe(false);
  }, 30_000);

  it('a killed run is swept by the next one', async () => {
    const directory = await tokenDirectory(`${TOKEN_DIRECTORY_PREFIX}kill`);
    const run = await child(directory);
    process.kill(run.pid, 'SIGKILL');
    await run.exited;
    expect(existsSync(directory)).toBe(true);
    expect(await sweepStaleTokenDirectories(parent)).toEqual([directory]);
  }, 30_000);
});
