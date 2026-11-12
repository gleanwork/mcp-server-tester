/**
 * A trial's copy of the rollout trace the desktop app's Codex backend writes
 * under its batch's `CODEX_ROLLOUT_TRACE_ROOT`. A batch shares one backend,
 * so the root also holds other trials' and other chats' bundles: a trial
 * keeps only the bundles whose manifest names its bound native thread, and
 * copies them as every client's trace is copied (rolloutTraceCopy.ts):
 * directories and regular files MST's user owns, never through a link, with
 * the credentials MST knows replaced, within the artifact limits.
 */
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_LIMITS } from '../allArtifacts.js';
import type { ClientArtifacts } from '../evalFrameworkTypes.js';
import {
  copyRolloutTrace,
  isMissingPath,
  readTraceFile,
  ROLLOUT_TRACE_DIR,
  RolloutTraceError,
  rolloutTraceNotKept,
  type ArtifactLimits,
} from '../rolloutTraceCopy.js';

/** A manifest names a bundle's root thread; it is never this large. */
const MAX_MANIFEST_BYTES = 64 * 1024;

interface TraceCopy {
  artifacts?: ClientArtifacts;
  telemetry: {
    /** Bundles of the trial's thread; absent when MST couldn't list them. */
    bundles?: number;
    files?: number;
    bytes?: number;
    notKept?: string;
  };
}

/**
 * Whether the bundle `dir` is `threadId`'s: its version-1 `manifest.json`
 * names it as the root thread. A filename is not attribution. A bundle with
 * no manifest, or one MST won't read (a link, a hard link, another user's
 * file, too large) or can't parse, is another chat's or not a bundle; any
 * other error reading the manifest is thrown, so it isn't mistaken for no
 * trace.
 */
async function isThreadBundle(dir: string, threadId: string): Promise<boolean> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      (
        await readTraceFile(join(dir, 'manifest.json'), MAX_MANIFEST_BYTES)
      ).toString('utf8')
    );
  } catch (error) {
    if (
      isMissingPath(error) ||
      error instanceof RolloutTraceError ||
      error instanceof SyntaxError
    )
      return false;
    throw error;
  }
  if (typeof manifest !== 'object' || manifest === null) return false;
  const { schema_version, root_thread_id } = manifest as Record<
    string,
    unknown
  >;
  return schema_version === 1 && root_thread_id === threadId;
}

/**
 * The bundles in `root` that are `threadId`'s, sorted. A missing `root`
 * holds none. Every entry of `root` counts toward `limits.entries`, the
 * other chats' too, so a root with too many is over the limit before MST
 * reads them all.
 */
async function threadBundles(
  root: string,
  threadId: string,
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
      (await isThreadBundle(join(root, entry.name), threadId))
    )
      bundles.push(entry.name);
  }
  return bundles.sort();
}

/**
 * What a trial keeps of its batch's rollout trace in `root`: a copy of the
 * bundles rooted in `threadId`, its bound native thread, as the trial's
 * client artifacts. Without a bound thread, nothing: an unbound or duplicate
 * turn must never collect another chat's prompts. A bound turn that failed
 * may still keep the requests it made. A trace the backend didn't write, one
 * over a limit, one with an entry MST doesn't copy or one MST couldn't read
 * is not kept, and `telemetry.notKept` says why: the trial is still graded.
 * Never moves the live backend's files: the session removes `root` after
 * stopping the app.
 */
export async function copyChatgptRolloutTrace(
  root: string,
  threadId: string | undefined,
  options: {
    readonly secrets?: readonly string[];
    readonly limits?: ArtifactLimits;
  } = {}
): Promise<TraceCopy> {
  if (!threadId)
    return {
      telemetry: {
        bundles: 0,
        notKept: 'No unique native thread was attributed to this trial.',
      },
    };
  const limits = options.limits ?? ARTIFACT_LIMITS;
  let bundles: string[] | undefined;
  try {
    bundles = await threadBundles(root, threadId, limits);
    if (!bundles.length)
      return {
        telemetry: {
          bundles: 0,
          notKept:
            'The desktop backend wrote no rollout trace for the attributed native thread.',
        },
      };
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
