import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonChunks, readJsonFile, writeJsonFile } from './jsonFile.js';

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

  it('rejects malformed saved JSON rather than returning partial results', async () => {
    const file = join(root, 'results.json');
    await writeFile(file, '{"cases":[{"id":"a"},');
    await expect(readJsonFile(file)).rejects.toThrow();
  });
});
