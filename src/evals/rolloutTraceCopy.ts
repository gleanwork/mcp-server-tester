/**
 * A trial's copy of a Codex rollout trace (the bundles Codex writes under
 * `CODEX_ROLLOUT_TRACE_ROOT`), made before the trial reports it as its client
 * artifacts. Any client whose agent writes such a trace can collect it here.
 *
 * The agent can write where its trace is, so the copy trusts none of it.
 * It copies only directories and regular files MST's user owns, never a hard
 * link (a link to the trial's `config.toml` would otherwise outlive the
 * trial's home), and replaces every credential MST knows for the trial, as
 * the transcript does. It opens each directory (the trace root, each bundle
 * and each directory in one) and each file without following a symbolic link
 * at its name. After it lists a directory, and after it reads each file in
 * one, it checks that the directory's path still leads to the directory it
 * opened, so a directory swapped for a link while it copies keeps the trace
 * from being kept. Node has no `openat`, so the copy reads through paths: an
 * agent that swaps a directory for a link and back between two of those
 * checks can still have it read a file elsewhere that MST's user owns. It
 * copies into a directory of its own, within `ARTIFACT_LIMITS` as the
 * artifact copy counts them (trialArtifacts.ts), so what it returns fits.
 */
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_LIMITS } from './allArtifacts.js';
import {
  redactClientSecretBytes,
  redactClientSecrets,
} from './clientSecrets.js';
import type { ClientArtifacts } from './evalFrameworkTypes.js';

/** The directory the copy keeps the trace's bundles in. */
export const ROLLOUT_TRACE_DIR = 'codex-rollout-trace';

export type ArtifactLimits = {
  readonly [K in keyof typeof ARTIFACT_LIMITS]: number;
};

/**
 * Why a trace can't be kept, in words that are safe to report: it is over
 * one of the artifact limits (`limit`), or it holds a file MST won't copy
 * (`unsafe`). Any other error is a failure to read the trace.
 */
export class RolloutTraceError extends Error {
  constructor(
    readonly kind: 'limit' | 'unsafe',
    message: string
  ) {
    super(message);
    this.name = 'RolloutTraceError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissingPath(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

/**
 * Why a trace wasn't kept, from what selecting or copying it threw: a limit,
 * an entry MST doesn't copy, or a failure to read it, with the error. Every
 * value in `secrets` is redacted.
 */
function rolloutTraceNotKept(
  error: unknown,
  secrets: readonly string[] = []
): string {
  const reason = redactClientSecrets(
    error instanceof Error ? error.message : String(error),
    secrets
  );
  if (!(error instanceof RolloutTraceError))
    return `MST couldn't read the rollout trace: ${reason}`;
  return error.kind === 'limit'
    ? `The rollout trace is larger than a trial's artifacts may be: ${reason}.`
    : `The rollout trace holds an entry MST doesn't copy: ${reason}.`;
}

function checkOwner(stats: BigIntStats): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== BigInt(uid))
    throw new RolloutTraceError('unsafe', "isn't owned by MST's user");
}

/** Which directory a path led to: its device and inode. */
type DirId = { readonly dev: bigint; readonly ino: bigint };

/**
 * Which directory `dir` is, a directory MST's user owns, opened without
 * following a symbolic link at its name.
 */
async function openTraceDir(dir: string): Promise<DirId> {
  let handle;
  try {
    handle = await open(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error) {
    // Linux reports a link opened as a directory as ENOTDIR, macOS as ELOOP.
    const code = errorCode(error);
    if (
      code === 'ELOOP' ||
      (code === 'ENOTDIR' &&
        (await lstat(dir).catch(() => undefined))?.isSymbolicLink())
    )
      throw new RolloutTraceError('unsafe', 'is a symbolic link');
    throw error;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory())
      throw new RolloutTraceError('unsafe', 'is not a directory');
    checkOwner(stats);
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

/** Fails unless `dir` still leads to the directory {@link openTraceDir} opened. */
async function checkTraceDir(dir: string, id: DirId): Promise<void> {
  const stats = await lstat(dir, { bigint: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return undefined;
    throw error;
  });
  if (!stats?.isDirectory() || stats.dev !== id.dev || stats.ino !== id.ino)
    throw new RolloutTraceError('unsafe', 'changed while it was copied');
}

/** `fn`, with `name` before the message of a {@link RolloutTraceError}. */
async function labelled<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RolloutTraceError)
      throw new RolloutTraceError(error.kind, `${name} ${error.message}`);
    throw error;
  }
}

