import type * as FsPromises from 'node:fs/promises';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_LIMITS } from './allArtifacts.js';
import {
  copyRolloutTrace,
  keepRolloutTrace,
  ROLLOUT_TRACE_DIR,
  RolloutTraceError,
  type ArtifactLimits,
} from './rolloutTraceCopy.js';

const fsHooks = vi.hoisted(() => ({
  afterReaddir: undefined as ((dir: string) => Promise<void>) | undefined,
}));

// Lets a test change the trace between the copy's own reads, as an agent
// still running could.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    const listed = await actual.readdir(...args);
    await fsHooks.afterReaddir?.(String(args[0]));
    return listed;
  }) as typeof actual.readdir;
  return { ...actual, readdir };
});

describe('copyRolloutTrace', () => {
  let dir: string;
  let root: string;
  let elsewhere: string;
  const bundle = 'trace-t1-thread-9';
  const payloads = () => join(root, bundle, 'payloads');
  /** Swaps `payloads/` for a link to a directory outside the trace. */
  const swapPayloads = async () => {
    await rename(payloads(), join(root, bundle, 'payloads-moved'));
    await symlink(elsewhere, payloads());
  };
  const expectUnsafe = async (message: string) => {
    const copying = copyRolloutTrace(root, [bundle]);
    await expect(copying).rejects.toBeInstanceOf(RolloutTraceError);
    await expect(copying).rejects.toMatchObject({ kind: 'unsafe', message });
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mst-rollout-trace-copy-test-'));
    root = join(dir, ROLLOUT_TRACE_DIR);
    await mkdir(join(root, bundle, 'payloads'), { recursive: true });
    await writeFile(join(root, bundle, 'manifest.json'), '{}');
    await writeFile(join(root, bundle, 'payloads', '1.json'), '{}');
    elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'config.toml'), 'api_key = "sk-secret"');
  });
  afterEach(async () => {
    fsHooks.afterReaddir = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('copies a bundle of directories and regular files', async () => {
    const copy = await copyRolloutTrace(root, [bundle]);
    try {
      expect(copy).toMatchObject({ files: 2, bytes: 4 });
      expect(
        await readdir(join(copy.dir, ROLLOUT_TRACE_DIR, bundle, 'payloads'))
      ).toEqual(['1.json']);
    } finally {
      await rm(copy.dir, { recursive: true, force: true });
    }
  });

  it('does not copy a bundle it is given that is a symbolic link', async () => {
    await symlink(elsewhere, join(root, 'trace-linked'));
    const copying = copyRolloutTrace(root, ['trace-linked']);
    await expect(copying).rejects.toMatchObject({
      kind: 'unsafe',
      message: 'trace-linked is a symbolic link',
    });
  });

  it('does not copy a trace whose root is a symbolic link', async () => {
    await rename(root, join(dir, 'real-root'));
    await symlink(join(dir, 'real-root'), root);
    await expectUnsafe('the trace root is a symbolic link');
  });

  it('does not follow a directory swapped for a link after it was listed', async () => {
    fsHooks.afterReaddir = async (listed) => {
      if (listed !== join(root, bundle)) return;
      fsHooks.afterReaddir = undefined;
      await swapPayloads();
    };
    await expectUnsafe(`${bundle}/payloads is a symbolic link`);
  });

  it('does not keep what it listed of a directory swapped while it listed it', async () => {
    fsHooks.afterReaddir = async (listed) => {
      if (listed !== payloads()) return;
      fsHooks.afterReaddir = undefined;
      await swapPayloads();
    };
    await expectUnsafe(`${bundle}/payloads changed while it was copied`);
  });

  it('does not keep a trace whose root was swapped while it was copied', async () => {
    fsHooks.afterReaddir = async (listed) => {
      if (listed !== payloads()) return;
      fsHooks.afterReaddir = undefined;
      await rename(root, join(dir, 'real-root'));
      await symlink(join(dir, 'real-root'), root);
    };
    // The bundle's path now goes through the link, to the same directory:
    // the root's own check is what fails.
    await expectUnsafe('the trace root changed while it was copied');
  });
});

