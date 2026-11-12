/**
 * A trial's copy of a Codex rollout trace (the bundles Codex writes under
 * `CODEX_ROLLOUT_TRACE_ROOT`), made before the trial reports it as its client
 * artifacts. Any client whose agent writes such a trace can collect it here.
 *
 * The agent can write where its trace is, so the copy trusts none of it:
 * it reads only regular files MST's user owns, never through a symbolic link
 * and never a hard link (a link to the trial's `config.toml` would otherwise
 * outlive the trial's home), and replaces every credential MST knows for the
 * trial, as the transcript does. It copies into a directory of its own, within
 * `ARTIFACT_LIMITS` as the artifact copy counts them (trialArtifacts.ts), so
 * what it returns fits.
 */
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_LIMITS } from './allArtifacts.js';
import { redactClientSecretBytes } from './clientSecrets.js';

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
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new RolloutTraceError('unsafe', 'is a symbolic link');
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new RolloutTraceError('unsafe', 'is not a regular file');
    if (before.nlink !== 1)
      throw new RolloutTraceError('unsafe', 'is a hard link');
    const uid = process.getuid?.();
    if (uid !== undefined && before.uid !== uid)
      throw new RolloutTraceError('unsafe', "isn't owned by MST's user");
    if (before.size > maxBytes)
      throw new RolloutTraceError('limit', `is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(before.size);
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
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
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
 * are left out, as the artifact copy leaves them out. Fails, leaving no
 * directory, with a {@link RolloutTraceError} for a limit or a file MST
 * won't copy, or with the error that kept it from reading the trace.
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
    await mkdir(path.join(target, ...segments), {
      recursive: true,
      mode: 0o700,
    });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      countEntry();
      const from = path.join(source, entry.name);
      const at = [...segments, entry.name];
      if (entry.isDirectory()) {
        await walk(from, at);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = at.slice(1).join('/');
      let data: Buffer;
      try {
        data = redactClientSecretBytes(
          await readTraceFile(from, limits.fileBytes),
          secrets
        );
      } catch (error) {
        if (error instanceof RolloutTraceError)
          throw new RolloutTraceError(error.kind, `${name} ${error.message}`);
        throw error;
      }
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
    for (const bundle of bundles) {
      countEntry();
      await walk(path.join(root, bundle), [ROLLOUT_TRACE_DIR, bundle]);
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { dir: target, files, bytes };
}
