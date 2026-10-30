import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withOptimizationLock } from './optimizationLock.js';

let directory: string;
let lock: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-lock-'));
  lock = path.join(directory, 'lock');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** A lock file left by a process on this machine that no longer runs. */
async function writeDeadLock(): Promise<void> {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  await fs.writeFile(
    lock,
    JSON.stringify({
      pid: gone,
      host: os.hostname(),
      since: new Date().toISOString(),
      step: 'run a round',
    })
  );
}

describe('withOptimizationLock', () => {
  it('lets one of two processes take over a dead holder’s lock', async () => {
    await writeDeadLock();
    let inside = 0;
    let most = 0;
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function step(): Promise<string> {
      inside++;
      entered = true;
      most = Math.max(most, inside);
      await held;
      inside--;
      return 'done';
    }
    // The interleaving that let both in: both read the dead holder before
    // either removes its lock, and the second removal comes after the first
    // contender has created its own lock and started.
    let reads = 0;
    let removals = 0;
    const readFile = fs.readFile.bind(fs);
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(((file, options) => {
      if (file === lock) reads++;
      return readFile(file, options);
    }) as typeof fs.readFile);
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (file === lock) {
        removals++;
        await until(removals === 1 ? () => reads >= 2 : () => entered);
      }
      return rm(file, options);
    });
    const settled = Promise.allSettled([
      withOptimizationLock(directory, 'opt', 'run a round', step),
      withOptimizationLock(directory, 'opt', 'run a round', step),
    ]);
    await until(() => entered);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await settled;
    expect(most).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /in use/
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it('leaves a lock another holder wrote since', async () => {
    const other = {
      pid: process.pid,
      host: os.hostname(),
      since: new Date().toISOString(),
      step: 'finish',
      token: 'another holder',
    };
    await withOptimizationLock(directory, 'opt', 'run a round', async () => {
      // Another process took over this lock while this one ran.
      await fs.writeFile(lock, JSON.stringify(other));
    });
    expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toEqual(other);
  });

  it('refuses a lock whose holder still runs', async () => {
    await fs.writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        since: new Date().toISOString(),
        step: 'finish',
      })
    );
    await expect(
      withOptimizationLock(directory, 'opt', 'run a round', async () => 'ran')
    ).rejects.toThrow(new RegExp(`in use: process ${process.pid}`));
  });
});
