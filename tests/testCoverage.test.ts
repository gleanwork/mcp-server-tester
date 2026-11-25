import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compactCoverageDir,
  compactProcessCoverage,
  reportChildCoverage,
  type RawProcessCoverage,
} from '../scripts/test-coverage.js';

const ROOT = '/repo';
const url = (file: string) => pathToFileURL(path.join(ROOT, file)).href;

function script(file: string) {
  return { url: url(file), functions: [] };
}

describe('compactProcessCoverage', () => {
  it("keeps the repository's src/ and dist/ scripts and each source map once", () => {
    const report: RawProcessCoverage = {
      timestamp: 1,
      result: [
        script('dist/cli/index.js'),
        script('src/a.ts'),
        script('node_modules/zod/index.js'),
        // Every process a Vitest test starts loads this through NODE_OPTIONS.
        script('node_modules/vitest/suppress-warnings.cjs'),
        { url: 'node:internal/fs', functions: [] },
      ],
      'source-map-cache': {
        [url('dist/cli/index.js')]: { data: 'cli' },
        [url('src/a.ts')]: { data: 'a' },
        [url('node_modules/zod/index.js')]: { data: 'zod' },
      },
    };
    const kept = new Set<string>();
    expect(compactProcessCoverage(report, ROOT, kept)).toEqual({
      timestamp: 1,
      result: [script('dist/cli/index.js'), script('src/a.ts')],
      'source-map-cache': {
        [url('dist/cli/index.js')]: { data: 'cli' },
        [url('src/a.ts')]: { data: 'a' },
      },
    });
    // A second process with the same scripts doesn't repeat the maps.
    expect(compactProcessCoverage(report, ROOT, kept)).toEqual({
      timestamp: 1,
      result: [script('dist/cli/index.js'), script('src/a.ts')],
    });
  });

  it('drops Vitest and its workers, and processes that ran none of our code', () => {
    const kept = new Set<string>();
    expect(
      compactProcessCoverage(
        {
          result: [
            script('node_modules/vitest/dist/workers/forks.js'),
            script('src/a.ts'),
          ],
        },
        ROOT,
        kept
      )
    ).toBeNull();
    expect(
      compactProcessCoverage(
        { result: [script('node_modules/zod/index.js')] },
        ROOT,
        kept
      )
    ).toBeNull();
  });
});

describe('compactCoverageDir', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compacts each raw file, deletes it, and skips a partial one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-test-coverage-'));
    dirs.push(dir);
    const raw = path.join(dir, 'raw');
    const out = path.join(dir, 'out');
    fs.mkdirSync(raw);
    fs.writeFileSync(
      path.join(raw, 'coverage-1.json'),
      JSON.stringify({ result: [script('src/a.ts')] })
    );
    fs.writeFileSync(
      path.join(raw, 'coverage-2.json'),
      JSON.stringify({ result: [script('node_modules/zod/index.js')] })
    );
    // A process killed while writing.
    fs.writeFileSync(path.join(raw, 'coverage-3.json'), '{"result": [');
    fs.writeFileSync(path.join(raw, 'notes.txt'), 'not coverage');

    expect(compactCoverageDir(raw, out, ROOT)).toBe(1);
    expect(fs.readdirSync(out)).toEqual(['coverage-1.json']);
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'coverage-1.json'), 'utf8'))
    ).toEqual({
      result: [script('src/a.ts')],
    });
    expect(fs.readdirSync(raw)).toEqual(['notes.txt']);
  });

  it("maps a child process's coverage, with the lines it didn't run at zero", async () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mst-test-coverage-'))
    );
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/a.mjs'),
      [
        'function ran() {',
        '  return 1;',
        '}',
        'function neverRan() {',
        '  return 2;',
        '}',
        'ran();',
        '',
      ].join('\n')
    );
    const raw = path.join(dir, 'raw');
    execFileSync(process.execPath, [path.join(dir, 'src/a.mjs')], {
      env: { ...process.env, NODE_V8_COVERAGE: raw, NODE_OPTIONS: '' },
    });
    expect(compactCoverageDir(raw, path.join(dir, 'compact'), dir)).toBe(1);

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await reportChildCoverage(
        path.join(dir, 'compact'),
        path.join(dir, 'out')
      );
    } finally {
      process.chdir(cwd);
    }
    const map = JSON.parse(
      fs.readFileSync(path.join(dir, 'out/coverage-final.json'), 'utf8')
    ) as Record<
      string,
      {
        statementMap: Record<string, { start: { line: number } }>;
        s: Record<string, number>;
      }
    >;
    const file = map[path.join(dir, 'src/a.mjs')]!;
    const runs = Object.fromEntries(
      Object.entries(file.statementMap).map(([id, loc]) => [
        loc.start.line,
        file.s[id],
      ])
    );
    expect(runs[2]).toBe(1);
    expect(runs[5]).toBe(0);
  });
});
