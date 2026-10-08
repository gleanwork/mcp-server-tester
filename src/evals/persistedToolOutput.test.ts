import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PERSISTED_OUTPUT_BYTES,
  matchesPersistedPreview,
  mstScratchRoots,
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

function placeholder(path: string, preview = '[{"type":"text"'): string {
  return `<persisted-output>\nOutput too large (97KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
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

  it('reads a path with spaces, as under Application Support', () => {
    const file = saved(join(root, 'Application Support'));
    expect(resolvePersistedOutput(placeholder(file), ID, [root])).toBe(FULL);
  });

  it('leaves ordinary output alone', () => {
    expect(resolvePersistedOutput('small result', ID, [root])).toBe(
      'small result'
    );
  });

  it("never reads a file that isn't named for this call", () => {
    const file = saved(root, 'toolu_other.json');
    const output = placeholder(file);
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
    expect(resolvePersistedOutput(output, undefined, [root])).toBe(output);
  });

  it('checks the name and directory of the real file, not of a link', () => {
    // A server that knows the tool_use_id (Claude Code sends it in `_meta`)
    // links that name to another file inside the root.
    writeFileSync(join(root, 'secret.env'), 'TOKEN=abc');
    const dir = join(root, 'tool-results');
    mkdirSync(dir);
    symlinkSync(join(root, 'secret.env'), join(dir, `${ID}.json`));
    const output = placeholder(join(dir, `${ID}.json`));
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
  });

  it('reads only inside the roots, after resolving links', () => {
    const file = saved(outside);
    const output = placeholder(file);
    expect(resolvePersistedOutput(output, ID, [root])).toBe(output);
    expect(resolvePersistedOutput(output, ID, [])).toBe(output);
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

describe('mstScratchRoots', () => {
  it('lists private directories MST made, by prefix', () => {
    const mine = mkdtempSync(join(tmpdir(), 'mst-claude-test-'));
    const open = mkdtempSync(join(tmpdir(), 'mst-claude-open-'));
    chmodSync(open, 0o755);
    try {
      const roots = mstScratchRoots('mst-claude-');
      expect(roots).toContain(realpathSync(mine));
      // Others can write there: not a place to trust a file from.
      expect(roots).not.toContain(realpathSync(open));
      expect(mstScratchRoots('mst-nothing-has-this-prefix-')).toEqual([]);
    } finally {
      rmSync(mine, { recursive: true, force: true });
      rmSync(open, { recursive: true, force: true });
    }
  });
});

describe('matchesPersistedPreview', () => {
  const full = `[\n  {\n    "type": "text",\n    "text": "${'x'.repeat(3000)}"\n  }\n]`;
  it('matches a result that starts with the preview', () => {
    expect(
      matchesPersistedPreview(
        placeholder('/gone/tool-results/a.json', full.slice(0, 2000)),
        full
      )
    ).toBe(true);
  });
  it("doesn't match another result, or text that isn't a placeholder", () => {
    expect(
      matchesPersistedPreview(
        placeholder('/gone/tool-results/a.json', full.slice(0, 2000)),
        'other'
      )
    ).toBe(false);
    expect(matchesPersistedPreview('plain text', full)).toBe(false);
  });
});
