import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { gradeRun, runEval } from './runEval.js';
import { printRunResult } from '../cli/commands/run/index.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { ClientRunResult } from './evalFrameworkTypes.js';
import { findRunDirectory, nextRegradeId } from './runFormat.js';
import { withoutTrialArtifacts } from './trialArtifacts.js';

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
    /** The keyword judge's preflight: throw this to say it can't run. */
    preflightError?: string;
    /** Report a session folder per trial, as Cowork does. */
    artifacts?: boolean;
    /** Report this directory instead of the session folder. */
    artifactsDir?: string;
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
      const session = options.artifacts
        ? await fs.mkdtemp(path.join(dir, 'session-'))
        : undefined;
      if (session) {
        await fs.mkdir(path.join(session, 'outputs'));
        await fs.writeFile(
          path.join(session, 'outputs', 'answer.md'),
          `${variant} wrote: ${prompt}`
        );
        await fs.writeFile(path.join(session, 'audit.jsonl'), '{}\n');
        // Not evidence, and not named by the client: never copied.
        await fs.writeFile(path.join(session, '.audit-key'), 'secret');
        await fs.mkdir(path.join(session, '.claude', 'session-env'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(session, '.claude', 'session-env', 'env'),
          'TOKEN=secret'
        );
        await fs.writeFile(path.join(session, 'credentials.json'), 'secret');
        // A link, even where the client points, is never followed.
        await fs.symlink(os.homedir(), path.join(session, 'outputs', 'home'));
      }
      return {
        ...(session
          ? {
              artifacts: {
                dir: options.artifactsDir ?? session,
                include: ['audit.jsonl', 'outputs'],
              },
            }
          : {}),
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
  const preflight = vi.fn((_options: Record<string, unknown>) => {});
  /** What judges found in each trial's artifacts. */
  const seen: Array<{ dir: string; files: string[]; answer?: string }> = [];
  const look = async (dir: string | undefined) => {
    if (!dir) return;
    const files = (await fs.readdir(dir, { recursive: true })).sort();
    const answer = await fs
      .readFile(path.join(dir, 'outputs', 'answer.md'), 'utf8')
      .catch(() => undefined);
    seen.push({ dir, files, ...(answer ? { answer } : {}) });
  };
  const judge = vi.fn(
    async (
      { trial }: { trial: { text?: string; artifactsDir?: string } },
      judgeOptions: Record<string, unknown>
    ) => ({
      score:
        (await look(trial.artifactsDir),
        trial.text?.includes(String(judgeOptions.keyword)) ? 1 : 0),
      reasoning: `looked for ${String(judgeOptions.keyword)}`,
    })
  );
  const pairwise = vi.fn(
    async ({
      baseline,
      candidate,
    }: {
      baseline: { text?: string; artifactsDir?: string };
      candidate: { text?: string; artifactsDir?: string };
    }) => ({
      ...(await Promise.all([
        look(baseline.artifactsDir),
        look(candidate.artifactsDir),
      ]).then(() => ({}))),
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
        preflight: async (judgeOptions: Record<string, unknown>) => {
          preflight(judgeOptions);
          if (options.preflightError) throw new Error(options.preflightError);
        },
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
  return { dir, base, client, judge, pairwise, preflight, writeConfig, seen };
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
    // No pass rate: nothing judged the answers.
    const collectedSummary = await readJson(
      path.join(collected.outputDir, 'summary.json')
    );
    expect(collectedSummary.metrics).toEqual({
      total: 4,
      collected: 4,
      failedToCollect: 0,
    });
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

  it("a regrade of an older run doesn't take over latest.json, and compares with its own grading", async () => {
    const t = await setup();
    const a = await runEval(t.base);
    const b = await runEval(t.base);
    const latestFile = path.join(
      t.dir,
      '.mcp-test-results',
      'grade-test',
      'latest.json'
    );
    const aId = path.basename(a.outputDir);
    const bId = path.basename(b.outputDir);
    const regradeA = await gradeRun({ ...t.base, run: a.outputDir });
    expect((await readJson(latestFile)).runId).toBe(bId);
    expect(regradeA.summary.previousRun?.runId).toBe(aId);
    // A's next regrade compares with its last one.
    const again = await gradeRun({ ...t.base, run: aId });
    expect(again.summary.previousRun?.runId).toBe(`${aId}.g2`);
    // A regrade of the newest run does become the latest.
    const regradeB = await gradeRun({ ...t.base, run: bId });
    expect((await readJson(latestFile)).runId).toBe(
      path.basename(regradeB.outputDir)
    );
    expect(regradeB.summary.previousRun?.runId).toBe(bId);
    // And its next regrade, which compares with it.
    const regradeB2 = await gradeRun({ ...t.base, run: bId });
    expect((await readJson(latestFile)).runId).toBe(
      path.basename(regradeB2.outputDir)
    );
    expect(regradeB2.summary.previousRun?.runId).toBe(
      path.basename(regradeB.outputDir)
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

  it('mst run --no-grade names the trials that failed to collect and fails', async () => {
    const t = await setup({ failCase: 'How long' });
    const collected = await runEval({ ...t.base, grade: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      printRunResult(collected, 'eval.json');
      const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain(
        '2 failed to collect (baseline/duration, better/duration); grading fails them.'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      log.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it('checks once, before any client starts, that every judge can run', async () => {
    const t = await setup();
    await runEval(t.base);
    // Two variants, two cases, one judge setting: one check.
    expect(t.preflight).toHaveBeenCalledTimes(1);
    expect(t.preflight).toHaveBeenCalledWith({ keyword: 'certificate' });

    resetPluginsForTests();
    const broken = await setup({ preflightError: 'Set ACME_JUDGE_KEY.' });
    await expect(runEval(broken.base)).rejects.toThrow(
      'Judge "gr/judge/keyword" can\'t run: Set ACME_JUDGE_KEY.'
    );
    expect(broken.client).not.toHaveBeenCalled();
    expect(broken.judge).not.toHaveBeenCalled();
    await expect(
      fs.readdir(
        path.join(broken.dir, '.mcp-test-results', 'grade-test', 'runs')
      )
    ).rejects.toThrow();
  });

  it('mst grade checks the judges before writing a regrade; --no-grade does not check them', async () => {
    const t = await setup({ preflightError: 'Set ACME_JUDGE_KEY.' });
    const collected = await runEval({ ...t.base, grade: false });
    expect(t.preflight).not.toHaveBeenCalled();
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow("can't run: Set ACME_JUDGE_KEY.");
    expect(t.judge).not.toHaveBeenCalled();
    const runs = await fs.readdir(path.dirname(collected.outputDir));
    expect(runs).toEqual([path.basename(collected.outputDir)]);
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
    // A relative run directory is relative to --root-dir, not the cwd.
    const base = path.dirname(runs);
    await expect(
      findRunDirectory(runs, path.join(path.basename(runs), ids[3]!), base)
    ).resolves.toBe(path.join(runs, ids[3]!));
    await expect(findRunDirectory(runs, '7f3c2a', base)).resolves.toBe(
      path.join(runs, ids[0]!)
    );
    await expect(findRunDirectory(runs, '7f3c2a.g2', base)).resolves.toBe(
      path.join(runs, ids[1]!)
    );
    await expect(findRunDirectory(runs, ids[2]!, base)).resolves.toBe(
      path.join(runs, ids[2]!)
    );
    await expect(
      findRunDirectory(runs, path.join(runs, ids[3]!), base)
    ).resolves.toBe(path.join(runs, ids[3]!));
    await expect(findRunDirectory(runs, 'abc123', base)).rejects.toThrow(
      /matches 2 runs/
    );
    await expect(findRunDirectory(runs, 'ffffff', base)).rejects.toThrow(
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

describe("trials' client artifacts", () => {
  it('judges read a copy kept in the run, without private files, and mst grade reads the same copy', async () => {
    const t = await setup({ artifacts: true });
    const collected = await runEval(t.base);
    // 4 judge calls and 4 pairwise calls (2 cases, both orders, 2 sides).
    const atCollect = t.seen.splice(0);
    expect(atCollect).toHaveLength(4 + 8);
    for (const view of atCollect) {
      expect(view.dir.startsWith(collected.outputDir)).toBe(true);
      expect(view.files).toEqual([
        'audit.jsonl',
        'outputs',
        'outputs/answer.md',
      ]);
      expect(view.answer).toMatch(/^(baseline|better) wrote: /);
    }
    const trace = await readJson(
      path.join(collected.outputDir, 'traces', 'better', 'cause', '0.json')
    );
    expect(trace.artifacts).toBe(
      path.join('artifacts', 'better', 'cause', '0')
    );
    // No stored file holds the session's path.
    const stored = await fs.readFile(
      path.join(collected.outputDir, 'results.json'),
      'utf8'
    );
    expect(stored).not.toContain('session-');
    expect(stored).not.toContain('artifactsDir');

    const regrade = await gradeRun({ ...t.base, run: collected.outputDir });
    const atGrade = t.seen.splice(0);
    expect(atGrade).toHaveLength(12);
    for (const view of atGrade)
      expect(view.dir.startsWith(regrade.outputDir)).toBe(true);
    const relative = (views: typeof atGrade, root: string) =>
      views
        .map((view) => ({ ...view, dir: path.relative(root, view.dir) }))
        .sort((a, b) => a.dir.localeCompare(b.dir));
    expect(relative(atGrade, regrade.outputDir)).toEqual(
      relative(atCollect, collected.outputDir)
    );
  });

  it("mst grade refuses a run whose trial names another directory's artifacts", async () => {
    const t = await setup({ artifacts: true });
    const collected = await runEval(t.base);
    const file = path.join(
      collected.outputDir,
      'traces',
      'better',
      'cause',
      '0.json'
    );
    const trace = await readJson(file);
    await fs.writeFile(
      file,
      JSON.stringify({ ...trace, artifacts: '../../..' })
    );
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow(
      /names artifacts at "\.\.\/\.\.\/\.\.".*the run directory was changed/
    );
    expect(t.judge).toHaveBeenCalledTimes(4);
  });

  it('mst grade refuses stored artifacts behind a symbolic link', async () => {
    const t = await setup({ artifacts: true });
    const collected = await runEval(t.base);
    const elsewhere = await fs.mkdtemp(path.join(t.dir, 'elsewhere-'));
    await fs.mkdir(path.join(elsewhere, 'cause', '0'), { recursive: true });
    const variantDir = path.join(collected.outputDir, 'artifacts', 'better');
    await fs.rm(variantDir, { recursive: true });
    await fs.symlink(elsewhere, variantDir);
    await expect(
      gradeRun({ ...t.base, run: collected.outputDir })
    ).rejects.toThrow(/leads outside the run directory/);
  });

  it("a trial whose artifacts can't be copied is an infrastructure failure, without the path", async () => {
    const t = await setup({
      artifacts: true,
      artifactsDir: '/nonexistent/mst-session',
    });
    const collected = await runEval(t.base);
    expect(t.judge).not.toHaveBeenCalled();
    for (const result of collected.summary.results)
      expect(result.error).toMatch(
        /^Couldn't copy the trial's client artifacts: /
      );
    const trace = await readJson(
      path.join(collected.outputDir, 'traces', 'better', 'cause', '0.json')
    );
    expect(trace.infrastructureError).toBe(true);
    expect(trace.clientDiagnostics).toEqual({ failureKind: 'artifacts' });
    const stored = await fs.readFile(
      path.join(collected.outputDir, 'results.json'),
      'utf8'
    );
    expect(stored).not.toContain('/nonexistent/mst-session"');
  });

  it('a run that redacts its traces lets judges read a copy, then removes it', async () => {
    const t = await setup({ artifacts: true, redact: true });
    const collected = await runEval(t.base);
    expect(t.seen).toHaveLength(12);
    for (const view of t.seen) {
      expect(view.dir.startsWith(collected.outputDir)).toBe(false);
      expect(view.files).not.toContain('.audit-key');
      await expect(fs.stat(view.dir)).rejects.toThrow();
    }
    await expect(
      fs.stat(path.join(collected.outputDir, 'artifacts'))
    ).rejects.toThrow();
  });
});

describe('withoutTrialArtifacts', () => {
  it("drops trials' artifact paths from a stored copy, not from the results graders use", () => {
    const result = {
      id: 'cause',
      artifacts: { dir: '/tmp/session', include: ['outputs'] },
      trialResults: [{ pass: true, artifacts: { dir: '/tmp/session/0' } }],
      response: { artifacts: ['report.md'] },
    };
    const summary = {
      results: [result],
      variants: [{ result: { caseResults: [result] } }],
    };
    const stored = withoutTrialArtifacts(summary);
    expect(JSON.stringify(stored)).not.toContain('/tmp/session');
    // Other fields named "artifacts" stay.
    expect(stored.results[0]!.response).toEqual({ artifacts: ['report.md'] });
    expect(result.artifacts.dir).toBe('/tmp/session');
  });
});
