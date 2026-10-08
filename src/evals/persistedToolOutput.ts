/**
 * Claude Code replaces a large tool result in its transcript with a
 * placeholder and saves the full result to a file:
 *
 *   <persisted-output>
 *   Output too large (97KB). Full output saved to: /…/tool-results/<tool_use_id>.json
 *
 *   Preview (first 2KB): …
 *
 * The model reads the file, so a trace that keeps only the placeholder hides
 * what the model saw from judges. While the client's files still exist (during
 * collection), this reads the full result back.
 *
 * The path comes from tool output text, which an MCP server controls, so a
 * file is read only when it is named for this call's own `tool_use_id` (which
 * the model API assigns before the server is called), sits in a
 * `tool-results` directory, and is a regular file inside one of `roots`.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

const PLACEHOLDER =
  /^<persisted-output>\s*\nOutput too large \([^)\n]*\)\. Full output saved to: (\S+)\n/;

/** Larger results are kept to this many bytes, with a note. */
export const MAX_PERSISTED_OUTPUT_BYTES = 1_000_000;

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
 * The full result behind a persisted-output placeholder, or `output` as is
 * when it isn't one or the file can't be trusted or read.
 */
export function resolvePersistedOutput(
  output: string,
  toolUseId: string | undefined,
  roots: readonly string[]
): string {
  const match = PLACEHOLDER.exec(output);
  if (!match || !toolUseId) return output;
  const claimed = match[1]!;
  const name = basename(claimed);
  if (name !== `${toolUseId}.json` && name !== `${toolUseId}.txt`)
    return output;
  if (basename(dirname(claimed)) !== 'tool-results') return output;
  let file: string;
  try {
    file = realpathSync(claimed);
  } catch {
    return output;
  }
  const allowed = roots
    .map(realRoot)
    .filter((root): root is string => root !== undefined);
  if (!allowed.some((root) => within(file, root))) return output;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return output;
    const length = Math.min(stats.size, MAX_PERSISTED_OUTPUT_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return stats.size > MAX_PERSISTED_OUTPUT_BYTES
      ? `${text}\n[MST: truncated at ${MAX_PERSISTED_OUTPUT_BYTES} of ${stats.size} bytes]`
      : text;
  } catch {
    return output;
  }
}
