import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import {
  RUN_ID_PATTERN,
  RUN_SCHEMAS,
  assertUniqueCaseIds,
  assertUniqueVariantNames,
  newRunId,
} from './runFormat.js';
import { runJsonSchema } from './runSchemas.js';
import { RUN_FORMAT, assertRunFormat } from './resultFormat.js';

let dir: string;

const plugin: Plugin = {
  meta: { name: 'run-format', namespace: 'rf' },
  clients: {
    echo: {
      schema: z.object({ type: z.string() }).strict(),
      evidence: 'structured',
      run: async (input) => ({ finalText: `echo ${input.prompt}`, events: [] }),
    },
  },
  judges: {
    a: { schema: z.object({}), evaluate: async () => ({ score: 1 }) },
    b: { schema: z.object({}), evaluate: async () => ({ score: 0.5 }) },
  },
  pairwiseJudges: {
    p: {
      schema: z.object({}),
      compare: async () => ({ preference: 'tie' as const }),
    },
  },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-format-'));
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        { id: 'a/one', input: 'hello', assertions: { containsText: 'hello' } },
        { id: 'b', input: 'bye', assertions: { containsText: 'nope' } },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'run-format',
      datasets: ['./cases.json'],
      client: 'rf/client/echo',
      servers: {},
      trials: 2,
      variants: [{ name: 'base' }, { name: 'other' }],
    })
  );
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

async function files(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name))
    )
    .sort();
}

const read = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

const run = (options: { cases?: string[] } = {}) =>
  runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    ...options,
  });

describe('the mst.run/v1 layout', () => {
  it('writes run.json, a trace and a score per grader per trial, results and summary', async () => {
    const result = await run();
    const evalDir = path.join(dir, '.mcp-test-results', 'run-format');
    const runId = path.basename(result.outputDir);
    expect(runId).toMatch(RUN_ID_PATTERN);
    expect(result.outputDir).toBe(path.join(evalDir, 'runs', runId));

    // report/ is the reporter UI and its data; the rest is the format.
    const all = await files(result.outputDir);
    expect(all).toContain(path.join('report', 'index.html'));
    const tree = all.filter((file) => !file.startsWith(`report${path.sep}`));
    const trial = (variant: string, id: string, n: number) =>
      `traces/${variant}/${encodeURIComponent(id)}/${n}.json`;
    const score = (variant: string, id: string, n: number) =>
      `scores/textContains/${variant}/${encodeURIComponent(id)}/${n}.json`;
    const expected = ['base', 'other'].flatMap((variant) =>
      ['a/one', 'b'].flatMap((id) =>
        [0, 1].flatMap((n) => [trial(variant, id, n), score(variant, id, n)])
      )
    );
    expect(tree).toEqual(
      [...expected, 'results.json', 'run.json', 'summary.json'].sort()
    );

    // Every file has the format and its kind, and parses with its schema.
    for (const file of tree) {
      const value = await read(path.join(result.outputDir, file));
      expect(value.format).toBe(RUN_FORMAT);
      const kind = value.kind as keyof typeof RUN_SCHEMAS;
      expect(RUN_SCHEMAS[kind].safeParse(value).success).toBe(true);
    }

    const runRecord = await read(path.join(result.outputDir, 'run.json'));
    expect(runRecord).toMatchObject({
      runId,
      evalName: 'run-format',
      baseline: 'base',
      partial: false,
      variants: [
        { name: 'base', client: 'rf/client/echo' },
        { name: 'other', client: 'rf/client/echo' },
      ],
      datasets: [{ name: 'cases', caseCount: 2 }],
      phases: { collect: 'complete', grade: 'complete' },
    });
    const failed = await read(
      path.join(result.outputDir, score('base', 'b', 1))
    );
    expect(failed).toMatchObject({
      grader: 'textContains',
      variant: 'base',
      caseId: 'b',
      trial: 1,
      score: { pass: false },
    });
    const results = await read(path.join(result.outputDir, 'results.json'));
    expect((results.cases as unknown[]).length).toBe(4);
    const summary = await read(path.join(result.outputDir, 'summary.json'));
    expect(summary.results).toBeUndefined();
    for (const variant of summary.variants as Array<{ result?: object }>)
      expect(variant.result).not.toHaveProperty('caseResults');
    expect(summary.runId).toBe(runId);

    expect(await read(path.join(evalDir, 'latest.json'))).toEqual({
      format: RUN_FORMAT,
      kind: 'latest',
      runId,
      createdAt: result.summary.timestamp,
      path: `runs/${runId}`,
    });
  });

  it("a partial run doesn't move latest.json", async () => {
    const full = await run();
    const partial = await run({ cases: ['b'] });
    const latest = await read(
      path.join(dir, '.mcp-test-results', 'run-format', 'latest.json')
    );
    expect(latest.runId).toBe(path.basename(full.outputDir));
    expect(path.basename(partial.outputDir)).not.toBe(latest.runId);
  });

  it('compares a run with the previous run in runs/', async () => {
    const first = await run();
    const second = await run();
    expect(second.summary.previousRun?.runId).toBe(
      path.basename(first.outputDir)
    );
  });
});

