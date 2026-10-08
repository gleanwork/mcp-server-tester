import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { gradeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { ClientRunResult } from './evalFrameworkTypes.js';
import { findRunDirectory, nextRegradeId } from './runFormat.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/**
 * An eval of two variants and two cases on a client that answers from a
 * script, a keyword judge and a pairwise judge that prefers the longer answer.
 */
async function setup(
  options: {
    trials?: number;
    redact?: boolean;
    keyword?: string;
    /** Throw instead of answering this case. */
    failCase?: string;
  } = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-grade-'));
  dirs.push(dir);
  const client = vi.fn(
    async (
      prompt: string,
      variant: string | undefined
    ): Promise<ClientRunResult> => {
      if (options.failCase && prompt.includes(options.failCase))
        throw new Error('The client crashed.');
      return {
        finalText:
          variant === 'better'
            ? `${prompt}: the certificate expired after 41 minutes`
            : `${prompt}: the certificate expired`,
        events: [
          {
            kind: 'tool_call',
            source: 'mcp',
            server: 'docs',
            name: 'search',
            arguments: { query: prompt },
            output: 'the incident report',
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
      };
    }
  );
  const judge = vi.fn(
    async (
      { trial }: { trial: { text?: string } },
      judgeOptions: Record<string, unknown>
    ) => ({
      score: trial.text?.includes(String(judgeOptions.keyword)) ? 1 : 0,
      reasoning: `looked for ${String(judgeOptions.keyword)}`,
    })
  );
  const pairwise = vi.fn(
    async ({
      baseline,
      candidate,
    }: {
      baseline: { text?: string };
      candidate: { text?: string };
    }) => ({
      preference:
        (candidate.text?.length ?? 0) > (baseline.text?.length ?? 0)
          ? ('candidate' as const)
          : ('tie' as const),
    })
  );
  const plugin: Plugin = {
    meta: { name: 'grade-test-plugin', namespace: 'gr' },
    clients: {
      scripted: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        async run(input, _config, context) {
          return client(input.prompt, context.variant?.name);
        },
      },
    },
    judges: {
      keyword: {
        schema: z.object({ keyword: z.string() }).strict(),
        evaluate: judge,
      },
    },
    pairwiseJudges: {
      longer: { schema: z.object({}).strict(), compare: pairwise },
    },
  };
  await fs.writeFile(
    path.join(dir, 'dataset.json'),
    JSON.stringify({
      name: 'outages',
      cases: [
        { id: 'cause', input: 'Why did checkout fail' },
        { id: 'duration', input: 'How long was checkout down' },
      ],
    })
  );
  const writeConfig = async (keyword: string) =>
    fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'grade-test',
        datasets: ['./dataset.json'],
        client: 'gr/client/scripted',
        ...(options.trials ? { trials: options.trials } : {}),
        redactStoredResponses: options.redact ?? false,
        servers: {
          docs: { transport: 'stdio', command: 'docs-server' },
        },
        judges: [{ type: 'gr/judge/keyword', keyword, threshold: 1 }],
        pairwiseJudges: ['gr/pairwise-judge/longer'],
        variants: [
          { name: 'baseline', servers: ['docs'] },
          { name: 'better', servers: ['docs'] },
        ],
      })
    );
  await writeConfig(options.keyword ?? 'certificate');
  const base = {
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    report: false,
  };
  return { dir, base, client, judge, pairwise, writeConfig };
}

/** Each case's pass and scores, without timings: what grading decided. */
function verdicts(result: Awaited<ReturnType<typeof runEval>>) {
  return result.summary.results
    .map((caseResult) => ({
      variant: caseResult.variant,
      id: caseResult.id,
      pass: caseResult.pass,
      error: caseResult.error,
      trials: (caseResult.trialResults ?? [caseResult]).map((trial) =>
        Object.fromEntries(
          Object.entries(trial.scores ?? {}).map(([grader, score]) => [
            grader,
            { pass: score?.pass, score: score?.score },
          ])
        )
      ),
    }))
    .sort((a, b) =>
      `${a.variant}/${a.id}`.localeCompare(`${b.variant}/${b.id}`)
    );
}

const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

