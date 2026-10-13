import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseChunked, stringifyChunked } from '@discoveryjs/json-ext';

/** JSON chunks avoid V8's single-string limit for runs with large tool traces. */
export function* jsonChunks(value: unknown): Generator<string> {
  yield* stringifyChunked(value, { space: 2 });
  yield '\n';
}

export async function readJsonFile(file: string): Promise<unknown> {
  return parseChunked(createReadStream(file));
}

/** Publish only complete JSON; failed serialization leaves the previous file intact. */
export async function writeJsonFile(
  file: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, jsonChunks(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
