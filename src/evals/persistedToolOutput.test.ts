import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PERSISTED_OUTPUT_BYTES,
  resolvePersistedOutput,
} from './persistedToolOutput.js';

const ID = 'toolu_bdrk_01QnnrBzoJ7qWyZbzHvwEouZ';
const FULL = '[{"type":"text","text":"# Search Results (16 found)"}]';

let root = '';
let outside = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mst-persisted-'));
  outside = mkdtempSync(join(tmpdir(), 'mst-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function placeholder(path: string): string {
  return `<persisted-output>\nOutput too large (97KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n[{"type":"text","text":"# Search`;
}

function saved(directory: string, name = `${ID}.json`, content = FULL) {
  const dir = join(directory, 'projects', 'session', 'abc', 'tool-results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe('resolvePersistedOutput', () => {
  it('reads back the full result the placeholder names', () => {
    const file = saved(root);
    expect(resolvePersistedOutput(placeholder(file), ID, [root])).toBe(FULL);
  });

  it('leaves ordinary output alone', () => {
    expect(resolvePersistedOutput('small result', ID, [root])).toBe(
      'small result'
    );
  });

  it("never reads a file that isn't named for this call", () => {
    // A server can write a placeholder into its own output; it can't know
    // the tool_use_id the model API assigned.
    const file = saved(root, 'toolu_other.json');
    const output = placeholder(file);
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
    expect(resolvePersistedOutput(output, undefined, [root])).toBe(output);
  });

  it('reads only inside the roots, after resolving links', () => {
    const file = saved(outside);
    const output = placeholder(file);
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
    // A link inside the root to a file outside it doesn't count.
    const linkDir = join(root, 'tool-results');
    mkdirSync(linkDir);
    symlinkSync(file, join(linkDir, `${ID}.json`));
    const linked = placeholder(join(linkDir, `${ID}.json`));
    expect(resolvePersistedOutput(linked, ID, [root])).toBe(linked);
  });

  it('reads only from a tool-results directory', () => {
    mkdirSync(join(root, 'other'));
    const file = join(root, 'other', `${ID}.json`);
    writeFileSync(file, FULL);
    const output = placeholder(file);
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
  });

  it('keeps the placeholder when the file is gone', () => {
    const output = placeholder(
      join(root, 'projects', 'tool-results', `${ID}.json`)
    );
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
  });

  it('truncates a very large result, and says so', () => {
    const size = MAX_PERSISTED_OUTPUT_BYTES + 10;
    const file = saved(root, `${ID}.txt`, 'x'.repeat(size));
    const resolved = resolvePersistedOutput(placeholder(file), ID, [root]);
    expect(resolved.startsWith('x'.repeat(100))).toBe(true);
    expect(resolved).toContain(
      `[MST: truncated at ${MAX_PERSISTED_OUTPUT_BYTES} of ${size} bytes]`
    );
  });
});
