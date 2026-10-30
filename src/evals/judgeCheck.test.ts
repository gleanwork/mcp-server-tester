import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import {
  cohensKappa,
  readCalibration,
  wilson,
  type PairwiseCheck,
  type PointwiseCheck,
} from './judgeCheck.js';
import { parseCalibrationRecord } from './runFormat.js';
import { labelExport, labelImport } from '../cli/commands/label/index.js';
import { checkJudgeCommand } from '../cli/commands/judges/check.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('the statistics', () => {
  it('gives the Wilson interval and nothing without a sample', () => {
    const rate = wilson(8, 10);
    expect(rate.value).toBe(0.8);
    expect(rate.low).toBeCloseTo(0.4902, 4);
    expect(rate.high).toBeCloseTo(0.9433, 4);
    expect(wilson(20, 20).high).toBe(1);
    expect(wilson(0, 0)).toEqual({
      k: 0,
      n: 0,
      value: null,
      low: null,
      high: null,
    });
  });

  it("gives Cohen's kappa, and null when chance explains every answer", () => {
    expect(
      cohensKappa({
        truePositive: 20,
        falseNegative: 5,
        falsePositive: 10,
        trueNegative: 15,
      })
    ).toBeCloseTo(0.4, 10);
    expect(
      cohensKappa({
        truePositive: 0,
        falseNegative: 0,
        falsePositive: 0,
        trueNegative: 9,
      })
    ).toBeNull();
  });
});

/**
 * An eval of 40 cases: the answers to `good-*` cases name the certificate
 * and the keyword judge passes them; it skips (answers unknown) `odd-*`
 * cases.
 */
