import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  covers,
  report,
  stalePages,
  type CodeMap,
} from '../scripts/docs-coverage.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts/docs-coverage.ts');
const CODE_MAP = JSON.parse(
  readFileSync(path.join(REPO, 'docs/code-map.json'), 'utf8')
) as CodeMap;

const MAP: CodeMap = {
  pages: {
    'docs/a.md': ['src/a/'],
    'docs/b.md': ['src/b.ts', 'src/a/shared.ts'],
    'docs/c.md': [],
  },
};

describe('covers', () => {
  it('matches a file exactly and a directory by prefix', () => {
    expect(covers('src/b.ts', 'src/b.ts')).toBe(true);
    expect(covers('src/b.ts', 'src/b.tsx')).toBe(false);
    expect(covers('src/a/', 'src/a/deep/x.ts')).toBe(true);
    expect(covers('src/a/', 'src/ab/x.ts')).toBe(false);
  });
});

describe('stalePages', () => {
  it("lists a page whose code changed and the page didn't", () => {
    expect(stalePages(MAP, ['src/a/x.ts'])).toEqual([
      { page: 'docs/a.md', changed: ['src/a/x.ts'] },
    ]);
  });

  it('lists every page a file belongs to', () => {
    expect(stalePages(MAP, ['src/a/shared.ts'])).toEqual([
      { page: 'docs/a.md', changed: ['src/a/shared.ts'] },
      { page: 'docs/b.md', changed: ['src/a/shared.ts'] },
    ]);
  });

  it('leaves out a page the change also changes', () => {
    expect(stalePages(MAP, ['src/a/x.ts', 'docs/a.md'])).toEqual([]);
  });

  it("doesn't count tests or snapshots", () => {
    expect(
      stalePages(MAP, [
        'src/a/x.test.ts',
        'src/a/y.spec.ts',
        'src/a/__snapshots__/x.test.ts.snap',
      ])
    ).toEqual([]);
  });
});

describe('report', () => {
  it('annotates each stale page and tables them in the summary', () => {
    const { annotations, summary } = report([
      { page: 'docs/a.md', changed: ['src/a/x.ts', 'src/a/y.ts'] },
    ]);
    expect(annotations).toEqual([
      '::warning file=docs/a.md,title=Docs may be out of date::This pull request changes src/a/x.ts, src/a/y.ts but not docs/a.md. Check that the page still describes the code.',
    ]);
    expect(summary).toContain('| `docs/a.md` | `src/a/x.ts`, `src/a/y.ts` |');
  });

  it('says so when no page is stale', () => {
    expect(report([])).toEqual({
      annotations: [],
      summary: expect.stringContaining('is changed too'),
    });
  });
});

describe('docs/code-map.json', () => {
  it('lists every current page in docs/', () => {
    const pages = readdirSync(path.join(REPO, 'docs'))
      .filter((file) => file.endsWith('.md') && !file.startsWith('migration-'))
      .map((file) => `docs/${file}`)
      .sort();
    expect(Object.keys(CODE_MAP.pages).sort()).toEqual(pages);
  });

  it('names only paths that exist', () => {
    const missing = Object.entries(CODE_MAP.pages).flatMap(([page, paths]) =>
      [page, ...paths].filter((file) => !existsSync(path.join(REPO, file)))
    );
    expect(missing).toEqual([]);
  });
});

describe('node scripts/docs-coverage.ts', () => {
  function run(files: string[]): string {
    return execFileSync(process.execPath, [SCRIPT, ...files], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
  }

  it("warns on the repo's map for changed code without its page", () => {
    expect(run(['src/llm/endpoint.ts'])).toContain(
      '::warning file=docs/llm-gateways.md,'
    );
  });

  it('prints that every page is current, and exits 0, otherwise', () => {
    expect(run(['src/llm/endpoint.ts', 'docs/llm-gateways.md'])).toContain(
      'is changed too'
    );
  });
});
