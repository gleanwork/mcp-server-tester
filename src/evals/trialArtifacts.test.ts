import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_LIMITS,
  copyArtifacts,
  withCopiedArtifacts,
} from './trialArtifacts.js';
import { trialArtifactsPath } from './runFormat.js';
import type { CaseExecution } from './caseExecution.js';
import type { EvalCase } from './datasetTypes.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-artifacts-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

async function listed(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('copyArtifacts', () => {
  it('copies only what include names, with * within one name', async () => {
    const source = await tree({
      'audit.jsonl': '{}',
      '.audit-key': 'secret',
      'outputs/report.md': 'r',
      'outputs/sub/chart.png': 'c',
      // Claude's project settings in its working directory.
      'outputs/.claude/settings.local.json': 'settings',
      'outputs/.env': 'TOKEN=secret',
      '.hidden/x.jsonl': 'no',
      '.claude/.claude.json': 'settings',
      '.claude/backups/x': 'b',
      '.claude/projects/p1/s1.jsonl': 't',
      '.claude/projects/p1/s1/tool-results/a.txt': 'a',
      '.claude/projects/p1/s1/other.txt': 'no',
      'unexpected/credentials.json': 'secret',
    });
    const target = path.join(await tree({}), 'copy');
    await copyArtifacts(
      {
        dir: source,
        include: [
          'audit.jsonl',
          'outputs',
          '.claude/projects/*/*.jsonl',
          '.claude/projects/*/*/tool-results',
        ],
      },
      target
    );
    expect(await listed(target)).toEqual([
      '.claude/projects/p1/s1.jsonl',
      '.claude/projects/p1/s1/tool-results/a.txt',
      'audit.jsonl',
      'outputs/report.md',
      'outputs/sub/chart.png',
    ]);
  });

  it('** copies everything, hidden names too', async () => {
    const source = await tree({
      '.claude/projects/p/s.jsonl': 't',
      'outputs/.hidden': 'h',
    });
    const target = path.join(await tree({}), 'copy');
    await copyArtifacts({ dir: source, include: ['**'] }, target);
    expect(await listed(target)).toEqual([
      '.claude/projects/p/s.jsonl',
      'outputs/.hidden',
    ]);
  });

  it('never copies a link, and refuses a root that is one', async () => {
    const outside = await tree({ 'secret.txt': 's' });
    const source = await tree({ 'outputs/a.txt': 'a' });
    await fs.symlink(outside, path.join(source, 'outputs', 'dir-link'));
    await fs.symlink(
      path.join(outside, 'secret.txt'),
      path.join(source, 'outputs', 'file-link')
    );
    const target = path.join(await tree({}), 'copy');
    await copyArtifacts({ dir: source, include: ['outputs'] }, target);
    expect(await listed(target)).toEqual(['outputs/a.txt']);

    const linked = path.join(await tree({}), 'session');
    await fs.symlink(source, linked);
    const second = path.join(await tree({}), 'copy');
    await expect(
      copyArtifacts({ dir: linked, include: ['outputs'] }, second)
    ).rejects.toThrow('not a directory');
    await expect(fs.stat(second)).rejects.toThrow();
  });

  it('rejects include paths that could leave the directory', async () => {
    const source = await tree({ 'a.txt': 'a' });
    for (const include of ['../x', '/etc', 'a/./b', ''])
      await expect(
        copyArtifacts(
          { dir: source, include: [include] },
          path.join(source, 'copy')
        )
      ).rejects.toThrow('must be relative');
  });

  it('fails over a limit, leaving no copy', async () => {
    const limits = { fileBytes: 10, totalBytes: 25, entries: 20, depth: 3 };
    const copy = (dir: string, target: string) =>
      copyArtifacts({ dir, include: ['outputs'] }, target, limits);
    const target = path.join(await tree({}), 'copy');

    const big = await tree({
      'outputs/a.txt': 'a',
      'outputs/big.bin': 'x'.repeat(11),
    });
    await expect(copy(big, target)).rejects.toThrow(
      'outputs/big.bin is larger than 10 bytes'
    );
    await expect(fs.stat(target)).rejects.toThrow();

    const total = await tree(
      Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`outputs/${i}`, 'x'.repeat(10)])
      )
    );
    await expect(copy(total, target)).rejects.toThrow(
      'it holds more than 25 bytes'
    );
    await expect(fs.stat(target)).rejects.toThrow();

    const wide = await tree(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`outputs/${i}`, ''])
      )
    );
    await expect(copy(wide, target)).rejects.toThrow(
      'it has more than 20 entries'
    );

    const deep = await tree({ 'outputs/d/d/d/f': 'x' });
    await expect(copy(deep, target)).rejects.toThrow(
      'it is more than 3 directories deep'
    );
    // Within the limits, the same tree copies.
    await copyArtifacts({ dir: deep, include: ['outputs'] }, target, {
      ...limits,
      depth: 4,
    });
    expect(await listed(target)).toEqual(['outputs/d/d/d/f']);
  });

  it('defaults to the limits of the native audit', () => {
    expect(ARTIFACT_LIMITS).toEqual({
      fileBytes: 16 * 1024 * 1024,
      totalBytes: 64 * 1024 * 1024,
      entries: 4096,
      depth: 16,
    });
  });
});

describe('withCopiedArtifacts', () => {
  it("leaves a resumed run's stored copy where it is", async () => {
    const root = await tree({
      [`${trialArtifactsPath('v', 'c1', 0)}/outputs/report.md`]: 'r',
    });
    const stored = path.join(root, trialArtifactsPath('v', 'c1', 0));
    const execute = withCopiedArtifacts(
      async () =>
        ({
          kind: 'completed',
          response: {
            response: 'ok',
            artifacts: { dir: stored, include: ['**'] },
          },
        }) as unknown as CaseExecution,
      root,
      'v'
    );
    const execution = await execute({ id: 'c1' } as EvalCase);
    expect(execution.error).toBeUndefined();
    expect(
      (execution as { response: { artifacts?: { dir: string } } }).response
        .artifacts?.dir
    ).toBe(stored);
    expect(await listed(root)).toEqual([
      `${trialArtifactsPath('v', 'c1', 0)}/outputs/report.md`,
    ]);
  });
});
