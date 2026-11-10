import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import type {
  RecordedWrite,
  UnclassifiedCall,
  WriteRecord,
} from '../types/index.js';
import type { TrialEnding } from '../types/trialEnding.js';
import type {
  TranscriptEvent,
  TranscriptEvidence,
} from './evalFrameworkTypes.js';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import {
  RUN_ID_PATTERN,
  RUN_SCHEMAS,
  assertUniqueCaseIds,
  assertUniqueVariantNames,
  newRunId,
  parseCalibrationRecord,
  parseLabelRecord,
  readRunDirectory,
  readRunTrials,
} from './runFormat.js';
import { runJsonSchema } from './runSchemas.js';
import { buildHistory, localHistoryLocation } from './runHistory.js';
import { RUN_FORMAT, assertRunFormat } from './resultFormat.js';

let dir: string;

const plugin: Plugin = {
  meta: { name: 'run-format', namespace: 'rf' },
  clients: {
    echo: {
      schema: z.object({ type: z.string() }).strict(),
      evidence: 'structured',
      run: async (input) => ({
        finalText: `echo ${input.prompt}`,
        events: [
          {
            kind: 'tool_call',
            source: 'mcp',
            server: 'docs',
            name: 'docs.echo',
            arguments: { text: input.prompt },
            output: input.prompt,
          },
        ],
      }),
    },
  },
  judges: {
    a: { schema: z.object({}), evaluate: async () => ({ score: 1 }) },
    b: { schema: z.object({}), evaluate: async () => ({ score: 0.5 }) },
    // Parsing changes the options: parsing them twice would change them again.
    scaled: {
      schema: z.object({ count: z.number().transform((n) => n * 3) }),
      evaluate: async () => ({ score: 1 }),
    },
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
  it('writes run.json, a transcript and a score per grader per trial, results and summary', async () => {
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
      `transcripts/${variant}/${encodeURIComponent(id)}/${n}.json`;
    const score = (variant: string, id: string, n: number) =>
      `scores/containsText/${variant}/${encodeURIComponent(id)}/${n}.json`;
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
      grader: 'containsText',
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
    const identity = expect.stringMatching(/^[0-9a-f]{64}$/);
    // The test plugin has no version, nor do its judges: MST can't see
    // them change, so their calibrations would be unversioned.
    expect(runRecord.judges).toEqual([
      {
        type: 'rf/judge/a',
        level: 'config',
        optionsHash: expect.any(String),
        identity,
        unversioned: true,
      },
      {
        type: 'rf/judge/b',
        level: 'config',
        optionsHash: expect.any(String),
        identity,
        unversioned: true,
      },
      {
        type: 'rf/pairwise-judge/p',
        level: 'pairwise',
        optionsHash: expect.any(String),
        identity,
        unversioned: true,
      },
    ]);
    expect(RUN_SCHEMAS.run.safeParse(runRecord).success).toBe(true);
  });

  it("record the same identity in run.json as on the judge's scores, when its schema transforms its options", async () => {
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'run-format',
        datasets: ['./cases.json'],
        client: 'rf/client/echo',
        servers: {},
        judges: [{ type: 'rf/judge/scaled', count: 3 }],
        variants: [
          { name: 'base' },
          { name: 'other', judges: [{ type: 'rf/judge/scaled', count: 4 }] },
        ],
      })
    );
    const result = await run();
    const runRecord = await read(path.join(result.outputDir, 'run.json'));
    const recorded = Object.fromEntries(
      (runRecord.judges as Array<{ level: string; identity: string }>).map(
        (judge) => [judge.level, judge.identity]
      )
    );
    const scored = (variant: string) =>
      new Set(
        result.summary.results
          .filter((r) => r.variant === variant)
          // One judge's score is the judge score itself.
          .map((r) => r.scores?.judge?.judgeIdentity)
      );
    expect(scored('base')).toEqual(new Set([recorded.config]));
    expect(scored('other')).toEqual(new Set([recorded['variant:other']]));
    expect(recorded.config).not.toBe(recorded['variant:other']);
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

  it('refuse a run a release candidate stored with the old score keys', async () => {
    const result = await run();
    await fs.rename(
      path.join(result.outputDir, 'scores', 'containsText'),
      path.join(result.outputDir, 'scores', 'textContains')
    );
    await expect(readRunDirectory(result.outputDir)).rejects.toThrow(
      `${result.outputDir} was stored by an MST 2.0 prerelease, before its score keys took their assertions' names (textContains → containsText, regex → matchesPattern; see docs/migrations/2.0-prereleases.md#score-keys-are-assertion-keys). This MST can't read it: run the eval again.`
    );
  });

  it('refuse an interrupted run whose results have the old score keys', async () => {
    const result = await run();
    // Stopped before its scores: results.json, but no scores/.
    await fs.rm(path.join(result.outputDir, 'scores'), {
      recursive: true,
      force: true,
    });
    const file = path.join(result.outputDir, 'results.json');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replaceAll(
        '"containsText"',
        '"textContains"'
      )
    );
    await expect(readRunDirectory(result.outputDir)).rejects.toThrow(
      `${file} was written by an MST 2.0 prerelease, before its score keys took their assertions' names`
    );
  });

  it("refuse a run a release candidate stored before ADR 0013's renames", async () => {
    const result = await run();
    const runJson = path.join(result.outputDir, 'run.json');
    const { runner, ...record } = await read(runJson);
    await fs.writeFile(
      runJson,
      JSON.stringify({ ...record, environment: runner })
    );
    await expect(readRunDirectory(result.outputDir)).rejects.toThrow(
      `${result.outputDir} was stored by an MST 2.0 release candidate, before ADR 0013 renamed environment to runner. This MST can't read it: run the eval again.`
    );
  });
});