describe('keepRolloutTrace', () => {
  let root: string;
  const kept: string[] = [];
  const noTrace = 'no trace';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mst-keep-rollout-trace-test-'));
  });
  afterEach(async () => {
    for (const dir of [root, ...kept.splice(0)])
      await rm(dir, { recursive: true, force: true });
  });
  /** A bundle whose manifest names `thread` as its root thread. */
  const bundle = async (name: string, thread: string, manifest?: string) => {
    const at = join(root, name);
    await mkdir(join(at, 'payloads'), { recursive: true });
    await writeFile(
      join(at, 'manifest.json'),
      manifest ?? JSON.stringify({ schema_version: 1, root_thread_id: thread })
    );
    await writeFile(join(at, 'payloads', '1.json'), `{"thread":"${thread}"}`);
    return at;
  };
  const keep = async (
    rootThreadId?: string,
    limits: ArtifactLimits = ARTIFACT_LIMITS
  ) => {
    const trace = await keepRolloutTrace(root, {
      noTrace,
      rootThreadId,
      limits,
    });
    if (trace.artifacts) kept.push(trace.artifacts.dir);
    return trace;
  };
  const keptBundles = async (trace: Awaited<ReturnType<typeof keep>>) =>
    readdir(join(trace.artifacts!.dir, ROLLOUT_TRACE_DIR));

  it('keeps every bundle with a manifest when the root is the trial’s own', async () => {
    await bundle('trace-a', 'thread-1');
    await bundle('trace-b', 'thread-2');
    await mkdir(join(root, 'not-a-bundle'));
    await writeFile(join(root, 'stray.json'), '{}');
    const trace = await keep();
    expect(trace.telemetry).toMatchObject({ bundles: 2, files: 4 });
    expect(await keptBundles(trace)).toEqual(['trace-a', 'trace-b']);
  });

  it('in a shared root, keeps only the bundles whose manifest names the root thread, whatever their names', async () => {
    await bundle('native-name', 'trial-1');
    await bundle('child', 'trial-1');
    await bundle('trace-trial-1', 'other-chat');
    const trace = await keep('trial-1');
    expect(trace.telemetry).toMatchObject({ bundles: 2, files: 4 });
    expect(await keptBundles(trace)).toEqual(['child', 'native-name']);
  });

  it('reads the version-2 manifest Codex 0.167 writes', async () => {
    // As ChatGPT 26.1103's bundled Codex wrote it.
    await bundle(
      'trace-1-trial-1',
      'trial-1',
      JSON.stringify({
        schema_version: 2,
        trace_id: '070d2c27-482a-4a28-8814-cbdadf34932d',
        rollout_id: 'trial-1',
        root_thread_id: 'trial-1',
        started_at_unix_ms: 1794545207671,
        raw_event_log: 'trace.jsonl',
        payloads_dir: 'payloads',
      })
    );
    const trace = await keep('trial-1');
    expect(trace.telemetry).toMatchObject({ bundles: 1, files: 2 });
    expect(await keptBundles(trace)).toEqual(['trace-1-trial-1']);
  });

  it('says when the thread’s bundle has a manifest version it doesn’t read, not that there is no trace', async () => {
    await bundle(
      'future',
      'trial-1',
      '{"schema_version":3,"root_thread_id":"trial-1"}'
    );
    // Another chat's unknown version is not the trial's.
    await bundle(
      'other-future',
      'other-chat',
      '{"schema_version":4,"root_thread_id":"other-chat"}'
    );
    expect(await keep('trial-1')).toEqual({
      telemetry: {
        bundles: 0,
        notKept:
          "The rollout trace's manifest is a version MST doesn't read (schema_version 3).",
      },
    });
  });

  it('never takes a linked bundle, a linked manifest, or one it can’t parse', async () => {
    const other = await bundle('other', 'other-chat');
    const elsewhere = await mkdtemp(join(tmpdir(), 'mst-keep-elsewhere-'));
    kept.push(elsewhere);
    await mkdir(join(elsewhere, 'trace-x'));
    await writeFile(
      join(elsewhere, 'trace-x', 'manifest.json'),
      JSON.stringify({ schema_version: 1, root_thread_id: 'trial-1' })
    );
    await symlink(join(elsewhere, 'trace-x'), join(root, 'linked-bundle'));
    await mkdir(join(root, 'linked-manifest'));
    await symlink(
      join(other, 'manifest.json'),
      join(root, 'linked-manifest', 'manifest.json')
    );
    await mkdir(join(root, 'hard-linked-manifest'));
    await writeFile(
      join(root, 'trial-manifest.json'),
      JSON.stringify({ schema_version: 1, root_thread_id: 'trial-1' })
    );
    await link(
      join(root, 'trial-manifest.json'),
      join(root, 'hard-linked-manifest', 'manifest.json')
    );
    await bundle('malformed', 'trial-1', '{');
    expect(await keep('trial-1')).toEqual({
      telemetry: { bundles: 0, notKept: noTrace },
    });
  });

  it('counts every entry of a shared root, the other chats’ too', async () => {
    await bundle('one', 'other');
    await bundle('two', 'other');
    expect(
      (await keep('trial-1', { ...ARTIFACT_LIMITS, entries: 1 })).telemetry
    ).toEqual({
      notKept:
        "The rollout trace is larger than a trial's artifacts may be: the trace root has more than 1 entries.",
    });
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    "says MST couldn't read a manifest it couldn't open, not that the bundle is another chat's",
    async () => {
      const dir = await bundle('matched', 'trial-1');
      await chmod(join(dir, 'manifest.json'), 0o000);
      expect((await keep('trial-1')).telemetry).toEqual({
        notKept: expect.stringMatching(
          /^MST couldn't read the rollout trace: EACCES/
        ),
      });
    }
  );

  it('says there is no trace only when the root is missing', async () => {
    await rm(root, { recursive: true });
    expect(await keep('trial-1')).toEqual({
      telemetry: { bundles: 0, notKept: noTrace },
    });
  });
});
