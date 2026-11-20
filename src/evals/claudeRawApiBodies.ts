/**
 * Claude Code's raw API bodies (the `claude-code` client's `rawApiBodies`):
 * each Messages API request exactly as Claude Code sent it, and each
 * response, which Claude Code writes as files when `OTEL_LOG_RAW_API_BODIES`
 * is `file:<dir>`. From Claude Code 2.1.274 it also writes an `index.jsonl`
 * that pairs each response with its request file and transcript message.
 *
 * A trial points the variable at a directory of its own, and keeps a copy as
 * its client artifacts. Claude Code runs as MST's user and can write
 * anything there, so the copy is the rollout trace's (rolloutTraceCopy.ts):
 * it follows no link, reads no file another user owns, and stays within
 * what a trial's artifacts may hold.
 */
import { realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { redactClientSecrets } from './clientSecrets.js';
import type {
  ClientArtifacts,
  HostTelemetry,
  HostTelemetryEvent,
} from './evalFrameworkTypes.js';
import {
  copyRolloutTrace,
  RolloutTraceError,
  type ArtifactLimits,
} from './rolloutTraceCopy.js';

/** Where a trial's raw API bodies are, in its client artifacts. */
export const CLAUDE_RAW_API_BODIES_DIR = 'claude-raw-api-bodies';

/** The variable that has Claude Code write them. */
export const RAW_API_BODIES_ENV = 'OTEL_LOG_RAW_API_BODIES';

/** The environment that has Claude Code write its raw API bodies in `dir`. */
export function rawApiBodiesEnv(dir: string): Record<string, string> {
  return {
    [RAW_API_BODIES_ENV]: `file:${path.join(dir, CLAUDE_RAW_API_BODIES_DIR)}`,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** The names of the bodies in a copy MST made, by what they are. */
async function countBodies(
  dir: string
): Promise<{ requests: number; responses: number }> {
  const names = await readdir(path.join(dir, CLAUDE_RAW_API_BODIES_DIR));
  return {
    requests: names.filter((name) => name.endsWith('.request.json')).length,
    responses: names.filter((name) => name.endsWith('.response.json')).length,
  };
}

/**
 * What a trial keeps of the raw API bodies Claude Code wrote in `dir` (see
 * {@link rawApiBodiesEnv}): a copy, as the trial's client artifacts, with
 * `secrets` replaced, when it fits what a trial's artifacts may hold. Bodies
 * Claude Code didn't write, ones over a limit, a file MST won't copy (a link,
 * or a file another user owns) or one MST couldn't read are not kept, and
 * `telemetry` says why: the trial is still graded. `dir` stays the caller's
 * to remove.
 */
export async function claudeRawApiBodies(
  dir: string,
  options: {
    readonly secrets?: readonly string[];
    readonly limits?: ArtifactLimits;
  } = {}
): Promise<{
  artifacts?: ClientArtifacts;
  telemetry: Record<string, unknown>;
}> {
  try {
    const written = await readdir(
      path.join(dir, CLAUDE_RAW_API_BODIES_DIR)
    ).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    if (written.length === 0)
      return {
        telemetry: {
          requests: 0,
          responses: 0,
          notKept:
            'Claude Code wrote no raw API bodies. Claude Code 2.1.274 or later writes them, unless managed settings turn them off.',
        },
      };
    const copy = await copyRolloutTrace(dir, [CLAUDE_RAW_API_BODIES_DIR], {
      ...options,
      under: [],
    });
    return {
      artifacts: {
        dir: copy.dir,
        include: [CLAUDE_RAW_API_BODIES_DIR],
        temporary: true,
      },
      // Counted in MST's copy, not in Claude Code's directory.
      telemetry: {
        ...(await countBodies(copy.dir)),
        files: copy.files,
        bytes: copy.bytes,
      },
    };
  } catch (error) {
    const reason = redactClientSecrets(
      error instanceof Error ? error.message : String(error),
      options.secrets ?? []
    );
    return {
      telemetry: {
        notKept:
          error instanceof RolloutTraceError
            ? error.kind === 'limit'
              ? `The raw API bodies are larger than a trial's artifacts may be: ${reason}.`
              : `The raw API bodies hold an entry MST doesn't copy: ${reason}.`
            : `MST couldn't read the raw API bodies: ${reason}`,
      },
    };
  }
}

/**
 * `host` with the `body_ref` of each raw API body event, a file in `dir`
 * that the trial removes, given as that file's path in the trial's client
 * artifacts: `claude-raw-api-bodies/<file>`. A run that keeps the artifacts
 * has the file there.
 */
export function withArtifactBodyRefs(
  host: HostTelemetry,
  dir: string
): HostTelemetry {
  const dirs = [dir];
  try {
    dirs.push(realpathSync(dir));
  } catch {
    // Named as given only.
  }
  const roots = dirs.map(
    (each) => path.join(each, CLAUDE_RAW_API_BODIES_DIR) + path.sep
  );
  const inArtifacts = (event: HostTelemetryEvent): HostTelemetryEvent => {
    const ref = event.attributes.body_ref;
    if (typeof ref !== 'string') return event;
    const root = roots.find((each) => ref.startsWith(each));
    if (!root) return event;
    const file = ref.slice(root.length).split(path.sep).join('/');
    return {
      ...event,
      attributes: {
        ...event.attributes,
        body_ref: `${CLAUDE_RAW_API_BODIES_DIR}/${file}`,
      },
    };
  };
  return { ...host, events: host.events.map(inArtifacts) };
}