describe('what writers can write', () => {
  type Stored = z.infer<typeof RUN_SCHEMAS.trial>;
  type StoredWrites = NonNullable<Stored['writeRecord']>;
  type StoredTranscript = NonNullable<Stored['transcript']>;

  // `writeRun` casts a trial's transcript and write record to the reader's
  // types. These fail to compile when a writer can make a value the reader
  // rejects, so a new value lands in both or neither.
  it('is what readers accept, for every closed field', () => {
    expectTypeOf<RecordedWrite['mode']>().toExtend<
      StoredWrites['writes'][number]['mode']
    >();
    expectTypeOf<UnclassifiedCall['reason']>().toExtend<
      StoredWrites['unclassified'][number]['reason']
    >();
    expectTypeOf<WriteRecord['attribution']>().toExtend<
      StoredWrites['attribution']
    >();
    expectTypeOf<TranscriptEvidence>().toExtend<
      NonNullable<StoredTranscript['evidence']>
    >();
    expectTypeOf<TranscriptEvent['kind']>().toExtend<
      StoredTranscript['events'][number]['kind']
    >();
    expectTypeOf<TranscriptEvent['source']>().toExtend<
      NonNullable<StoredTranscript['events'][number]['source']>
    >();
    expectTypeOf<TrialEnding>().toExtend<NonNullable<Stored['ending']>>();
  });
});

