import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * Publish only complete JSON; failed serialization leaves the previous file
 * intact. The file keeps the mode it had, and a new file gets the default
 * mode, as `writeFile` gives it. Replacing a file, the temporary file is
 * owner-only until it is complete, so a private file's contents are never
 * exposed. A new file has no earlier contents to protect, so the umask sets
 * its mode (reading the umask in Node briefly clears it for every thread).
 */
export async function writeJsonFile(
  file: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const mode = await stat(file).then(
    (info) => info.mode & 0o7777,
    () => undefined
  );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, jsonChunks(value), {
      flag: 'wx',
      ...(mode === undefined ? {} : { mode: 0o600 }),
    });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * A deep copy with `JSON.parse(JSON.stringify(value))`'s semantics (`toJSON`,
 * `undefined` and functions dropped, non-finite numbers as `null`), built
 * without one string of the whole value, which can pass V8's limit.
 */
export function jsonCopy<T>(value: T): T {
  return copyJson(value, '', new Set()) as T;
}

function copyJson(
  value: unknown,
  key: string,
  ancestors: Set<object>
): unknown {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  )
    value = (value as { toJSON(key: string): unknown }).toJSON(key);
  if (
    value instanceof Number ||
    value instanceof String ||
    value instanceof Boolean
  )
    value = value.valueOf();
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (value === null) return null;
  const object = value as object;
  if (ancestors.has(object))
    throw new TypeError('Converting circular structure to JSON');
  ancestors.add(object);
  try {
    if (Array.isArray(object))
      return object.map(
        (item: unknown, index) =>
          copyJson(item, String(index), ancestors) ?? null
      );
    const copy: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(object)) {
      const copied = copyJson(item, name, ancestors);
      // Define, not assign: assigning `__proto__` would set the prototype and
      // drop the key, where JSON.parse keeps it as a property.
      if (copied !== undefined)
        Object.defineProperty(copy, name, {
          value: copied,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    return copy;
  } finally {
    ancestors.delete(object);
  }
}