/**
 * The bytes of `file`, a regular file with one link that MST's user owns,
 * of at most `maxBytes`. Never opens a symbolic link, and doesn't block on a
 * pipe. Fails when the file changes while it is read.
 */
async function readTraceFile(file: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (errorCode(error) === 'ELOOP')
      throw new RolloutTraceError('unsafe', 'is a symbolic link');
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new RolloutTraceError('unsafe', 'is not a regular file');
    if (before.nlink !== 1n)
      throw new RolloutTraceError('unsafe', 'is a hard link');
    checkOwner(before);
    if (before.size > BigInt(maxBytes))
      throw new RolloutTraceError('limit', `is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!bytesRead)
        throw new RolloutTraceError('unsafe', 'changed while it was copied');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs)
      throw new RolloutTraceError('unsafe', 'changed while it was copied');
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Copy `bundles` (names of directories in `root`) into a new temporary
 * directory, as `<dir>/codex-rollout-trace/<bundle>/`, with `secrets`
 * replaced in every file. Entries other than directories and regular files
 * are left out, as the artifact copy leaves them out; `root` and `bundles`
 * themselves must be directories. Fails, leaving no directory, with a
 * {@link RolloutTraceError} for a limit or an entry MST won't copy, or with
 * the error that kept it from reading the trace.
 */
export async function copyRolloutTrace(
  root: string,
  bundles: readonly string[],
  options: {
    readonly secrets?: readonly string[];
    readonly limits?: ArtifactLimits;
  } = {}
): Promise<{ dir: string; files: number; bytes: number }> {
  const limits = options.limits ?? ARTIFACT_LIMITS;
  const secrets = options.secrets ?? [];
  const target = await mkdtemp(path.join(os.tmpdir(), 'mst-rollout-trace-'));
  // As the artifact copy counts them: it visits ROLLOUT_TRACE_DIR first.
  let entries = 1;
  let files = 0;
  let bytes = 0;
  const countEntry = () => {
    if (++entries > limits.entries)
      throw new RolloutTraceError(
        'limit',
        `it has more than ${limits.entries} entries`
      );
  };
  const walk = async (
    source: string,
    segments: readonly string[]
  ): Promise<void> => {
    if (segments.length > limits.depth)
      throw new RolloutTraceError(
        'limit',
        `it is more than ${limits.depth} directories deep`
      );
    const dirName = segments.slice(1).join('/');
    const id = await labelled(dirName, () => openTraceDir(source));
    await mkdir(path.join(target, ...segments), {
      recursive: true,
      mode: 0o700,
    });
    const listed = await readdir(source, { withFileTypes: true });
    // What it listed is the directory it opened.
    await labelled(dirName, () => checkTraceDir(source, id));
    for (const entry of listed) {
      countEntry();
      const from = path.join(source, entry.name);
      const at = [...segments, entry.name];
      if (entry.isDirectory()) {
        await walk(from, at);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = at.slice(1).join('/');
      const data = redactClientSecretBytes(
        await labelled(name, () => readTraceFile(from, limits.fileBytes)),
        secrets
      );
      // The file it read is in the directory it opened.
      await labelled(dirName, () => checkTraceDir(source, id));
      // Measured as written: a redacted file can be longer than Codex's.
      if (data.length > limits.fileBytes)
        throw new RolloutTraceError(
          'limit',
          `${name} is larger than ${limits.fileBytes} bytes`
        );
      bytes += data.length;
      if (bytes > limits.totalBytes)
        throw new RolloutTraceError(
          'limit',
          `it holds more than ${limits.totalBytes} bytes`
        );
      await writeFile(path.join(target, ...at), data, {
        flag: 'wx',
        mode: 0o600,
      });
      files += 1;
    }
  };
  try {
    const rootId = await labelled('the trace root', () => openTraceDir(root));
    for (const bundle of bundles) {
      countEntry();
      await walk(path.join(root, bundle), [ROLLOUT_TRACE_DIR, bundle]);
    }
    await labelled('the trace root', () => checkTraceDir(root, rootId));
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { dir: target, files, bytes };
}

/** A manifest names a bundle's threads; it is never this large. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * Whether the bundle `dir` has a `manifest.json`, and, with `rootThreadId`,
 * whether its version-1 manifest names that thread as the root thread. A
 * filename is not attribution. A manifest MST won't read (a link, a hard
 * link, another user's file, too large) or can't parse is another chat's or
 * not a bundle's; any other error reading it is thrown, so it isn't taken
 * for no trace.
 */
async function isBundle(
  dir: string,
  rootThreadId: string | undefined
): Promise<boolean> {
  const file = path.join(dir, 'manifest.json');
  try {
    if (rootThreadId === undefined) {
      await lstat(file);
      return true;
    }
    const manifest: unknown = JSON.parse(
      (await readTraceFile(file, MAX_MANIFEST_BYTES)).toString('utf8')
    );
    if (typeof manifest !== 'object' || manifest === null) return false;
    const { schema_version, root_thread_id } = manifest as Record<
      string,
      unknown
    >;
    return schema_version === 1 && root_thread_id === rootThreadId;
  } catch (error) {
    if (
      isMissingPath(error) ||
      error instanceof RolloutTraceError ||
      error instanceof SyntaxError
    )
      return false;
    throw error;
  }
}

/**
 * The bundles in `root` (directories with a manifest; with `rootThreadId`,
 * only that thread's), sorted. A missing `root` holds none. Every entry of
 * `root` counts toward `limits.entries`, so a root with too many is over the
 * limit before MST reads them all.
 */
async function traceBundles(
  root: string,
  rootThreadId: string | undefined,
  limits: ArtifactLimits
): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const bundles: string[] = [];
  let entries = 0;
  for await (const entry of directory) {
    if (++entries > limits.entries)
      throw new RolloutTraceError(
        'limit',
        `the trace root has more than ${limits.entries} entries`
      );
    if (
      entry.isDirectory() &&
      (await isBundle(path.join(root, entry.name), rootThreadId))
    )
      bundles.push(entry.name);
  }
  return bundles.sort();
}

/** What a trial keeps of a rollout trace, and its `telemetry.rolloutTrace`. */
export interface KeptRolloutTrace {
  readonly artifacts?: ClientArtifacts;
  readonly telemetry: {
    /** The bundles kept; absent when MST couldn't list them. */
    readonly bundles?: number;
    readonly files?: number;
    readonly bytes?: number;
    readonly notKept?: string;
  };
}

/**
 * What a trial keeps of the rollout trace in `root`: a copy
 * ({@link copyRolloutTrace}) of its bundles, as the trial's client
 * artifacts. A client whose root holds only the trial's trace takes every
 * bundle; one whose root is shared (a desktop backend's, across a batch)
 * passes the trial's `rootThreadId`, and only bundles whose manifest names it
 * are kept. A trace not written (`noTrace` says why), over a limit, with an
 * entry MST doesn't copy, or that MST couldn't read is not kept, and
 * `telemetry.notKept` says why: the trial is still graded, where a copy over
 * a limit would make it an infrastructure failure. `root` stays the
 * caller's to remove.
 */
export async function keepRolloutTrace(
  root: string,
  options: {
    readonly noTrace: string;
    readonly rootThreadId?: string;
    readonly secrets?: readonly string[];
    readonly limits?: ArtifactLimits;
  }
): Promise<KeptRolloutTrace> {
  const limits = options.limits ?? ARTIFACT_LIMITS;
  let bundles: string[] | undefined;
  try {
    bundles = await traceBundles(root, options.rootThreadId, limits);
    if (bundles.length === 0)
      return { telemetry: { bundles: 0, notKept: options.noTrace } };
    const copy = await copyRolloutTrace(root, bundles, {
      secrets: options.secrets,
      limits,
    });
    return {
      artifacts: {
        dir: copy.dir,
        include: [ROLLOUT_TRACE_DIR],
        temporary: true,
      },
      telemetry: {
        bundles: bundles.length,
        files: copy.files,
        bytes: copy.bytes,
      },
    };
  } catch (error) {
    return {
      telemetry: {
        ...(bundles ? { bundles: bundles.length } : {}),
        notKept: rolloutTraceNotKept(error, options.secrets),
      },
    };
  }
}