describe('fields and values this MST does not know', () => {
  const trialFile = async (outputDir: string) =>
    path.join(
      outputDir,
      (await files(outputDir)).find((file) =>
        file.startsWith(`transcripts${path.sep}`)
      )!
    );

  it('are kept at every depth when a trial is read', async () => {
    const result = await run();
    const file = await trialFile(result.outputDir);
    const trial = await read(file);
    const transcript = trial.transcript as {
      events: Array<Record<string, unknown>>;
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        ...trial,
        future: 1,
        ending: { kind: 'trial', future: 2 },
        transcript: {
          ...transcript,
          future: 3,
          events: [{ ...transcript.events[0], future: 4 }],
        },
      })
    );
    const read0 = (await readRunTrials(result.outputDir)).find(
      (t) => t.future === 1
    )!;
    expect(read0.ending).toEqual({ kind: 'trial', future: 2 });
    expect(read0.transcript).toMatchObject({
      future: 3,
      events: [{ kind: 'tool_call', future: 4 }],
    });
  });

  it('fail the read for a transcript event of a kind it does not know', async () => {
    const result = await run();
    const file = await trialFile(result.outputDir);
    const trial = await read(file);
    const transcript = trial.transcript as {
      events: Array<Record<string, unknown>>;
    };
    await fs.writeFile(
      file,
      JSON.stringify({
        ...trial,
        transcript: {
          ...transcript,
          events: [{ ...transcript.events[0], kind: 'handoff' }],
        },
      })
    );
    await expect(readRunTrials(result.outputDir)).rejects.toThrow(
      "It has a value this MST doesn't know at transcript.events[0].kind"
    );
  });

  it("fail history's row for a run whose results.json it can't read, and the previous-run comparison", async () => {
    const first = await run();
    const file = path.join(first.outputDir, 'results.json');
    const results = await read(file);
    const [one, ...rest] = results.cases as Array<Record<string, unknown>>;
    await fs.writeFile(
      file,
      JSON.stringify({
        ...results,
        cases: [{ ...one, ending: { kind: 'paused' } }, ...rest],
      })
    );
    const history = await buildHistory(
      localHistoryLocation(path.join(dir, '.mcp-test-results', 'run-format')),
      { rebuild: true }
    );
    expect(history.skipped).toEqual([
      expect.objectContaining({
        runId: path.basename(first.outputDir),
        reason: expect.stringContaining(
          "It has a value this MST doesn't know at cases[0].ending.kind"
        ),
      }),
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const second = await run();
      expect(second.summary.previousRun).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /Couldn't compare with the previous run: .*results\.json isn't a run's results\.json:.*Upgrade MST/s
        )
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("skip history's row for a run whose summary.json is malformed", async () => {
    const first = await run();
    const file = path.join(first.outputDir, 'summary.json');
    const summary = await read(file);
    // A field nothing after the read trips on: only the parse catches it.
    await fs.writeFile(file, JSON.stringify({ ...summary, configId: 7 }));
    const history = await buildHistory(
      localHistoryLocation(path.join(dir, '.mcp-test-results', 'run-format')),
      { rebuild: true }
    );
    expect(history.skipped.map((row) => row.runId)).toEqual([
      path.basename(first.outputDir),
    ]);
  });

  it('fail the read when a closed field has a value it does not know, and say to upgrade', async () => {
    const result = await run();
    const file = await trialFile(result.outputDir);
    const trial = await read(file);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...trial,
        ending: {
          kind: 'infrastructure',
          broke: 'quantum',
          retryable: false,
          reason: 'a newer kind of break',
        },
      })
    );
    await expect(readRunTrials(result.outputDir)).rejects.toThrow(
      `${file} isn't a trial:`
    );
    await expect(readRunTrials(result.outputDir)).rejects.toThrow(
      "It has a value this MST doesn't know at ending.broke: a newer MST may have written it. Upgrade MST to read it."
    );
  });

  it('fail with the upgrade message for a trial ending of a kind it does not know', async () => {
    const result = await run();
    const file = await trialFile(result.outputDir);
    const trial = await read(file);
    await fs.writeFile(
      file,
      JSON.stringify({ ...trial, ending: { kind: 'paused' } })
    );
    await expect(readRunTrials(result.outputDir)).rejects.toThrow(
      "It has a value this MST doesn't know at ending.kind"
    );
  });

  it("fail a run's results.json with a value it does not know", async () => {
    const result = await run();
    const file = path.join(result.outputDir, 'results.json');
    const results = await read(file);
    const [first, ...rest] = results.cases as Array<Record<string, unknown>>;
    await fs.writeFile(
      file,
      JSON.stringify({
        ...results,
        cases: [
          { ...first, ending: { kind: 'infrastructure', broke: 'quantum' } },
          ...rest,
        ],
      })
    );
    await expect(readRunDirectory(result.outputDir)).rejects.toThrow(
      `${file} isn't a run's results.json:`
    );
    await expect(readRunDirectory(result.outputDir)).rejects.toThrow(
      "It has a value this MST doesn't know at cases[0].ending.broke"
    );
  });

  it('say what is wrong, without the upgrade message, for a file that is only malformed', () => {
    const label = {
      format: RUN_FORMAT,
      kind: 'label',
      judge: 'rf/judge/a',
      variant: 'v',
      caseId: 'c',
      split: 'test',
      labeledAt: '2026-11-09T00:00:00.000Z',
      trial: 0,
      label: 'pass',
    };
    // The closest branch is a pointwise label missing its labeler: not the
    // pairwise branch's labels, which `pass` isn't one of.
    expect(() => parseLabelRecord(label, 'label.json')).toThrow(/labeler/);
    expect(() => parseLabelRecord(label, 'label.json')).not.toThrow(
      /Upgrade MST/
    );
    // The pairwise branch is the closest for a pairwise label, though the
    // pointwise branch comes first.
    const pairwise = {
      ...label,
      trial: undefined,
      baseline: 'r',
      label: 'tie',
    };
    expect(() => parseLabelRecord(pairwise, 'label.json')).toThrow(/labeler/);
    expect(() => parseLabelRecord(pairwise, 'label.json')).not.toThrow(
      /Upgrade MST/
    );
    // A closed field that is missing is malformed, not newer.
    const { split: _split, ...noSplit } = { ...label, labeler: 'me' };
    expect(() => parseLabelRecord(noSplit, 'label.json')).toThrow(/split/);
    expect(() => parseLabelRecord(noSplit, 'label.json')).not.toThrow(
      /Upgrade MST/
    );
    expect(() =>
      parseLabelRecord({ ...label, labeler: 'me', split: 'holdout' }, 'l.json')
    ).toThrow("It has a value this MST doesn't know at split");

    const calibration = {
      format: RUN_FORMAT,
      kind: 'calibration',
      judge: 'rf/judge/a',
      judgeIdentity: 'a'.repeat(64),
      judgeModels: [],
      createdAt: '2026-11-09T00:00:00.000Z',
      runs: ['r'],
      split: 'test',
      labels: 2,
      judgeKind: 'pairwise',
    };
    expect(() => parseCalibrationRecord(calibration, 'c.json')).toThrow(
      /agreement/
    );
    expect(() => parseCalibrationRecord(calibration, 'c.json')).not.toThrow(
      /Upgrade MST/
    );
    expect(() =>
      parseCalibrationRecord({ ...calibration, judgeKind: 'ranked' }, 'c.json')
    ).toThrow("It has a value this MST doesn't know at judgeKind");
    const { judgeKind: _kind, ...noKind } = calibration;
    expect(() => parseCalibrationRecord(noKind, 'c.json')).not.toThrow(
      /Upgrade MST/
    );
  });

  it('are kept in a calibration', () => {
    const rate = { k: 1, n: 2, value: 0.5, low: 0.1, high: 0.9, future: 1 };
    const record = parseCalibrationRecord(
      {
        format: RUN_FORMAT,
        kind: 'calibration',
        judge: 'rf/judge/a',
        judgeIdentity: 'a'.repeat(64),
        judgeModels: [],
        createdAt: '2026-11-09T00:00:00.000Z',
        runs: ['r'],
        split: 'test',
        labels: 2,
        unknown: rate,
        judgeKind: 'pairwise',
        agreement: rate,
        judgeTies: rate,
        humanTies: rate,
        future: { nested: true },
      },
      'calibration.json'
    );
    expect(record).toMatchObject({
      future: { nested: true },
      agreement: { future: 1 },
    });
  });
});

