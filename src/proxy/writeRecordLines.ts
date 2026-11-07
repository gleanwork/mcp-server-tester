/**
 * The write record file: one JSON line per event the dry-run proxy records
 * (ADR 0014). The proxy appends to it (`appendWriteRecordLine` in
 * writeRecordWriter.ts); MST reads it after each trial and keeps each trial's
 * part with the trial (evals/writeRecord.ts). Reading is in its own module so
 * MST's bundles don't carry the proxy's writer, nor the proxy MST's reader.
 *
 * Lines:
 *
 * - `tools`: the tools the proxy treats as writes, each time it lists the
 *   server's tools. MST reads the latest to tell a write call in a
 *   transcript that never reached the proxy (an unrecorded write).
 * - `write`: a write the proxy stopped (`planned`, `simulated`), or one the
 *   server stopped and marked (`server-planned`), with the reply the client
 *   got.
 * - `unclassified`: a call the proxy forwarded and can't classify: a
 *   dispatcher's call, or a call to a tool that isn't read-only, whose result
 *   has no planned-write mark.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { WRITE_RECORD_FORMAT } from './writeRecordFormat.js';

/** How a recorded write was stopped. */
const STOPPED_WRITE_MODES = ['planned', 'simulated', 'server-planned'] as const;
export type StoppedWriteMode = (typeof STOPPED_WRITE_MODES)[number];

const ToolsLineSchema = z.object({
  format: z.literal(WRITE_RECORD_FORMAT),
  kind: z.literal('tools'),
  time: z.string(),
  server: z.string(),
  /** The tools the proxy treats as writes, dispatchers included. */
  writeTools: z.array(z.string()),
});

const WriteLineSchema = z.object({
  format: z.literal(WRITE_RECORD_FORMAT),
  kind: z.literal('write'),
  time: z.string(),
  /** The server's label. */
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  /** What the client was told. */
  reply: z.unknown(),
  mode: z.enum(STOPPED_WRITE_MODES),
  /** A dispatcher's target tool, from the argument the connector names. */
  target: z.string().optional(),
});

const UnclassifiedLineSchema = z.object({
  format: z.literal(WRITE_RECORD_FORMAT),
  kind: z.literal('unclassified'),
  time: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  target: z.string().optional(),
  /** `dispatch`: a dispatcher's call. `unmarked`: a write tool's call the server didn't mark. */
  reason: z.enum(['dispatch', 'unmarked']),
});

const WriteRecordLineSchema = z.discriminatedUnion('kind', [
  ToolsLineSchema,
  WriteLineSchema,
  UnclassifiedLineSchema,
]);
export type WriteRecordLine = z.infer<typeof WriteRecordLineSchema>;
export type WriteRecordWriteLine = z.infer<typeof WriteLineSchema>;
export type WriteRecordUnclassifiedLine = z.infer<
  typeof UnclassifiedLineSchema
>;

/** A line with its position in the file (0-based, malformed lines counted). */
export interface NumberedWriteRecordLine {
  line: number;
  record: WriteRecordLine;
}

/**
 * The lines of `file`, in order, each with its position; none when it doesn't
 * exist yet. A malformed line (cut short by a proxy that was killed
 * mid-write) is skipped but keeps its position, so positions stay stable as
 * the file grows.
 */
export async function readWriteRecordLines(
  file: string
): Promise<NumberedWriteRecordLine[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // Only complete lines: the last one may be mid-write.
  const lines = text.split('\n').slice(0, -1);
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const parsed = WriteRecordLineSchema.safeParse(JSON.parse(line));
      return parsed.success ? [{ line: index, record: parsed.data }] : [];
    } catch {
      return [];
    }
  });
}

/** How many complete lines `file` has: where the next trial's part starts. */
export async function writeRecordLength(file: string): Promise<number> {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').length - 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}
