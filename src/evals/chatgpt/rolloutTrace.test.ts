import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_LIMITS } from '../allArtifacts.js';
import { copyArtifacts } from '../trialArtifacts.js';
import { copyChatgptRolloutTrace } from './rolloutTrace.js';

let root: string;
const copies: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-desktop-trace-test-'));
});
afterEach(async () => {
  await Promise.all(
    [root, ...copies.splice(0)].map((dir) =>
      rm(dir, { recursive: true, force: true })
    )
  );
});

async function bundle(name: string, thread: string) {
  const dir = join(root, name);
  await mkdir(join(dir, 'payloads'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      root_thread_id: thread,
      raw_event_log: 'trace.jsonl',
      payloads_dir: 'payloads',
    })
  );
  await writeFile(
    join(dir, 'trace.jsonl'),
    '{"payload":{"type":"inference_started"}}\n'
  );
  await writeFile(
    join(dir, 'payloads', '1.json'),
    '{"input":"trial-private-prompt"}'
  );
  return dir;
}

async function collect(
  thread: string | undefined,
  limits = ARTIFACT_LIMITS as {
    readonly [K in keyof typeof ARTIFACT_LIMITS]: number;
  }
) {
  const result = await copyChatgptRolloutTrace(root, thread, limits);
  if (result.artifacts) copies.push(result.artifacts.dir);
  return result;
}

describe('desktop rollout trace attribution', () => {
  it('copies only the bound root thread, regardless of bundle names, and keeps native bytes', async () => {
    const source = await bundle('arbitrary-native-name', 'trial-1');
    await bundle('trace-unrelated-trial-1', 'other-chat');
    const result = await collect('trial-1');
    expect(result.telemetry).toMatchObject({ bundles: 1, files: 3 });
    expect(result.telemetry.notKept).toBeUndefined();
    const trace = join(result.artifacts!.dir, 'codex-rollout-trace');
    expect(await readdir(trace)).toEqual(['arbitrary-native-name']);
    expect(
      await readFile(
        join(trace, 'arbitrary-native-name', 'payloads', '1.json'),
        'utf8'
      )
    ).toBe(await readFile(join(source, 'payloads', '1.json'), 'utf8'));
    // A detached snapshot survives source teardown and the normal artifact copy.
    await rm(source, { recursive: true });
    const target = await mkdtemp(join(tmpdir(), 'mst-trace-final-'));
    copies.push(target);
    await copyArtifacts(result.artifacts!, target);
    await expect(access(result.artifacts!.dir)).rejects.toThrow();
    expect(
      await readFile(
        join(
          target,
          'codex-rollout-trace',
          'arbitrary-native-name',
          'payloads',
          '1.json'
        ),
        'utf8'
      )
    ).toContain('trial-private-prompt');
  });

  it('keeps all bundles rooted in this trial, including a partial failed turn', async () => {
    await bundle('root', 'trial-1');
    await bundle('child', 'trial-1');
    expect((await collect('trial-1')).telemetry).toMatchObject({
      bundles: 2,
      files: 6,
    });
  });

  it('never selects by a filename or an unbound native turn', async () => {
    await bundle('trace-trial-1', 'other');
    for (const id of ['trial-1', undefined]) {
      const result = await collect(id);
      expect(result.artifacts).toBeUndefined();
      expect(result.telemetry.notKept).toBeTruthy();
    }
  });

  it('does not follow symlinked bundles or manifests and ignores malformed/future manifests', async () => {
    const owned = await bundle('real', 'other');
    await symlink(owned, join(root, 'linked-bundle'));
    const manifest = join(owned, 'manifest.json');
    await mkdir(join(root, 'linked-manifest'));
    await symlink(manifest, join(root, 'linked-manifest', 'manifest.json'));
    await mkdir(join(root, 'malformed'));
    await writeFile(join(root, 'malformed', 'manifest.json'), '{');
    const future = await bundle('future', 'trial-1');
    await writeFile(
      join(future, 'manifest.json'),
      '{"schema_version":2,"root_thread_id":"trial-1"}'
    );
    expect((await collect('trial-1')).artifacts).toBeUndefined();
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a %s inside a matched bundle without exposing other content',
    async (kind) => {
      const dir = await bundle('matched', 'trial-1');
      const other = await bundle('other', 'other-chat');
      const from = join(other, 'payloads', '1.json');
      const to = join(dir, 'payloads', 'linked.json');
      await (kind === 'symlink' ? symlink(from, to) : link(from, to));
      const result = await collect('trial-1');
      expect(result.artifacts).toBeUndefined();
      expect(result.telemetry.notKept).toBeTruthy();
      expect(JSON.stringify(result.telemetry)).not.toContain(
        'trial-private-prompt'
      );
    }
  );

  it.each([
    ['fileBytes', 5],
    ['totalBytes', 5],
    ['entries', 3],
    ['depth', 1],
  ] as const)(
    'reports a %s limit without failing the trial',
    async (key, value) => {
      await bundle('matched', 'trial-1');
      const result = await collect('trial-1', {
        ...ARTIFACT_LIMITS,
        [key]: value,
      });
      expect(result.artifacts).toBeUndefined();
      expect(result.telemetry.notKept).toBeTruthy();
    }
  );

  it('counts top-level entries even when none belongs to the trial', async () => {
    await bundle('one', 'other');
    await bundle('two', 'other');
    expect(
      (await collect('trial-1', { ...ARTIFACT_LIMITS, entries: 1 })).telemetry
        .notKept
    ).toBe('too many trace root entries');
  });

  it('reports an unavailable source without echoing its path', async () => {
    await rm(root, { recursive: true });
    const result = await collect('trial-1');
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry.notKept).not.toContain(root);
  });
});
