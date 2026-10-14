import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimContainer,
  liveContainers,
  ownerLabelArgs,
  releaseContainer,
  sweepOrphanedContainers,
} from './dockerContainers.js';

/** A Docker CLI's `ps` listing (name, owner host, owner pid) and its removals. */
function fakeDocker(rows: string[][]) {
  const removed: string[] = [];
  const calls: string[][] = [];
  return {
    removed,
    calls,
    docker: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'ps')
        return {
          code: 0,
          stdout: rows.map((row) => row.join('\t')).join('\n'),
        };
      if (args[0] === 'rm') removed.push(args.at(-1)!);
      return { code: 0, stdout: '' };
    },
  };
}

afterEach(() => {
  for (const name of liveContainers()) releaseContainer(undefined, name);
});

describe('shard containers', () => {
  it('label each container with the machine and process that started it', () => {
    expect(ownerLabelArgs({ host: 'laptop', pid: 42 })).toEqual([
      '--label',
      'mst.owner.host=laptop',
      '--label',
      'mst.owner.pid=42',
    ]);
  });

  it('remove only the containers whose owner process on this machine is gone', async () => {
    const fake = fakeDocker([
      ['mst-dead-1', 'laptop', '101'],
      ['mst-alive-1', 'laptop', '102'],
      ['mst-elsewhere-1', 'ci-runner', '101'],
      ['mst-debug-1-kept', 'laptop', '101'],
      ['mst-old-1', '', ''],
    ]);
    const result = await sweepOrphanedContainers(undefined, fake.docker, {
      host: 'laptop',
      isRunning: (pid) => pid === 102,
    });
    expect(result).toEqual({ removed: ['mst-dead-1'], unowned: ['mst-old-1'] });
    expect(fake.removed).toEqual(['mst-dead-1']);
    // Only MST's shard containers are listed.
    expect(fake.calls[0]).toContain('label=mst.run');
  });

  it("leave this process's own containers, even before their owner labels are read", async () => {
    claimContainer(undefined, 'mst-mine-1');
    const fake = fakeDocker([['mst-mine-1', 'laptop', '101']]);
    const result = await sweepOrphanedContainers(undefined, fake.docker, {
      host: 'laptop',
      isRunning: () => false,
    });
    expect(result.removed).toEqual([]);
    expect(liveContainers()).toEqual(['mst-mine-1']);
  });

  it('remove nothing when Docker cannot list containers', async () => {
    const result = await sweepOrphanedContainers(
      undefined,
      async () => ({ code: 1, stdout: '' }),
      { host: 'laptop', isRunning: () => false }
    );
    expect(result).toEqual({ removed: [], unowned: [] });
  });

  it.each(['SIGTERM', 'exit'])(
    'remove a live container when the process stops (%s)',
    (how) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-containers-'));
      const calls = path.join(dir, 'calls');
      const cli = path.join(dir, 'docker.mjs');
      // A Docker CLI that records its arguments.
      fs.writeFileSync(
        cli,
        [
          '#!/usr/bin/env node',
          "import { appendFileSync } from 'node:fs';",
          `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');`,
        ].join('\n')
      );
      fs.chmodSync(cli, 0o755);
      const module = fileURLToPath(
        new URL('./dockerContainers.ts', import.meta.url)
      );
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(module)});
           m.claimContainer('ctx-a', 'mst-run-1');
           ${how === 'SIGTERM' ? "process.kill(process.pid, 'SIGTERM'); await new Promise((r) => setTimeout(r, 5000));" : 'process.exit(3);'}`,
        ],
        { env: { ...process.env, MST_DOCKER: cli }, encoding: 'utf8' }
      );
      expect(how === 'SIGTERM' ? child.signal : child.status).toBe(
        how === 'SIGTERM' ? 'SIGTERM' : 3
      );
      expect(fs.readFileSync(calls, 'utf8')).toBe(
        '--context ctx-a rm --force mst-run-1\n'
      );
      fs.rmSync(dir, { recursive: true, force: true });
    },
    30_000
  );
});
