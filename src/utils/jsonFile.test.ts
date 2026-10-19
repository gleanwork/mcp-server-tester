import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  jsonChunks,
  jsonCopy,
  readJsonFile,
  writeJsonFile,
} from './jsonFile.js';

describe('chunked result JSON', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mst-json-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips native tool output and preserves JSON serialization semantics', async () => {
    const shared = { text: 'π 😀 \\ " \n', missing: undefined, nonfinite: NaN };
    const value = {
      variants: [shared],
      results: [shared],
      empty: [],
      date: new Date('2026-10-12T00:00:00Z'),
      absent: undefined,
      list: [undefined, Infinity],
    };
    const file = join(root, 'nested', 'results.json');
    await writeJsonFile(file, value);
    expect(await readFile(file, 'utf8')).toBe(
      JSON.stringify(value, null, 2) + '\n'
    );
    expect(await readJsonFile(file)).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('serializes a duplicated summary larger than the V8 string limit', () => {
    // Shared synthetic output keeps the fixture small; the serialized run is
    // larger than any single JS string, just like the failed full-run summary.
    const output = 'x'.repeat(1024 * 1024);
    const cases = Array.from({ length: 270 }, () => ({ output }));
    let characters = 0;
    for (const chunk of jsonChunks({ variants: [{ cases }], results: cases })) {
      characters += chunk.length;
      expect(chunk.length).toBeLessThan(2 * output.length);
    }
    expect(characters).toBeGreaterThan(constants.MAX_STRING_LENGTH);
  });

  it('leaves prior results and latest intact when serialization fails', async () => {
    const file = join(root, 'latest.json');
    await writeFile(file, '{"previous":true}\n');
    const circular: { output: string; cycle?: unknown } = {
      output: 'x'.repeat(50_000),
    };
    circular.cycle = circular;
    await expect(writeJsonFile(file, circular)).rejects.toThrow(/circular/i);
    expect(await readFile(file, 'utf8')).toBe('{"previous":true}\n');
    expect(await readdir(root)).toEqual(['latest.json']);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a file’s mode, and gives a new file the default mode',
    async () => {
      const existing = join(root, 'shared.json');
      await writeFile(existing, '{}\n');
      // Not the default mode, so keeping it is observable.
      await chmod(existing, 0o640);
      await writeJsonFile(existing, { a: 1 });
      expect((await stat(existing)).mode & 0o777).toBe(0o640);

      const fresh = join(root, 'fresh.json');
      const plain = join(root, 'plain.json');
      await writeJsonFile(fresh, { a: 1 });
      await writeFile(plain, '{}');
      // Same as fs.writeFile: 0o666 less the umask, not owner-only.
      expect((await stat(fresh)).mode & 0o777).toBe(
        (await stat(plain)).mode & 0o777
      );
    }
  );

  it('copies with JSON semantics, including values a structured clone rejects', () => {
    const value = {
      url: new URL('https://example.com/a'),
      date: new Date('2026-10-12T00:00:00Z'),
      missing: undefined,
      fn: () => 1,
      list: [undefined, NaN, () => 1, 2],
      boxed: new String('s'),
      nested: { toJSON: (key: string) => `key:${key}` },
      map: new Map([['a', 1]]),
    };
    expect(() => structuredClone(value)).toThrow();
    expect(jsonCopy(value)).toEqual(JSON.parse(JSON.stringify(value)));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => jsonCopy(circular)).toThrow(/circular/i);
    expect(() => jsonCopy({ n: 1n })).toThrow(/BigInt/);
    // A shared, non-circular value is copied at each place it appears.
    const shared = { a: 1 };
    expect(jsonCopy({ x: shared, y: [shared] })).toEqual({
      x: { a: 1 },
      y: [{ a: 1 }],
    });
  });

  it('rejects malformed saved JSON rather than returning partial results', async () => {
    const file = join(root, 'results.json');
    await writeFile(file, '{"cases":[{"id":"a"},');
    await expect(readJsonFile(file)).rejects.toThrow();
  });
});
