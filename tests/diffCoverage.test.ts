import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  annotations,
  applyUntested,
  formatRanges,
  isCheckedFile,
  lineHits,
  parseChangedLines,
  parseUntested,
  report,
  uncoveredLines,
  type CoverageMap,
  type FileCoverage,
} from '../scripts/diff-coverage.js';

const SCRIPT = fileURLToPath(
  new URL('../scripts/diff-coverage.ts', import.meta.url)
);

/** Coverage with one statement per listed line and the given run counts. */
function coverage(lines: Record<number, number>): FileCoverage {
  const statementMap: FileCoverage['statementMap'] = {};
  const s: FileCoverage['s'] = {};
  for (const [index, [line, runs]] of Object.entries(lines).entries()) {
    statementMap[String(index)] = { start: { line: Number(line) } };
    s[String(index)] = runs;
  }
  return { statementMap, s };
}

describe('isCheckedFile', () => {
  it.each([
    ['src/cli/index.ts', true],
    ['src/reporters/ui-src/App.tsx', false],
    ['src/cli/index.test.ts', false],
    ['src/types/generated.d.ts', false],
    ['tests/repoShape.ts', false],
    ['scripts/diff-coverage.ts', false],
    ['src/evals/cowork/helper.swift', false],
  ])('%s: %s', (file, checked) => {
    expect(isCheckedFile(file)).toBe(checked);
  });
});

describe('parseChangedLines', () => {
  it('reads the added lines of each checked file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ x',
      '-old',
      '+new',
      '@@ -10,0 +11,3 @@',
      '+one',
      '+two',
      '+three',
      '@@ -20,2 +23,0 @@',
      '-gone',
      '-gone',
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      '--- a/src/a.test.ts',
      '+++ b/src/a.test.ts',
      '@@ -1 +1 @@',
      '+test',
      'diff --git a/src/b.ts b/src/b.ts',
      'deleted file mode 100644',
      '--- a/src/b.ts',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -5,2 +5,0 @@',
    ].join('\n');
    expect(parseChangedLines(diff)).toEqual(
      new Map([['src/a.ts', new Set([3, 11, 12, 13])]])
    );
  });
});

describe('lineHits', () => {
  const root = '/repo';

  it('takes lines from the statement maps and adds runs from the extra maps', () => {
    const unit: CoverageMap = {
      '/repo/src/a.ts': coverage({ 1: 1, 2: 0, 3: 0 }),
    };
    // Line-by-line coverage of a child process: line 4 is a comment there.
    const children: CoverageMap = {
      '/repo/src/a.ts': coverage({ 1: 2, 2: 0, 3: 5, 4: 0 }),
      '/repo/src/only-children.ts': coverage({ 1: 0 }),
    };
    expect(lineHits([unit], [children], root)).toEqual(
      new Map([
        [
          'src/a.ts',
          new Map([
            [1, 3],
            [2, 0],
            [3, 5],
          ]),
        ],
      ])
    );
  });

  it('counts a line by the statement on it that ran most', () => {
    const unit: CoverageMap = {
      '/repo/src/a.ts': {
        statementMap: { 0: { start: { line: 7 } }, 1: { start: { line: 7 } } },
        s: { 0: 0, 1: 4 },
      },
    };
    expect(lineHits([unit], [], root).get('src/a.ts')).toEqual(
      new Map([[7, 4]])
    );
  });
});

