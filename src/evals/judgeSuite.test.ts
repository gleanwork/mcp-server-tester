import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { JudgeInput } from '../judge/judgeContract.js';
import type { PairwiseJudgeInput } from '../judge/pairwiseContract.js';
import type { EvalCaseResult } from '../types/reporter.js';
import { judgeSuite, savedCaseResults } from './judgeSuite.js';
import { judgeSavedRun, savedArtifactsDir } from './judgeSavedRun.js';

let dir: string;
const seen: JudgeInput[] = [];
const compared: PairwiseJudgeInput[] = [];

// Scores 1 when the answer matches the reference; reads its evidence file.
const plugin: Plugin = {
  meta: { name: 't', namespace: 't' },
  judges: {
    match: {
      schema: z.object({ bonus: z.number().default(0) }).strict(),
      evaluate: async (input, options) => {
        seen.push(input);
        const evidence = input.trial.artifactsDir
          ? await fs.readFile(
              path.join(input.trial.artifactsDir, 'note.txt'),
              'utf8'
            )
          : undefined;
        return {
          score: Math.min(
            1,
            (input.trial.text === input.case.expected.answer ? 1 : 0) +
              (options as { bonus: number }).bonus
          ),
          reasoning: evidence ?? 'no evidence',
          usage: { inputTokens: 5, outputTokens: 1, totalCostUsd: 0.5 },
        };
      },
    },
    needsDir: {
      schema: z.object({}).strict(),
      requires: ['trial.artifactsDir'],
      evaluate: async () => ({ score: 1 }),
    },
  },
  pairwiseJudges: {
    longer: {
      schema: z.object({}).strict(),
      compare: async (input) => {
        compared.push(input);
        const b = input.baseline.text.length;
        const c = input.candidate.text.length;
        return { preference: c > b ? 'candidate' : b > c ? 'baseline' : 'tie' };
      },
    },
  },
};

function result(
  id: string,
  text: string | undefined,
  extra: Partial<EvalCaseResult> = {}
): EvalCaseResult {
  return {
    id,
    datasetName: 'd',
    toolName: 'mcp_host',
    source: 'eval',
    pass: false,
    expectations: { textContains: { pass: true, details: 'kept' } },
    durationMs: 1,
    request: { scenario: `q-${id}` },
    ...(text !== undefined && {
      response: { response: text, events: [], artifactsName: `session-${id}` },
    }),
    ...extra,
  } as EvalCaseResult;
}

async function write(name: string, value: unknown): Promise<string> {
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-judge-'));
  seen.length = 0;
  compared.length = 0;
  await write('dataset.json', {
    name: 'd',
    cases: [
      { id: 'a', mode: 'mcp_host', scenario: 'q-a', canonicalAnswer: 'yes' },
      {
        id: 'b',
        mode: 'mcp_host',
        scenario: 'q-b',
        expected: { answer: 'no' },
      },
    ],
  });
  await write('manifest.json', {
    name: 'm',
    datasets: ['dataset.json'],
    host: { type: 'claude-cli' },
    judges: [{ type: 't/match', threshold: 0.5 }],
  });
  await fs.mkdir(path.join(dir, 'evidence', 'session-a'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'evidence', 'session-a', 'note.txt'),
    'seen a'
  );
});

afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('judgeSuite', () => {
  it("runs the manifest's judges on saved responses, with ground truth and evidence", async () => {
    const results = await write('run/results.json', {
      schemaVersion: 1,
      manifestId: 'mid',
      contentHash: 'h',
      runId: 'run-1',
      timestamp: 't0',
      arms: [],
      results: [result('a', 'yes'), result('b', 'yes')],
    });
    const out = await judgeSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      resultsPath: results,
      rootDir: dir,
      plugins: [plugin],
      artifactsRoot: path.join(dir, 'evidence'),
      outputDir: path.join(dir, 'out'),
    });
    // Ground truth comes from the dataset, not the results.
    expect(seen.map((input) => input.case.expected.answer)).toEqual([
      'yes',
      'no',
    ]);
    expect(seen[0]!.trial.artifactsDir).toBe(
      path.join(dir, 'evidence', 'session-a')
    );
    // b's evidence directory was not copied: no artifactsDir, no error.
    expect(seen[1]!.trial.artifactsDir).toBeUndefined();
    const [a, b] = out.summary.results;
    expect(a!.pass).toBe(true);
    expect(a!.expectations.judge?.reasoning).toBe('seen a');
    expect(a!.expectations.textContains?.details).toBe('kept');
    expect(b!.pass).toBe(false);
    expect(a!.judgeUsage?.totalCostUsd).toBe(0.5);
    expect(out.summary.telemetry?.totalJudgeUsage?.totalCostUsd).toBe(1);
    expect(out.summary.judgedRun).toEqual({ runId: 'run-1', timestamp: 't0' });
    expect(out.summary.manifestId).toBe('mid');
    const written = JSON.parse(
      await fs.readFile(path.join(out.outputDir, 'results.json'), 'utf8')
    );
    // Stored results are redacted as `mst run` stores them, local paths never kept.
    expect(written.results[0].response).toBeUndefined();
    expect(JSON.stringify(written)).not.toContain(path.join(dir, 'evidence'));
  });

  it('runs judges from a --judges file instead, parsed by their schemas', async () => {
    const judges = await write('judges.json', {
      judges: [{ type: 't/match', bonus: 1, threshold: 0.9 }],
    });
    const results = await write('arm.json', {
      kind: 'eval-runner-result',
      metadata: { labels: { arm: 'x' } },
      data: { caseResults: [result('b', 'yes')] },
    });
    const out = await judgeSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      resultsPath: results,
      judgesPath: judges,
      rootDir: dir,
      plugins: [plugin],
      outputDir: path.join(dir, 'out'),
    });
    expect(out.summary.results[0]!.expectations.judge?.score).toBe(1);
    expect(out.summary.results[0]!.arm).toBe('x');
    expect(out.summary.arms.map((arm) => arm.name)).toEqual(['x']);
  });

  it('rejects a judges file with an unknown option', async () => {
    const judges = await write('judges.json', {
      judges: [{ type: 't/match', nope: 1 }],
    });
    const results = await write('arm.json', {
      caseResults: [result('a', 'yes')],
    });
    await expect(
      judgeSuite({
        manifestPath: path.join(dir, 'manifest.json'),
        resultsPath: results,
        judgesPath: judges,
        rootDir: dir,
        plugins: [plugin],
        outputDir: path.join(dir, 'out'),
      })
    ).rejects.toThrow(/nope|Unrecognized/);
  });

  it('compares with a baseline run using pairwiseJudges', async () => {
    const judges = await write('judges.json', {
      judges: ['t/match'],
      pairwiseJudges: ['t/longer'],
    });
    const candidate = await write('c.json', {
      caseResults: [result('a', 'yes, longer'), result('b', 'no')],
    });
    const baseline = await write('b.json', {
      caseResults: [result('a', 'yes'), result('b', 'no')],
    });
    const out = await judgeSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      resultsPath: candidate,
      baselinePath: baseline,
      judgesPath: judges,
      artifactsRoot: path.join(dir, 'evidence'),
      baselineArtifactsRoot: path.join(dir, 'evidence'),
      rootDir: dir,
      plugins: [plugin],
      outputDir: path.join(dir, 'out'),
    });
    expect(out.pairwise?.summary[0]).toMatchObject({
      judge: 't/longer',
      compared: 2,
      candidateWins: 1,
      ties: 1,
    });
    expect(compared[0]?.case.expected.answer).toBe('yes');
    expect(compared[0]?.candidate.artifactsDir).toBe(
      path.join(dir, 'evidence', 'session-a')
    );
    await expect(
      fs.stat(path.join(out.outputDir, 'pairwise.json'))
    ).resolves.toBeTruthy();
  });

  it('requires pairwise judges for a baseline', async () => {
    const results = await write('c.json', {
      caseResults: [result('a', 'yes')],
    });
    await expect(
      judgeSuite({
        manifestPath: path.join(dir, 'manifest.json'),
        resultsPath: results,
        baselinePath: results,
        rootDir: dir,
        plugins: [plugin],
      })
    ).rejects.toThrow(/pairwiseJudges/);
  });
});

describe('judgeSavedRun', () => {
  it('fails a redacted result clearly and leaves errored cases as they ran', async () => {
    const errored = result('b', 'yes', { error: 'host crashed', pass: false });
    const [redacted, kept] = await judgeSavedRun({
      caseResults: [result('a', undefined), errored],
      judges: [{ type: 't/match', judge: 't/match' }],
    });
    expect(redacted!.pass).toBe(false);
    expect(redacted!.expectations.judge?.details).toMatch(
      /redactStoredResponses/
    );
    expect(kept).toBe(errored);
  });

  it('skips a judge that requires evidence the run did not keep', async () => {
    const { installPlugins } = await import('../plugins/extensions.js');
    installPlugins([plugin]);
    const [judged] = await judgeSavedRun({
      caseResults: [result('b', 'x')],
      judges: [{ type: 't/needsDir', judge: 't/needsDir' }],
      artifactsRoot: path.join(dir, 'evidence'),
    });
    expect(judged!.expectations.judge?.skipped).toBe(true);
  });
});

describe('savedArtifactsDir', () => {
  it('resolves one path segment under the root only', async () => {
    const root = path.join(dir, 'evidence');
    expect(savedArtifactsDir({ artifactsName: 'session-a' }, root)).toBe(
      path.join(root, 'session-a')
    );
    for (const name of ['..', '.', '../evidence', 'a/b', 'a\\b', '', 5])
      expect(savedArtifactsDir({ artifactsName: name }, root)).toBeUndefined();
    expect(
      savedArtifactsDir({ artifactsName: 'missing' }, root)
    ).toBeUndefined();
    expect(
      savedArtifactsDir({ artifactsName: 'session-a' }, undefined)
    ).toBeUndefined();
  });
});

describe('savedCaseResults', () => {
  it('rejects a file that is not a saved run', () => {
    expect(() => savedCaseResults({ nope: 1 }, 'x.json')).toThrow(
      /not a saved run/
    );
  });
});
