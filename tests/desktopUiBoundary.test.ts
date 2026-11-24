/**
 * `src/evals/desktopUi/` is the desktop interface and its transports, which
 * no product owns (ADR 0017). A product's name or a product's module there
 * would make one product the reference for the others, so this fails on
 * either. A product's identity, links and rules live in its own directory.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIRECTORY = fileURLToPath(
  new URL('../src/evals/desktopUi/', import.meta.url)
);
/** The desktop apps MST drives, and the modes and makers that name them. */
const PRODUCT = /claude|cowork|anthropic|chatgpt|codex|openai/i;
const IMPORT = /from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;

const files = readdirSync(DIRECTORY, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort();

describe('the desktop interface names no product', () => {
  it('has source files to check', () => {
    expect(files).toContain('desktopUi.ts');
  });

  it.each(files)('%s names no product', (file) => {
    const lines = readFileSync(path.join(DIRECTORY, file), 'utf8').split('\n');
    const named = lines.flatMap((line, index) =>
      PRODUCT.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []
    );
    expect(named).toEqual([]);
  });

  it.each(files)("%s imports no product's module", (file) => {
    const source = readFileSync(path.join(DIRECTORY, file), 'utf8');
    const outside = [...source.matchAll(IMPORT)]
      .map((match) => match[1] ?? match[2]!)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) =>
        path.relative(
          path.join(DIRECTORY, '..'),
          path.resolve(DIRECTORY, path.dirname(file), specifier)
        )
      )
      // Shared modules sit beside `desktopUi/`; a product's sit in its directory.
      .filter(
        (target) => !target.startsWith('desktopUi/') && target.includes('/')
      );
    expect(outside).toEqual([]);
  });
});