describe('parseUntested', () => {
  it('reads paths, ranges and reasons under the heading only', () => {
    const body = [
      '## Summary',
      '- `src/ignored.ts`: not in the section',
      '',
      '### Untested',
      'None of these run on Linux: `src/prose.ts` is not an entry.',
      '- `src/evals/cowork/macos.ts`: drives the macOS app.',
      '* `src/cli/index.ts:120-134` - only without a TTY on Windows',
      '- `./src/a.ts:7` the one line',
      '- `src/b.ts`',
      '- no path at all',
      '```',
      '- `src/fenced.ts`: in a code block',
      '```',
      '## Checks',
      '- `src/after.ts`: after the section',
    ].join('\n');
    expect(parseUntested(body)).toEqual({
      entries: [
        {
          file: 'src/evals/cowork/macos.ts',
          lines: null,
          reason: 'drives the macOS app.',
        },
        {
          file: 'src/cli/index.ts',
          lines: { start: 120, end: 134 },
          reason: 'only without a TTY on Windows',
        },
        {
          file: 'src/a.ts',
          lines: { start: 7, end: 7 },
          reason: 'the one line',
        },
      ],
      invalid: ['- `src/b.ts`', '- no path at all'],
    });
  });

  it("ignores the pull request template's comment", () => {
    const template = fs.readFileSync(
      fileURLToPath(
        new URL('../.github/pull_request_template.md', import.meta.url)
      ),
      'utf8'
    );
    expect(template).toContain('## Untested');
    expect(parseUntested(template)).toEqual({ entries: [], invalid: [] });
    expect(
      parseUntested(
        '## Untested\n<!--\n- not an entry\n-->\n- `src/a.ts`: real'
      )
    ).toEqual({
      entries: [{ file: 'src/a.ts', lines: null, reason: 'real' }],
      invalid: [],
    });
  });

  it('finds nothing without the heading', () => {
    expect(parseUntested('## Summary\n- `src/a.ts`: x')).toEqual({
      entries: [],
      invalid: [],
    });
  });
});

describe('uncoveredLines and applyUntested', () => {
  const changed = new Map([
    ['src/a.ts', new Set([1, 2, 3, 4])],
    ['src/b.ts', new Set([10])],
    ['src/untracked.ts', new Set([1])],
  ]);
  const hits = new Map([
    [
      'src/a.ts',
      new Map([
        [1, 1],
        [2, 0],
        [3, 0],
      ]),
    ],
    ['src/b.ts', new Map([[10, 0]])],
  ]);

  it('lists changed lines with a statement that never ran', () => {
    expect(uncoveredLines(changed, hits)).toEqual(
      new Map([
        ['src/a.ts', new Set([2, 3])],
        ['src/b.ts', new Set([10])],
      ])
    );
  });

  it('excuses a whole file or a line range', () => {
    const { excused, failing } = applyUntested(uncoveredLines(changed, hits), [
      { file: 'src/a.ts', lines: { start: 3, end: 5 }, reason: 'r' },
      { file: 'src/b.ts', lines: null, reason: 'r' },
    ]);
    expect(excused).toEqual(
      new Map([
        ['src/a.ts', new Set([3])],
        ['src/b.ts', new Set([10])],
      ])
    );
    expect(failing).toEqual(new Map([['src/a.ts', new Set([2])]]));
  });
});

describe('report', () => {
  const changed = new Map([['src/a.ts', new Set([1, 2, 3, 5])]]);
  const hits = new Map([
    [
      'src/a.ts',
      new Map([
        [1, 0],
        [2, 0],
        [3, 0],
        [5, 0],
      ]),
    ],
  ]);

  it('fails and names the lines no test runs', () => {
    const result = report(changed, hits, { entries: [], invalid: [] });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(
      '4 changed lines in src/ run in no test:\n  src/a.ts:1-3, 5'
    );
    expect(result.text).toContain('## Untested');
  });

  it('passes when ## Untested excuses every line', () => {
    const result = report(changed, hits, {
      entries: [{ file: 'src/a.ts', lines: null, reason: 'r' }],
      invalid: [],
    });
    expect(result).toEqual({
      ok: true,
      text: [
        'Excused by ## Untested: src/a.ts:1-3, 5',
        'Every changed line in src/ that has a statement runs in a test.',
      ].join('\n'),
    });
  });

  it('fails on an ## Untested line with no path or reason', () => {
    const result = report(new Map(), new Map(), {
      entries: [],
      invalid: ['- fix later'],
    });
    expect(result).toEqual({
      ok: false,
      text: '## Untested item names no `path` or gives no reason: - fix later',
    });
  });
});

it('formatRanges joins runs of lines', () => {
  expect(formatRanges([9, 3, 4, 5, 12, 13])).toBe('3-5, 9, 12-13');
});

it('annotations mark each range in the diff', () => {
  expect(annotations(new Map([['src/a.ts', new Set([4, 2, 3, 9])]]))).toEqual([
    '::error file=src/a.ts,line=2,endLine=4,title=No test runs this::Add a test, or name it under ## Untested in the pull request description.',
    '::error file=src/a.ts,line=9,endLine=9,title=No test runs this::Add a test, or name it under ## Untested in the pull request description.',
  ]);
});