async function evalDirectory(
  options: { version?: string; odd?: number; keyword?: string } = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-check-'));
  dirs.push(dir);
  const plugin: Plugin = {
    meta: {
      name: 'check-test-plugin',
      namespace: 'ck',
      ...(options.version ? { version: options.version } : {}),
    },
    clients: {
      scripted: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        async run(input, _config, context) {
          const better = context.variant?.name === 'better';
          return {
            finalText: input.prompt.startsWith('good')
              ? `the certificate expired${better ? ' after 41 minutes' : ''}`
              : 'a deploy failed',
            events: [],
            usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          };
        },
      },
    },
    judges: {
      keyword: {
        schema: z.object({ keyword: z.string() }).strict(),
        async evaluate({ case: judged, trial }, judgeOptions) {
          if (judged.id?.startsWith('odd'))
            return { score: 0, skipped: true, reasoning: 'no answer' };
          return {
            score: trial.text?.includes(String(judgeOptions.keyword)) ? 1 : 0,
            reasoning: `looked for ${String(judgeOptions.keyword)}`,
          };
        },
      },
    },
    pairwiseJudges: {
      longer: {
        schema: z.object({}).strict(),
        async compare({ baseline, candidate }) {
          return {
            preference:
              (candidate.text?.length ?? 0) > (baseline.text?.length ?? 0)
                ? ('candidate' as const)
                : ('tie' as const),
          };
        },
      },
    },
  };
  const odd = options.odd ?? 0;
  const cases = [
    ...Array.from({ length: 20 }, (_, i) => `good-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `bad-${i}`),
    ...Array.from({ length: odd }, (_, i) => `odd-${i}`),
  ].map((id) => ({ id, input: id }));
  await fs.writeFile(
    path.join(dir, 'dataset.json'),
    JSON.stringify({ name: 'outages', cases })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'check-test',
      datasets: ['./dataset.json'],
      client: 'ck/client/scripted',
      redactStoredResponses: false,
      servers: { docs: { transport: 'stdio', command: 'docs-server' } },
      judges: [
        { type: 'ck/judge/keyword', keyword: options.keyword ?? 'certificate' },
      ],
      pairwiseJudges: ['ck/pairwise-judge/longer'],
      variants: [
        { name: 'baseline', servers: ['docs'] },
        { name: 'better', servers: ['docs'] },
      ],
    })
  );
  const base = {
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    report: false,
  };
  // Where the eval's runs and calibrations go.
  const results = path.join(dir, '.mcp-test-results', 'check-test');
  return { dir, base, results };
}

async function run(base: Parameters<typeof runEval>[0]): Promise<string> {
  return (await runEval(base)).outputDir;
}

/**
 * Labels every exported verdict of `judge` in `split`: a person agrees with
 * the judge except where `answer` returns a label of its own.
 */
async function label(
  directory: string,
  judge: string,
  answer: (row: Record<string, unknown>) => string | undefined,
  split: (row: Record<string, unknown>) => string = () => 'test'
) {
  const exported: string[] = [];
  await labelExport(
    directory,
    { format: 'jsonl', judge: [judge] },
    (text) => exported.push(text),
    () => {}
  );
  const rows = exported
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const labeled = rows.flatMap((row) => {
    const value = answer(row) ?? row.verdict;
    if (value === 'unknown' || value === undefined) return [];
    return [{ ...row, label: value, split: split(row) }];
  });
  const file = path.join(directory, '..', `${judge.replace(/\W/g, '-')}.jsonl`);
  await fs.writeFile(
    file,
    labeled.map((row) => JSON.stringify(row)).join('\n')
  );
  await labelImport(directory, file, { labeler: 'test' }, () => {});
  return labeled.length;
}

/** People fail the first `n` good cases on the baseline, which the judge passed. */
function missedFailures(n: number) {
  return (row: Record<string, unknown>) =>
    row.variant === 'baseline' &&
    typeof row.caseId === 'string' &&
    row.caseId.startsWith('good-') &&
    Number(row.caseId.slice(5)) < n
      ? 'fail'
      : undefined;
}

async function check(
  runs: string[],
  options: Partial<Parameters<typeof checkJudgeCommand>[1]> = {}
) {
  const out: string[] = [];
  const checks = await checkJudgeCommand(
    runs,
    { judge: 'ck/judge/keyword', ...options },
    (text) => out.push(text)
  );
  return { checks, text: out.join('') };
}

describe('mst judges check', () => {
  it('measures TPR and TNR against test labels and records the calibration', async () => {
    const { results: dir, base } = await evalDirectory();
    const directory = await run(base);
    // 80 trials: the judge fails the 40 bad ones and passes the 40 good
    // ones. People also fail 2 good ones.
    expect(await label(directory, 'ck/judge/keyword', missedFailures(2))).toBe(
      80
    );

    const { checks, text } = await check([directory]);
    const [result] = checks as PointwiseCheck[];
    expect(checks).toHaveLength(1);
    expect(result).toMatchObject({
      kind: 'pointwise',
      labels: 80,
      humanFail: 42,
      humanPass: 38,
      counts: {
        truePositive: 40,
        falseNegative: 2,
        trueNegative: 38,
        falsePositive: 0,
      },
      unversioned: true,
      usable: true,
      reasons: [],
    });
    expect(result!.tpr.value).toBeCloseTo(40 / 42, 10);
    expect(result!.tnr.value).toBe(1);
    expect(result!.disagreements.map((d) => d.caseId).sort()).toEqual([
      'good-0',
      'good-1',
    ]);
    expect(result!.disagreements[0]).toMatchObject({
      variant: 'baseline',
      verdict: 'pass',
      label: 'fail',
      reasoning: 'looked for certificate',
    });
    expect(text).toContain('usable   yes');
    expect(text).toContain('unversioned');

    const recorded = await readCalibration(
      dir,
      'ck/judge/keyword',
      result!.judgeIdentity!
    );
    expect(recorded).toMatchObject({
      kind: 'calibration',
      judgeKind: 'pointwise',
      judge: 'ck/judge/keyword',
      judgeIdentity: result!.judgeIdentity,
      unversioned: true,
      split: 'test',
      usable: true,
      labels: 80,
    });
    expect(text).toContain(
      path.join(
        dir,
        'calibrations',
        'ck%2Fjudge%2Fkeyword',
        `${result!.judgeIdentity}.json`
      )
    );
  });

  it('says why a judge is not usable, and the gate can be moved', async () => {
    const { base } = await evalDirectory();
    const directory = await run(base);
    await label(directory, 'ck/judge/keyword', missedFailures(8));
    const strict = (await check([directory])).checks[0] as PointwiseCheck;
    expect(strict.usable).toBe(false);
    expect(strict.tpr.low).toBeLessThan(0.8);
    expect(strict.reasons).toEqual([
      `TPR's lower bound ${strict.tpr.low!.toFixed(2)} is below 0.8`,
    ]);

    const loose = (await check([directory], { minRate: '0.6' }))
      .checks[0] as PointwiseCheck;
    expect(loose.usable).toBe(true);

    const few = (await check([directory], { minLabels: '50' }))
      .checks[0] as PointwiseCheck;
    expect(few.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^48 failing labels with a verdict; it needs 50/),
        expect.stringMatching(/^32 passing labels with a verdict; it needs 50/),
      ])
    );
  });

  it('counts unknown answers, which the gate caps', async () => {
    const { base } = await evalDirectory({ odd: 10 });
    const directory = await run(base);
    // The odd cases are unknown to the judge; people fail them.
    await label(directory, 'ck/judge/keyword', (row) =>
      String(row.caseId).startsWith('odd-') ? 'fail' : undefined
    );
    const [result] = (await check([directory])).checks as PointwiseCheck[];
    expect(result!.unknown).toMatchObject({ k: 20, n: 100 });
    expect(result!.humanFail).toBe(60);
    expect(result!.counts.truePositive).toBe(40);
    expect(result!.usable).toBe(false);
    expect(result!.reasons).toEqual([
      'it answered unknown on 20% of labeled trials; at most 10% is allowed',
    ]);
    expect(
      (
        (await check([directory], { maxUnknown: '0.25' }))
          .checks[0] as PointwiseCheck
      ).usable
    ).toBe(true);
  });

  it('uses only test labels by default, and records only them', async () => {
    const { results: dir, base } = await evalDirectory();
    const directory = await run(base);
    // The baseline's labels are dev; the better variant's are test.
    await label(directory, 'ck/judge/keyword', missedFailures(20), (row) =>
      row.variant === 'baseline' ? 'dev' : 'test'
    );
    const test = (await check([directory])).checks[0] as PointwiseCheck;
    expect(test.labels).toBe(40);
    expect(test.disagreements).toEqual([]);

    const dev = await check([directory], { split: 'dev' });
    expect((dev.checks[0] as PointwiseCheck).counts.falseNegative).toBe(20);
    expect(dev.text).toContain('not recorded: only the test split');

    await fs.rm(path.join(dir, 'calibrations'), { recursive: true });
    const all = await check([directory], { split: 'all', record: false });
    expect((all.checks[0] as PointwiseCheck).labels).toBe(80);
    await expect(fs.access(path.join(dir, 'calibrations'))).rejects.toThrow();
  });

  it('checks each judge identity on its own, newest first', async () => {
    const { dir, base, results } = await evalDirectory({ version: '1.0.0' });
    const first = await run(base);
    await label(first, 'ck/judge/keyword', missedFailures(2));
    // The judge's options change, so its identity does.
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      (await fs.readFile(path.join(dir, 'eval.json'), 'utf8')).replace(
        '"keyword":"certificate"',
        '"keyword":"expired"'
      )
    );
    const second = await run(base);
    await label(second, 'ck/judge/keyword', () => undefined);

    const { checks } = await check([first, second]);
    expect(checks).toHaveLength(2);
    expect(checks[0]!.judgeIdentity).not.toBe(checks[1]!.judgeIdentity);
    expect(checks[0]!.runs).toEqual([path.basename(second)]);
    expect(checks[1]!.runs).toEqual([path.basename(first)]);
    expect(checks.map((c) => c.unversioned)).toEqual([false, false]);
    for (const result of checks) {
      const recorded = await readCalibration(
        results,
        'ck/judge/keyword',
        result.judgeIdentity!
      );
      expect(recorded?.runs).toEqual(result.runs);
      expect(recorded?.unversioned).toBeUndefined();
    }
  });

  it('measures a pairwise judge by its agreement and ties', async () => {
    const { results: dir, base } = await evalDirectory();
    const directory = await run(base);
    // The judge prefers the better variant's longer good answers and calls
    // bad ones a tie. People prefer the baseline on 4 bad cases.
    await label(directory, 'ck/pairwise-judge/longer', (row) =>
      /^bad-[0-3]$/.test(String(row.caseId)) ? 'baseline' : undefined
    );
    const { checks, text } = await check([directory], {
      judge: 'ck/pairwise-judge/longer',
    });
    const [result] = checks as PairwiseCheck[];
    expect(result).toMatchObject({
      kind: 'pairwise',
      labels: 40,
      agreement: { k: 36, n: 40 },
      judgeTies: { k: 20, n: 40 },
      humanTies: { k: 16, n: 40 },
      unversioned: true,
    });
    expect(result!.disagreements).toHaveLength(4);
    expect(result!.disagreements[0]).toMatchObject({
      baseline: 'baseline',
      verdict: 'tie',
      label: 'baseline',
    });
    expect(text).toContain('agreement');
    const recorded = await readCalibration(
      dir,
      'ck/pairwise-judge/longer',
      result!.judgeIdentity!
    );
    expect(recorded).toMatchObject({ judgeKind: 'pairwise', labels: 40 });
  });

  it('says what to do when there is nothing to check', async () => {
    const { base } = await evalDirectory();
    const directory = await run(base);
    await expect(check([directory])).rejects.toThrow(
      /No labels for "ck\/judge\/keyword".*mst label export and mst label import/
    );
    await label(
      directory,
      'ck/judge/keyword',
      () => undefined,
      () => 'dev'
    );
    await expect(check([directory])).rejects.toThrow(
      /None of the 80 labels .* test split/
    );
    await expect(check([directory], { split: 'held-out' })).rejects.toThrow(
      "--split held-out isn't test, dev or all."
    );
    await expect(check([directory], { minRate: '2' })).rejects.toThrow(
      "--min-rate 2 isn't a number from 0 to 1."
    );
  });

  it('refuses a calibration file that is not one', () => {
    expect(() =>
      parseCalibrationRecord(
        { format: 'mst.run/v1', kind: 'calibration', judge: 'x' },
        'bad.json'
      )
    ).toThrow(/bad.json isn't a calibration/);
  });
});