describe('judges, pairwise judges and long case IDs', () => {
  it('write one score file per judge, preferences under scores/, and bounded paths', async () => {
    const longId = `case-${'x'.repeat(300)}`;
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [{ id: longId, input: 'hello' }],
      })
    );
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'run-format',
        datasets: ['./cases.json'],
        client: 'rf/client/echo',
        servers: {},
        judges: ['rf/judge/a', 'rf/judge/b'],
        pairwiseJudges: ['rf/pairwise-judge/p'],
        variants: [{ name: 'base' }, { name: 'other' }],
      })
    );
    const result = await run();
    // report/ is the reporter UI and its data; the rest is the format.
    const all = await files(result.outputDir);
    expect(all).toContain(path.join('report', 'index.html'));
    const tree = all.filter((file) => !file.startsWith(`report${path.sep}`));
    for (const file of tree)
      for (const part of file.split(path.sep))
        expect(Buffer.byteLength(part)).toBeLessThanOrEqual(255);
    const graders = new Set(
      tree
        .filter((file) => file.startsWith('scores'))
        .map((file) => decodeURIComponent(file.split(path.sep)[1]!))
    );
    expect([...graders].sort()).toEqual([
      'judge.rf/judge/a',
      'judge.rf/judge/b',
      'rf/pairwise-judge/p',
    ]);
    const preferences = tree.filter((file) =>
      file.startsWith(
        path.join('scores', encodeURIComponent('rf/pairwise-judge/p'))
      )
    );
    expect(preferences).toHaveLength(1);
    const preference = await read(path.join(result.outputDir, preferences[0]!));
    expect(preference).toMatchObject({
      kind: 'preference',
      variant: 'other',
      baseline: 'base',
      caseId: longId,
      preference: { judge: 'rf/pairwise-judge/p', preference: 'tie' },
    });
    expect(RUN_SCHEMAS.preference.safeParse(preference).success).toBe(true);
    const runRecord = await read(path.join(result.outputDir, 'run.json'));
    expect(runRecord.judges).toEqual([
      { type: 'rf/judge/a', level: 'config', optionsHash: expect.any(String) },
      { type: 'rf/judge/b', level: 'config', optionsHash: expect.any(String) },
      {
        type: 'rf/pairwise-judge/p',
        level: 'pairwise',
        optionsHash: expect.any(String),
      },
    ]);
  });
});

describe('run IDs', () => {
  it('sort by start time and end in 6 hex characters', () => {
    const early = newRunId(new Date('2026-10-07T18:25:04.123Z'));
    const late = newRunId(new Date('2026-10-07T18:25:05.000Z'));
    expect(early).toMatch(/^20261007T182504Z-[0-9a-f]{6}$/);
    expect(early < late).toBe(true);
  });
});

describe('case IDs', () => {
  it('must be unique within a run', () => {
    expect(() =>
      assertUniqueCaseIds([
        { name: 'one', cases: [{ id: 'x', input: 'a' }] },
        { name: 'two', cases: [{ id: 'x', input: 'b' }] },
      ])
    ).toThrow('Case "x" is in datasets "one" and "two".');
    expect(() =>
      assertUniqueCaseIds([
        {
          name: 'one',
          cases: [
            { id: 'x', input: 'a' },
            { id: 'x', input: 'b' },
          ],
        },
      ])
    ).toThrow('Dataset "one" has case "x" twice.');
  });

  it("can't differ only in case: macOS and Windows paths ignore it", () => {
    expect(() =>
      assertUniqueCaseIds([
        {
          name: 'one',
          cases: [
            { id: 'Search', input: 'a' },
            { id: 'search', input: 'b' },
          ],
        },
      ])
    ).toThrow(/twice/);
    expect(() => assertUniqueVariantNames(['A', 'a'])).toThrow(
      'Variants "A" and "a" differ only in case.'
    );
  });
});

describe('older and newer formats', () => {
  it('ask to rerun or to upgrade', () => {
    expect(() => assertRunFormat({ schemaVersion: 2 }, 'Run x')).toThrow(
      'Run x was written by an earlier MST.'
    );
    expect(() => assertRunFormat({ format: 'mst.run/v2' }, 'Run x')).toThrow(
      'Run x was written by a newer MST (mst.run/v2). Upgrade MST to read it.'
    );
    expect(() =>
      assertRunFormat({ format: RUN_FORMAT }, 'Run x')
    ).not.toThrow();
  });
});

describe('published schemas', () => {
  it('match schema/run/v1 (run `npm run schema:generate`)', async () => {
    for (const kind of Object.keys(RUN_SCHEMAS) as Array<
      keyof typeof RUN_SCHEMAS
    >) {
      const committed = JSON.parse(
        await fs.readFile(
          path.join(
            process.cwd(),
            'schema',
            'run',
            'v1',
            `${kind}.schema.json`
          ),
          'utf8'
        )
      ) as unknown;
      expect(committed).toEqual(runJsonSchema(kind));
    }
  });
});
