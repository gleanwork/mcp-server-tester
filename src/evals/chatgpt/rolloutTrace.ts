/** Trial-local copies of the desktop backend's native rollout trace. */
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_LIMITS } from '../allArtifacts.js';
import type { ClientArtifacts } from '../evalFrameworkTypes.js';

const TRACE_DIR = 'codex-rollout-trace';
const MAX_MANIFEST_BYTES = 64 * 1024;
type Limits = { readonly [K in keyof typeof ARTIFACT_LIMITS]: number };

interface TraceCopy {
  artifacts?: ClientArtifacts;
  telemetry: {
    bundles: number;
    files?: number;
    bytes?: number;
    notKept?: string;
  };
}

/** Read only a bounded, regular, singly-linked file, never a symlink or pipe. */
async function readTraceFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.size > maxBytes
    )
      throw new Error('unsafe or oversized trace file');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!bytesRead) throw new Error('trace file changed while being copied');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('trace file changed while being copied');
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Copy only bundles whose native manifest names the trial's bound root thread.
 * A desktop batch shares one backend, so copying the batch root would leak
 * other trials or unrelated chats into the judge's evidence. Never move a live
 * backend's files: the session removes the source root after stopping the app.
 * Missing, unsafe and over-limit traces are telemetry, not trial failures.
 */
export async function copyChatgptRolloutTrace(
  root: string,
  threadId: string | undefined,
  limits: Limits = ARTIFACT_LIMITS
): Promise<TraceCopy> {
  const telemetry: TraceCopy['telemetry'] = { bundles: 0 };
  const notKept = (reason: string): TraceCopy => ({
    telemetry: { ...telemetry, notKept: reason },
  });
  if (!threadId)
    return notKept('No unique native thread was attributed to this trial.');
  let target: string | undefined;
  try {
    const bundles: string[] = [];
    let scanned = 0;
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (++scanned > limits.entries)
        throw new Error('too many trace root entries');
      if (!entry.isDirectory()) continue;
      let manifest: unknown;
      try {
        manifest = JSON.parse(
          (
            await readTraceFile(
              join(root, entry.name, 'manifest.json'),
              MAX_MANIFEST_BYTES
            )
          ).toString('utf8')
        );
      } catch {
        continue;
      }
      if (
        manifest &&
        typeof manifest === 'object' &&
        'schema_version' in manifest &&
        manifest.schema_version === 1 &&
        'root_thread_id' in manifest &&
        manifest.root_thread_id === threadId
      )
        bundles.push(entry.name);
    }
    telemetry.bundles = bundles.length;
    if (!bundles.length)
      return notKept(
        'The desktop backend wrote no rollout trace for the attributed native thread.'
      );
    target = await mkdtemp(join(tmpdir(), 'mst-chatgpt-trial-trace-'));
    let entries = 1; // The top-level TRACE_DIR counts in the final artifact copy.
    let files = 0;
    let bytes = 0;
    const walk = async (
      source: string,
      destination: string,
      depth: number
    ): Promise<void> => {
      if (depth > limits.depth)
        throw new Error('trace directory depth limit exceeded');
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const directory = await opendir(source);
      for await (const entry of directory) {
        if (++entries > limits.entries)
          throw new Error('trace entry limit exceeded');
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory()) {
          await walk(from, to, depth + 1);
        } else if (entry.isFile()) {
          const data = await readTraceFile(
            from,
            Math.min(limits.fileBytes, limits.totalBytes - bytes)
          );
          bytes += data.length;
          await writeFile(to, data, { flag: 'wx', mode: 0o600 });
          files += 1;
        } else {
          throw new Error('trace contains a non-regular file');
        }
      }
    };
    for (const bundle of bundles) {
      if (++entries > limits.entries)
        throw new Error('trace entry limit exceeded');
      await walk(join(root, bundle), join(target, TRACE_DIR, bundle), 2);
    }
    return {
      artifacts: { dir: target, include: [TRACE_DIR], temporary: true },
      telemetry: { bundles: bundles.length, files, bytes },
    };
  } catch (error) {
    if (target) await rm(target, { recursive: true, force: true });
    // Never echo native paths, filenames or prompts from an exception.
    return notKept(
      error instanceof Error &&
        [
          'too many trace root entries',
          'trace directory depth limit exceeded',
          'trace entry limit exceeded',
          'trace contains a non-regular file',
          'unsafe or oversized trace file',
          'trace file changed while being copied',
        ].includes(error.message)
        ? error.message
        : 'The native rollout trace could not be copied.'
    );
  }
}
