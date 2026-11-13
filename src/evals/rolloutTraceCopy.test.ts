import type * as FsPromises from 'node:fs/promises';
import {
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
import {
  copyRolloutTrace,
  ROLLOUT_TRACE_DIR,
  RolloutTraceError,
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
