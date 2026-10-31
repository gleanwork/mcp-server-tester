import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { gradeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import {
  cohensKappa,
  correctedPassRate,
  readCalibration,
  readCalibrations,
  wilson,
  type PairwiseCheck,
  type PointwiseCheck,
} from './judgeCheck.js';
import { parseCalibrationRecord, readRunDirectory } from './runFormat.js';
import { buildRunReport, writeRunReport } from './runReport.js';
import type {
  MCPRunReportData,
  RunReportJudgeCalibration,
} from '../types/reporter.js';
import { labelExport, labelImport } from '../cli/commands/label/index.js';
import { checkJudgeCommand } from '../cli/commands/judges/check.js';
import { open } from '../cli/commands/open/index.js';

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

  it("corrects a pass rate for the judge's errors, with both samples in its interval", () => {
    const calibration = { tpr: wilson(45, 50), tnr: wilson(40, 50) };
    // The judge passed 60 of 100: it fails 90% of failures and passes 80% of
    // passes, so 40% judged failing is 28.6% failing.
    // The interval is Lang and Reiczigel's; these values are asht::prevSeSp's
    // (fail as the positive class).
    const corrected = correctedPassRate(60, 100, calibration)!;
    expect(corrected.value).toBeCloseTo(0.714286, 5);
    expect(corrected.low).toBeCloseTo(0.540994, 5);
    expect(corrected.high).toBeCloseTo(0.914618, 5);
    // A judge that agreed with every label, on a run that passed every
    // trial, still has an interval: neither sample is certain.
    const perfect = { tpr: wilson(44, 44), tnr: wilson(48, 48) };
    expect(correctedPassRate(100, 100, perfect)).toEqual({
      value: 1,
      low: expect.closeTo(0.955842, 5),
      high: 1,
    });
    expect(correctedPassRate(7, 50, perfect)).toEqual({
      value: expect.closeTo(0.14, 10),
      low: expect.closeTo(0.037313, 5),
      high: expect.closeTo(0.257987, 5),
    });
    // A perfect judge changes nothing.
    expect(
      correctedPassRate(60, 100, { tpr: wilson(30, 30), tnr: wilson(30, 30) })!
        .value
    ).toBeCloseTo(0.6, 10);
    // Cut to [0, 1].
    expect(correctedPassRate(100, 100, calibration)!.value).toBe(1);
    // No better than chance: nothing to correct with.
    expect(
      correctedPassRate(60, 100, { tpr: wilson(25, 50), tnr: wilson(25, 50) })
    ).toBeUndefined();
    expect(correctedPassRate(0, 0, calibration)).toBeUndefined();
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
 * and the keyword judge passes them; it can't tell on `odd-*` cases: it
 * answers unknown on half of them, and skips the rest, which a check also
 * counts as unknown.
 */
async function evalDirectory(
  options: {
    version?: string;
    odd?: number;
    keyword?: string;
    threshold?: number;
  } = {}
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
            return Number(judged.id.slice(4)) % 2
              ? { score: 0, unknown: true, reasoning: 'cannot tell' }
              : { score: 0, skipped: true, reasoning: 'no answer' };
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
        {
          type: 'ck/judge/keyword',
          keyword: options.keyword ?? 'certificate',
          ...(options.threshold !== undefined
            ? { threshold: options.threshold }
            : {}),
        },
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

/** The first score from `judge` anywhere under `value`. */
function firstScore(
  value: unknown,
  judge: string
): { judgeIdentity?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.judgeName === judge && typeof record.judgeIdentity === 'string')
    return record as { judgeIdentity?: string };
  for (const child of Object.values(record)) {
    const found = firstScore(child, judge);
    if (found) return found;
  }
  return undefined;
}

/** The report data `writeRunReport` wrote for a run. */
async function reportOf(directory: string): Promise<MCPRunReportData> {
  const file = path.join(directory, 'report', 'data.js');
  if (!(await fs.stat(file).catch(() => undefined)))
    await writeRunReport(directory);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(
    text.replace(/^window\.MST_RUN_REPORT = /, '').replace(/;\s*$/, '')
  ) as MCPRunReportData;
}

function calibrationOf(
  report: MCPRunReportData,
  variant: string
): RunReportJudgeCalibration | undefined {
  return report.variants
    .find((v) => v.name === variant)
    ?.judgeCalibration?.find((judge) => judge.judge === 'ck/judge/keyword');
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
  it('prints JSON with --json from the command line', async () => {
    // `judges` has a --json of its own: check must still get it.
    const { base } = await evalDirectory();
    const directory = await run(base);
    await label(directory, 'ck/judge/keyword', () => undefined);
    const bin = fileURLToPath(
      new URL('../../dist/cli/index.js', import.meta.url)
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      bin,
      'judges',
      'check',
      directory,
      '--judge',
      'ck/judge/keyword',
      '--json',
      '--no-record',
    ]);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        judge: 'ck/judge/keyword',
        kind: 'pointwise',
        labels: 80,
        recorded: [],
      }),
    ]);
  });

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
    // Newest by when the run was made, not by where it is in the arguments.
    const reversed = await check([second, first]);
    expect(reversed.checks.map((c) => c.runs)).toEqual(
      checks.map((c) => c.runs)
    );
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

  it('counts each label once: a run given twice, or graded again with the same judge', async () => {
    const { base } = await evalDirectory({ version: '1.0.0' });
    const directory = await run(base);
    await label(directory, 'ck/judge/keyword', missedFailures(2));
    const once = (await check([directory])).checks[0] as PointwiseCheck;
    expect(once.labels).toBe(80);

    const regraded = (
      await gradeRun({ ...base, run: path.basename(directory) })
    ).outputDir;
    await label(regraded, 'ck/judge/keyword', missedFailures(2));
    const { checks } = await check([directory, directory, regraded]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      labels: 80,
      counts: once.counts,
      // The regrade's verdicts replace the run's: they grade the same trials.
      runs: [path.basename(regraded)],
    });
  });

  it('gives the identity run.json records, which changes with the pass threshold', async () => {
    const identities = async (threshold?: number) => {
      const { base } = await evalDirectory({
        version: '1.0.0',
        ...(threshold !== undefined ? { threshold } : {}),
      });
      const directory = await run(base);
      const stored = await readRunDirectory(directory);
      const recorded = new Map(
        (stored.run.judges ?? []).map((r) => [r.type, r.identity])
      );
      const score = firstScore(stored.summary, 'ck/judge/keyword');
      const preference = stored.summary.variants.find((v) => v.pairwise)
        ?.pairwise?.cases[0]?.preferences[0];
      // Scores and preferences record the identity run.json does.
      expect(score?.judgeIdentity).toBe(recorded.get('ck/judge/keyword'));
      expect(preference?.judgeIdentity).toBe(
        recorded.get('ck/pairwise-judge/longer')
      );
      return {
        pointwise: score?.judgeIdentity,
        pairwise: preference?.judgeIdentity,
      };
    };
    const standard = await identities();
    resetPluginsForTests();
    const strict = await identities(0.9);
    expect(strict.pointwise).not.toBe(standard.pointwise);
    expect(strict.pairwise).toBe(standard.pairwise);
  });

  it('attributes a kept pairwise preference to the judge that gave it, or to none', async () => {
    const { base } = await evalDirectory();
    const directory = await run(base);
    await label(directory, 'ck/pairwise-judge/longer', () => undefined);
    const recorded = (await readRunDirectory(directory)).run.judges?.find(
      (judge) => judge.type === 'ck/pairwise-judge/longer'
    )?.identity;
    expect(recorded).toBeDefined();
    const current = await check([directory], {
      judge: 'ck/pairwise-judge/longer',
      record: false,
    });
    expect(current.checks[0]!.judgeIdentity).toBe(recorded);

    // A run graded before preferences recorded their judge's identity.
    const scores = path.join(
      directory,
      'scores',
      'ck%2Fpairwise-judge%2Flonger'
    );
    const files = (await fs.readdir(scores, { recursive: true }))
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(scores, file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as {
        preference: Record<string, unknown>;
      };
      expect(record.preference.judgeIdentity).toBeDefined();
      delete record.preference.judgeIdentity;
      await fs.writeFile(file, JSON.stringify(record));
    }
    const summaryFile = path.join(directory, 'summary.json');
    const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8')) as {
      variants: Array<{
        pairwise?: {
          cases: Array<{ preferences: Array<Record<string, unknown>> }>;
        };
      }>;
    };
    for (const variant of summary.variants)
      for (const comparison of variant.pairwise?.cases ?? [])
        for (const preference of comparison.preferences)
          delete preference.judgeIdentity;
    await fs.writeFile(summaryFile, JSON.stringify(summary));

    const { checks, text } = await check([directory], {
      judge: 'ck/pairwise-judge/longer',
    });
    // Not the identity of the judge the run's header names now.
    expect(checks[0]!.judgeIdentity).toBeUndefined();
    expect(text).toContain('not recorded');
  });

  it('resumes grading a run recorded before judges said whether they were versioned', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await evalDirectory();
    const collected = await run(base);
    const directory = (
      await gradeRun({ ...base, run: path.basename(collected) })
    ).outputDir;
    const runFile = path.join(directory, 'run.json');
    const header = JSON.parse(await fs.readFile(runFile, 'utf8')) as {
      judges: Array<Record<string, unknown>>;
    };
    expect(header.judges.some((judge) => judge.unversioned)).toBe(true);
    for (const judge of header.judges) delete judge.unversioned;
    await fs.writeFile(runFile, JSON.stringify(header));
    await expect(
      gradeRun({ ...base, run: path.basename(directory), resume: true })
    ).resolves.toBeDefined();
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

  it("shows each judge's calibration and corrected pass rate in the run's report", async () => {
    const { dir, base, results } = await evalDirectory({ version: '1.0.0' });
    const first = await run(base);
    const before = await reportOf(first);
    expect(calibrationOf(before, 'baseline')).toEqual({
      judge: 'ck/judge/keyword',
      status: 'uncalibrated',
      judged: 40,
      passed: 20,
      unknown: 0,
      passRate: 0.5,
    });

    // People fail 2 of the baseline's 20 good trials, which the judge passed.
    await label(first, 'ck/judge/keyword', missedFailures(2));
    const [checked] = (await check([first])).checks as PointwiseCheck[];
    const after = await reportOf(first);
    const baseline = calibrationOf(after, 'baseline')!;
    expect(baseline).toMatchObject({
      status: 'calibrated',
      passRate: 0.5,
      calibration: {
        judgeIdentity: checked!.judgeIdentity,
        labels: 80,
        usable: true,
        reasons: [],
      },
    });
    expect(baseline.unversioned).toBeUndefined();
    expect(baseline.corrected).toEqual(correctedPassRate(20, 40, checked!));
    // The judge misses failures, so fewer trials truly pass than it says.
    expect(baseline.corrected!.value).toBeLessThan(0.5);

    // A failed gate shows the reason and no correction.
    await check([first], { minLabels: '50' });
    const strict = calibrationOf(await reportOf(first), 'baseline')!;
    expect(strict.status).toBe('not-usable');
    expect(strict.corrected).toBeUndefined();
    expect(strict.calibration?.reasons[0]).toMatch(/needs 50/);

    // A changed judge's run finds only the old identity's calibration.
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      (await fs.readFile(path.join(dir, 'eval.json'), 'utf8')).replace(
        '"keyword":"certificate"',
        '"keyword":"expired"'
      )
    );
    const second = await run(base);
    const stale = calibrationOf(await reportOf(second), 'baseline')!;
    expect(stale.status).toBe('stale');
    expect(stale.corrected).toBeUndefined();
    expect(stale.calibration?.judgeIdentity).toBe(checked!.judgeIdentity);

    // The second run's report predates a new check: mst open rebuilds it,
    // and leaves it alone when nothing changed since.
    const data = path.join(second, 'report', 'data.js');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(data, old, old);
    await check([first], { minLabels: '10' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await open(second, { print: true });
    const rebuilt = (await fs.stat(data)).mtimeMs;
    expect(rebuilt).toBeGreaterThan(old.getTime());
    await open(second, { print: true });
    expect((await fs.stat(data)).mtimeMs).toBe(rebuilt);
    log.mockRestore();

    // A bad calibration file is skipped, not fatal.
    await fs.writeFile(
      path.join(
        results,
        'calibrations',
        'ck%2Fjudge%2Fkeyword',
        `${'0'.repeat(64)}.json`
      ),
      '{"format":"mst.run/v1","kind":"calibration"}'
    );
    const warnings: string[] = [];
    expect(
      await readCalibrations(results, (message) => warnings.push(message))
    ).toHaveLength(1);
    expect(warnings[0]).toMatch(/isn't a calibration/);
  });

  it('marks an unversioned judge, and a variant graded by two identities', async () => {
    const { base, results } = await evalDirectory();
    const directory = await run(base);
    await label(directory, 'ck/judge/keyword', () => undefined);
    await check([directory]);
    const stored = await readRunDirectory(directory);
    const report = buildRunReport(stored, await readCalibrations(results));
    expect(calibrationOf(report, 'better')).toMatchObject({
      status: 'calibrated',
      unversioned: true,
      corrected: { value: 0.5 },
    });

    // Two identities' verdicts in one variant: no calibration applies.
    const mixed = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const better = mixed.summary.variants.find((v) => v.name === 'better');
    const score = firstScore(better, 'ck/judge/keyword');
    expect(score).toBeDefined();
    score!.judgeIdentity = 'f'.repeat(64);
    const mixedReport = buildRunReport(mixed, await readCalibrations(results));
    expect(calibrationOf(mixedReport, 'better')).toMatchObject({
      status: 'mixed',
      judged: 40,
    });
    expect(calibrationOf(mixedReport, 'better')?.corrected).toBeUndefined();
    expect(calibrationOf(mixedReport, 'baseline')?.status).toBe('calibrated');
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