describe('the script', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A repository whose last commit adds lines 3-4 to src/a.ts, with
   * coverage where only line 3 ran.
   */
  function repo(): string {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mst-diff-coverage-'))
    );
    dirs.push(dir);
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], {
        cwd: dir,
      });
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/a.ts'),
      'export const a = 1;\nexport const b = 2;\n'
    );
    git('add', '.');
    git('commit', '-qm', 'one');
    fs.appendFileSync(
      path.join(dir, 'src/a.ts'),
      'export const c = 3;\nexport const d = 4;\n'
    );
    git('commit', '-qam', 'two');
    const file = path.join(dir, 'src/a.ts');
    fs.writeFileSync(
      path.join(dir, 'unit.json'),
      JSON.stringify({ [file]: coverage({ 1: 1, 2: 1, 3: 0, 4: 0 }) })
    );
    fs.writeFileSync(
      path.join(dir, 'children.json'),
      JSON.stringify({ [file]: coverage({ 3: 1, 4: 0 }) })
    );
    return dir;
  }

  const ARGS = [
    '--range',
    'HEAD^..HEAD',
    '--unit',
    'unit.json',
    '--children',
    'children.json',
  ];

  function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        GITHUB_EVENT_PATH: '',
        ...env,
      },
    });
  }

  it('fails on a changed line only the child coverage could have run, and did not', () => {
    const result = run(repo(), ARGS);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '1 changed lines in src/ run in no test:\n  src/a.ts:4'
    );
    expect(result.stdout).not.toContain('::error');
  });

  it('annotates the lines in GitHub Actions', () => {
    const result = run(repo(), ARGS, { GITHUB_ACTIONS: 'true' });
    expect(result.stdout).toContain('::error file=src/a.ts,line=4,endLine=4');
  });

  it('passes with the line under ## Untested in --body-file', () => {
    const dir = repo();
    fs.writeFileSync(
      path.join(dir, 'body.md'),
      '## Untested\n- `src/a.ts:4`: reason\n'
    );
    const result = run(dir, [...ARGS, '--body-file', 'body.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Excused by ## Untested: src/a.ts:4');
  });

  it('reads the description from GitHub, not from the event', async () => {
    const dir = repo();
    const requests: Array<{ url?: string; auth?: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, auth: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          body: '## Untested\n- `src/a.ts`: edited after the run started',
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const event = path.join(dir, 'event.json');
      fs.writeFileSync(
        event,
        JSON.stringify({ pull_request: { number: 7, body: 'stale' } })
      );
      const { port } = server.address() as AddressInfo;
      // Async, so this process's server can answer.
      const child = spawn(process.execPath, [SCRIPT, ...ARGS], {
        cwd: dir,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_PATH: event,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_REPOSITORY: 'acme/repo',
          GITHUB_TOKEN: 'token-1',
        },
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      const status = await new Promise<number | null>((resolve) =>
        child.on('close', resolve)
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Excused by ## Untested: src/a.ts:4');
      expect(requests).toEqual([
        { url: '/repos/acme/repo/pulls/7', auth: 'Bearer token-1' },
      ]);
    } finally {
      server.close();
    }
  });

  it('fails when GitHub does not return the description', async () => {
    const dir = repo();
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end('Not Found');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const event = path.join(dir, 'event.json');
      fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
      const { port } = server.address() as AddressInfo;
      const child = spawn(process.execPath, [SCRIPT, ...ARGS], {
        cwd: dir,
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: event,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_REPOSITORY: 'acme/repo',
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const status = await new Promise<number | null>((resolve) =>
        child.on('close', resolve)
      );
      expect(status).toBe(1);
      expect(stderr).toContain(
        'Reading the pull request failed: 404 Not Found'
      );
    } finally {
      server.close();
    }
  });

  it('reads no description outside a pull request', () => {
    const dir = repo();
    const event = path.join(dir, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' }));
    const result = run(dir, ARGS, { GITHUB_EVENT_PATH: event });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/a.ts:4');
  });

  it('says how to make the coverage when a file is missing', () => {
    const result = run(repo(), [
      '--range',
      'HEAD^..HEAD',
      '--unit',
      'nope.json',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'nope.json is missing. Run `npm run test:coverage` first.'
    );
  });
});
