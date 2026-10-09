/**
 * Claude Code replaces a large tool result in its transcript with a
 * placeholder and saves the full result to a file:
 *
 *   <persisted-output>
 *   Output too large (97KB). Full output saved to: /…/tool-results/<tool_use_id>.json
 *
 *   Preview (first 2KB):
 *   …
 *   ...
 *   </persisted-output>
 *
 * The model reads the file, so a trace that keeps only the placeholder hides
 * what the model saw from judges. While the client's files still exist (during
 * collection), this reads the full result back.
 *
 * The path comes from tool output text, which an MCP server controls, and a
 * server can learn the call's `tool_use_id` (Claude Code sends it in the
 * request's `_meta`). So a file is read only when its real path is a regular
 * file named for the call's `tool_use_id`, in a `tool-results` directory,
 * inside one of `roots`: private directories MST created for the client
 * (see {@link mstScratchRoots}) or the client's own session directory.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

const PLACEHOLDER =
  /^<persisted-output>\s*\nOutput too large \([^)\n]*\)\. Full output saved to: ([^\n]+)\n/;
const PREVIEW =
  /\n\nPreview \([^)\n]*\):\n([\s\S]*?)(?:\n\.\.\.)?\n<\/persisted-output>\s*$/;

/** Larger results are kept to this many bytes, with a note. */
export const MAX_PERSISTED_OUTPUT_BYTES = 1_000_000;

/** Enough of a preview to tell its result from another. */
const PREVIEW_MATCH_CHARS = 1000;

function within(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function realRoot(root: string): string | undefined {
  try {
    return realpathSync(root);
  } catch {
    return undefined;
  }
}

/**
 * The private directories directly under the system temporary directory
 * whose names start with `prefix`, owned by this user and closed to others:
 * the scratch MST creates for a client (`mst-claude-` for the Claude CLI's
 * config, `mst-cowork-native-` for Claude Desktop's TMPDIR on macOS).
 */
export function mstScratchRoots(prefix: string): string[] {
  const temp = realRoot(tmpdir());
  if (!temp) return [];
  let names: string[];
  try {
    names = readdirSync(temp);
  } catch {
    return [];
  }
  const uid = process.getuid?.();
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(temp, name))
    .filter((dir) => {
      try {
        const stats = statSync(dir);
        return (
          stats.isDirectory() &&
          (uid === undefined || stats.uid === uid) &&
          (stats.mode & 0o077) === 0
        );
      } catch {
        return false;
      }
    });
}

/**
 * The full result behind a persisted-output placeholder, or `output` as is
 * when it isn't one or the file can't be trusted or read.
 */
export function resolvePersistedOutput(
  output: string,
  toolUseId: string | undefined,
  roots: readonly string[]
): string {
  const match = PLACEHOLDER.exec(output);
  if (!match || !toolUseId || roots.length === 0) return output;
  let file: string;
  try {
    file = realpathSync(match[1]!);
  } catch {
    return output;
  }
  // Checked on the real path: a link can't lend another file this name.
  const name = basename(file);
  if (name !== `${toolUseId}.json` && name !== `${toolUseId}.txt`)
    return output;
  if (basename(dirname(file)) !== 'tool-results') return output;
  const allowed = roots
    .map(realRoot)
    .filter((root): root is string => root !== undefined);
  if (!allowed.some((root) => within(file, root))) return output;
  let fd: number | undefined;
  try {
    const expected = statSync(file);
    if (!expected.isFile()) return output;
    // The file opened must be the file checked, not a link swapped in since.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino)
      return output;
    const length = Math.min(opened.size, MAX_PERSISTED_OUTPUT_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    return opened.size > MAX_PERSISTED_OUTPUT_BYTES
      ? `${text}\n[MST: truncated at ${MAX_PERSISTED_OUTPUT_BYTES} of ${opened.size} bytes]`
      : text;
  } catch {
    return output;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether `full` is the result a placeholder stands for, as far as its
 * preview shows: for checking a trace collected with the file against a
 * transcript read later without it.
 */
export function matchesPersistedPreview(
  placeholder: string,
  full: string
): boolean {
  if (!PLACEHOLDER.test(placeholder)) return false;
  const preview = PREVIEW.exec(placeholder)?.[1];
  if (!preview) return false;
  return full.startsWith(preview.slice(0, PREVIEW_MATCH_CHARS));
}
