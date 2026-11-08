/**
 * The dry-run proxy's side of the write record (writeRecordLines.ts): it
 * appends one line per event. Its own module so MST's bundles don't carry it.
 */
import { appendFile } from 'node:fs/promises';
import { WRITE_RECORD_FORMAT } from './writeRecordFormat.js';
import type { WriteRecordLine } from './writeRecordLines.js';

/** Appends one line to `file`, which only its owner can read. */
export async function appendWriteRecordLine(
  file: string,
  line: DistributiveOmit<WriteRecordLine, 'format'>
): Promise<void> {
  const record = { format: WRITE_RECORD_FORMAT, ...line };
  await appendFile(file, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    flag: 'a',
  });
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
