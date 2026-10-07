/**
 * Every JSON eval config and dataset in the README and the docs is one that
 * `mst run` accepts. Migration guides and ADRs are left out: their "before"
 * examples are old on purpose. So are design proposals (`docs/design/`),
 * whose examples show keys that don't exist yet. Annotated references with comments are
 * fenced as `jsonc` and not checked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEvalDataset } from './buildEvalDataset.js';
import { loadEvalConfigFromObject, type EvalConfig } from './evalConfig.js';
import { validateEvalConfig } from './configValidation.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

function markdownFiles(): string[] {
  const docs = fs
    .readdirSync(path.join(ROOT, 'docs'), { recursive: true })
    .map(String)
    .filter(
      (file) =>
        file.endsWith('.md') &&
        !file.startsWith('migrations') &&
        !file.startsWith('adr') &&
        !file.startsWith('design') &&
        !path.basename(file).startsWith('migration-')
    )
    .map((file) => path.join('docs', file));
  return ['README.md', ...docs];
}

/** A whole eval config (`datasets`) or dataset (`cases`), by its top-level keys. */
type Kind = 'eval config' | 'dataset';

interface Example {
  kind: Kind;
  where: string;
  value: unknown;
}

/** The `json` code blocks in a file, with their line numbers. */
function jsonBlocks(file: string): Array<{ line: number; text: string }> {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const blocks: Array<{ line: number; text: string }> = [];
  let open: { lang: string; line: number; body: string[] } | undefined;
  lines.forEach((text, index) => {
    const fence = /^\s*```(\S*)/.exec(text);
    if (!fence) {
      open?.body.push(text);
      return;
    }
    if (!open) {
      open = { lang: fence[1] ?? '', line: index + 1, body: [] };
      return;
    }
    if (open.lang === 'json')
      blocks.push({ line: open.line, text: open.body.join('\n') });
    open = undefined;
  });
  return blocks;
}

const examples: Example[] = [];
const unparsed: string[] = [];
for (const file of markdownFiles()) {
  for (const { line, text } of jsonBlocks(file)) {
    const where = `${file}:${line}`;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A fragment ("key": value, ...) isn't a whole example; a block that
      // looks whole but doesn't parse is a broken example.
      if (
        /^\s*\{[\s\S]*\}\s*$/.test(text) &&
        /"(datasets|cases)"\s*:/.test(text)
      )
        unparsed.push(where);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const keys = value as Record<string, unknown>;
    if (typeof keys.name !== 'string') continue;
    if ('datasets' in keys)
      examples.push({ kind: 'eval config', where, value });
    else if (Array.isArray(keys.cases))
      examples.push({ kind: 'dataset', where, value });
  }
}

describe('eval config and dataset examples in the docs', () => {
  it('finds both kinds, and every whole example parses', () => {
    expect(
      examples.filter((example) => example.kind === 'eval config').length
    ).toBeGreaterThan(3);
    expect(
      examples.filter((example) => example.kind === 'dataset').length
    ).toBeGreaterThan(3);
    expect(unparsed).toEqual([]);
  });

  it.each(examples)('$where is a valid $kind', ({ kind, value }) => {
    if (kind === 'dataset') {
      // The loader `mst run` uses, with its case rules.
      expect(() =>
        buildEvalDataset(value, {
          name: 'docs',
          datasets: [],
        } as EvalConfig)
      ).not.toThrow();
      return;
    }
    const evalConfig = loadEvalConfigFromObject(value, {
      skipDatasetValidation: true,
    });
    expect(() => validateEvalConfig(evalConfig)).not.toThrow();
  });
});