describe('mst run --no-grade and mst grade', () => {
  it('grades stored traces as a normal run would, without running the client', async () => {
    const t = await setup({ trials: 2, keyword: '41 minutes' });
    const graded = await runEval(t.base);
    const collected = await runEval({ ...t.base, grade: false });
    expect(t.client).toHaveBeenCalledTimes(16);
    // Collecting doesn't grade.
    expect(t.judge).toHaveBeenCalledTimes(8);
    // Each case in both orders.
    expect(t.pairwise).toHaveBeenCalledTimes(4);
    expect(collected.summary.graded).toBe(false);
    const collectedRun = await readJson(
      path.join(collected.outputDir, 'run.json')
    );
    expect(collectedRun.phases).toEqual({
      collect: 'complete',
      grade: 'skipped',
    });
    await expect(
      fs.stat(path.join(collected.outputDir, 'scores'))
    ).rejects.toThrow();

    const regrade = await gradeRun({
      ...t.base,
      run: path.basename(collected.outputDir).split('-').pop()!,
    });
    expect(t.client).toHaveBeenCalledTimes(16);
    expect(t.judge).toHaveBeenCalledTimes(16);
    expect(t.pairwise).toHaveBeenCalledTimes(8);
    expect(verdicts(regrade)).toEqual(verdicts(graded));
    expect(regrade.summary.variants[1]?.pairwise).toEqual(
      graded.summary.variants[1]?.pairwise
    );
    const collectedId = path.basename(collected.outputDir);
    expect(path.basename(regrade.outputDir)).toBe(`${collectedId}.g2`);
    expect(regrade.gradedFrom).toBe(collectedId);
    const regradeRun = await readJson(path.join(regrade.outputDir, 'run.json'));
    expect(regradeRun).toMatchObject({
      runId: `${collectedId}.g2`,
      gradedFrom: collectedId,
      phases: { collect: 'complete', grade: 'complete' },
    });
    // The newest graded run is the latest; an ungraded run never is.
    const latest = await readJson(
      path.join(t.dir, '.mcp-test-results', 'grade-test', 'latest.json')
    );
    expect(latest.runId).toBe(`${collectedId}.g2`);
    // The regrade compares with the previous graded run, not the ungraded one.
    expect(regrade.summary.previousRun?.runId).toBe(
      path.basename(graded.outputDir)
    );
  });

  it("regrades with the config's current judges, as .g2 then .g3", async () => {
    const t = await setup();
    const first = await runEval(t.base);
    expect(first.summary.metrics.passed).toBe(4);
    await t.writeConfig('41 minutes');
    const g2 = await gradeRun({ ...t.base, run: first.outputDir });
    expect(t.client).toHaveBeenCalledTimes(4);
    expect(
      g2.summary.results
        .filter((result) => result.pass)
        .map((result) => result.variant)
    ).toEqual(['better', 'better']);
    // A regrade of a regrade still names the run that collected the traces.
    const g3 = await gradeRun({ ...t.base, run: g2.outputDir });
    expect(path.basename(g3.outputDir)).toBe(
      `${path.basename(first.outputDir)}.g3`
    );
    expect(g3.gradedFrom).toBe(path.basename(first.outputDir));
  });

  it('keeps a trial that failed when it ran failed, without judging it', async () => {
    const t = await setup({ failCase: 'How long' });
    const collected = await runEval({ ...t.base, grade: false });
    const regrade = await gradeRun({ ...t.base, run: collected.outputDir });
    const failed = regrade.summary.results.filter(
      (result) => result.id === 'duration'
    );
    expect(failed.map((result) => result.error)).toEqual([
      'The client crashed.',
      'The client crashed.',
    ]);
    expect(failed.every((result) => !result.pass)).toBe(true);
    // Only the two answered trials were judged.
    expect(t.judge).toHaveBeenCalledTimes(2);
  });

  it('refuses to collect or grade traces stored without their answers', async () => {
    const t = await setup({ redact: true });
    await expect(runEval({ ...t.base, grade: false })).rejects.toThrow(
      /--no-grade keeps the traces.*"redactStoredResponses": false/
    );
    expect(t.client).not.toHaveBeenCalled();
    const graded = await runEval(t.base);
    await expect(
      gradeRun({ ...t.base, run: graded.outputDir })
    ).rejects.toThrow(/stored redacted traces/);
  });

  it("fails for a run of another eval, or a variant or case the config doesn't have", async () => {
    const t = await setup();
    const collected = await runEval({ ...t.base, grade: false });
    const config = await readJson(t.base.configPath);
    await fs.writeFile(
      t.base.configPath,
      JSON.stringify({
        ...config,
        variants: [{ name: 'baseline', servers: ['docs'] }],
      })
    );
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow(/ran variant "better", which the eval config doesn't/);
    await fs.writeFile(
      t.base.configPath,
      JSON.stringify({ ...config, name: 'other' })
    );
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow(/is a run of eval "grade-test", not of "other"/);
    await fs.writeFile(t.base.configPath, JSON.stringify(config));
    await fs.writeFile(
      path.join(t.dir, 'dataset.json'),
      JSON.stringify({
        name: 'outages',
        cases: [{ id: 'cause', input: 'Why did checkout fail' }],
      })
    );
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow(/ran case "duration", which the eval's datasets/);
  });
});

describe('finding the run to grade', () => {
  it('takes a run directory, a full run ID or its short form', async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-runs-'));
    dirs.push(runs);
    const ids = [
      '20261007T182504Z-7f3c2a',
      '20261007T182504Z-7f3c2a.g2',
      '20261008T090000Z-abc123',
      '20261009T090000Z-abc123',
    ];
    for (const id of ids) {
      await fs.mkdir(path.join(runs, id));
      await fs.writeFile(path.join(runs, id, 'run.json'), '{}');
    }
    await expect(findRunDirectory(runs, '7f3c2a')).resolves.toBe(
      path.join(runs, ids[0]!)
    );
    await expect(findRunDirectory(runs, '7f3c2a.g2')).resolves.toBe(
      path.join(runs, ids[1]!)
    );
    await expect(findRunDirectory(runs, ids[2]!)).resolves.toBe(
      path.join(runs, ids[2]!)
    );
    await expect(
      findRunDirectory(runs, path.join(runs, ids[3]!))
    ).resolves.toBe(path.join(runs, ids[3]!));
    await expect(findRunDirectory(runs, 'abc123')).rejects.toThrow(
      /matches 2 runs/
    );
    await expect(findRunDirectory(runs, 'ffffff')).rejects.toThrow(
      /No run "ffffff"/
    );
    await expect(nextRegradeId(runs, ids[0]!)).resolves.toBe(
      '20261007T182504Z-7f3c2a.g3'
    );
    await expect(nextRegradeId(runs, ids[1]!)).resolves.toBe(
      '20261007T182504Z-7f3c2a.g3'
    );
    await expect(nextRegradeId(runs, ids[2]!)).resolves.toBe(
      '20261008T090000Z-abc123.g2'
    );
  });
});