describe('published schemas', () => {
  it('describe a real run to an independent validator, transcripts and case results included', async () => {
    const result = await run();
    const ajv = new Ajv({ strict: true, allErrors: true });
    const validators = new Map<string, ValidateFunction>();
    const validatorFor = async (kind: string) => {
      const known = validators.get(kind);
      if (known) return known;
      const schema = JSON.parse(
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
      ) as Record<string, unknown>;
      const compiled = ajv.compile(schema);
      validators.set(kind, compiled);
      return compiled;
    };
    const tree = (await files(result.outputDir)).filter(
      (file) => !file.startsWith(`report${path.sep}`)
    );
    for (const file of tree) {
      const value = await read(path.join(result.outputDir, file));
      const validate = await validatorFor(String(value.kind));
      validate(value);
      expect({ file, errors: validate.errors ?? [] }).toEqual({
        file,
        errors: [],
      });
    }

    const trial = await read(
      path.join(
        result.outputDir,
        tree.find((file) => file.startsWith(`transcripts${path.sep}`))!
      )
    );
    expect(trial.transcript).toMatchObject({
      events: [{ kind: 'tool_call', name: 'docs.echo' }],
    });
    const validTrial = await validatorFor('trial');
    expect(
      validTrial({ ...trial, transcript: { events: 'x', finalText: 123 } })
    ).toBe(false);
    expect(
      (validTrial.errors ?? []).map((error) => error.instancePath).sort()
    ).toEqual(['/transcript/events', '/transcript/finalText']);
    // A field it doesn't know, at any depth, is still a trial.
    expect(
      validTrial({
        ...trial,
        future: 1,
        transcript: {
          events: [{ kind: 'tool_call', name: 'n', future: 2 }],
          future: 3,
        },
      })
    ).toBe(true);

    const results = await read(path.join(result.outputDir, 'results.json'));
    const validResults = await validatorFor('results');
    const [first] = results.cases as Array<Record<string, unknown>>;
    expect(
      validResults({ ...results, cases: [{ ...first, scores: { x: 1 } }] })
    ).toBe(false);
  });

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
