/**
 * Case judges with the eval config's, and pairwise judges comparing each
 * variant with the baseline after a run.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { validateEvalConfig } from './configValidation.js';
import { loadEvalConfigFromObject } from './evalConfig.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { PairwiseJudgeInput } from '../judge/pairwiseContract.js';
import type { JudgeInput } from '../judge/judgeContract.js';

let dir: string;

/** Every judge call: the judge, the response it saw, its options. */
const judged: Array<{ judge: string; text: string; options: unknown }> = [];
const compared: Array<{ baseline: string; candidate: string }> = [];

function scoring(name: string) {
  return {
    schema: z.object({ strict: z.boolean().optional() }).passthrough(),
    evaluate: async ({ trial }: JudgeInput, options: unknown) => {
      judged.push({ judge: name, text: trial.text, options });
      return { score: 1 };
    },
  };
}

const plugin: Plugin = {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  clients: {
    // Answers with its variant's name, so the pairwise judge can tell them apart.
    echo: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => ({
        finalText: `${context.variant?.name ?? 'default'} says ${input.prompt}`,
        events: [],
      }),
    },
  },
  judges: {
    config: scoring('config'),
    tone: scoring('tone'),
    variant: scoring('variant'),
  },
  pairwiseJudges: {
    // Prefers whichever side answered as "better".
    prefer: {
      schema: z.object({ favour: z.string().default('better') }),
      compare: async (input: PairwiseJudgeInput, options) => {
        const { favour } = options as { favour: string };
        compared.push({
          baseline: input.baseline.text,
          candidate: input.candidate.text,
        });
        const candidate = input.candidate.text.startsWith(favour);
        const baseline = input.baseline.text.startsWith(favour);
        return {
          preference:
            candidate === baseline
              ? 'tie'
              : candidate
                ? 'candidate'
                : 'baseline',
          strength: 1,
          usage: { inputTokens: 5, outputTokens: 1 },
        };
      },
    },
  },
  configs: {
    shared: { pairwiseJudges: ['acme/pairwise-judge/prefer'] },
  },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-judges-'));
  judged.length = 0;
  compared.length = 0;
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        {
          id: 'own',
          input: 'one',
          // The case's settings win for the config judge; its own judge runs too.
          judges: [
            { type: 'acme/judge/config', strict: true },
            'acme/judge/tone',
          ],
        },
        { id: 'plain', input: 'two' },
      ],
    })
  );
});
afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function evalConfig(config: Record<string, unknown>): Promise<string> {
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'judges',
      datasets: ['./cases.json'],
      client: 'acme/client/echo',
      servers: {},
      ...config,
    })
  );
  return configPath;
}

function run(configPath: string, variant?: string | string[]) {
  return runEval({
    configPath,
    rootDir: dir,
    plugins: [plugin],
    ...(variant ? { variant } : {}),
  });
}

describe('case judges and eval config judges', () => {
  it('runs the case judges and the config judges; the case wins for a judge in both', async () => {
    const configPath = await evalConfig({
      judges: [{ type: 'acme/judge/config', strict: false }],
    });
    const { summary } = await run(configPath);
    expect(
      judged.map(({ judge, text, options }) => [judge, text, options])
    ).toEqual(
      expect.arrayContaining([
        ['config', 'default says one', { strict: true }],
        ['tone', 'default says one', {}],
        ['config', 'default says two', { strict: false }],
      ])
    );
    expect(judged).toHaveLength(3);
    const own = summary.results.find((result) => result.id === 'own');
    expect(own?.request?.judges).toEqual([
      { type: 'acme/judge/tone' },
      expect.objectContaining({ type: 'acme/judge/config', strict: true }),
    ]);
    expect(own?.scores.judge?.judgeResults).toHaveLength(2);
  });

  it("replaces the config's judges with a variant's; the case's own judges still run", async () => {
    const configPath = await evalConfig({
      judges: ['acme/judge/config'],
      variants: [
        { name: 'base' },
        { name: 'swapped', judges: ['acme/judge/variant'] },
      ],
    });
    await run(configPath);
    const of = (variant: string) =>
      judged
        .filter(({ text }) => text.startsWith(variant))
        .map(({ judge, text }) => `${judge}:${text.split(' ').at(-1)}`)
        .sort();
    expect(of('base')).toEqual(['config:one', 'config:two', 'tone:one']);
    // The case's own `config` judge isn't the variant's, so it still runs.
    expect(of('swapped')).toEqual([
      'config:one',
      'tone:one',
      'variant:one',
      'variant:two',
    ]);
  });
});

describe('pairwiseJudges in an eval config', () => {
  function validate(config: Record<string, unknown>, namespaces = ['acme']) {
    installPlugins([plugin]);
    return validateEvalConfig(
      loadEvalConfigFromObject(
        {
          name: 'p',
          datasets: ['x.json'],
          client: 'acme/client/echo',
          ...config,
        },
        { skipDatasetValidation: true }
      ),
      { namespaces }
    );
  }

  it('accepts references and tagged entries, and keeps them as written', () => {
    expect(
      validate({
        pairwiseJudges: [
          'acme/pairwise-judge/prefer',
          { type: 'acme/pairwise-judge/prefer', favour: 'base', reps: 2 },
        ],
      }).pairwiseJudges
    ).toEqual([
      { type: 'acme/pairwise-judge/prefer' },
      { type: 'acme/pairwise-judge/prefer', favour: 'base', reps: 2 },
    ]);
  });

  it.each([
    [
      ['acme/judge/config'],
      '"acme/judge/config" is a judge, not a pairwise judge',
    ],
    [['acme/prefer'], 'needs its kind: use "acme/pairwise-judge/prefer"'],
    [
      ['acme/pairwise-judge/missing'],
      'Pairwise judge "acme/pairwise-judge/missing" is not available',
    ],
    [
      [{ type: 'acme/pairwise-judge/prefer', favour: 3 }],
      'pairwise judge options "acme/pairwise-judge/prefer"',
    ],
    [
      [{ type: 'acme/pairwise-judge/prefer', reps: 0 }],
      'reps must be a whole number',
    ],
  ])('rejects %j', (pairwiseJudges, message) => {
    expect(() => validate({ pairwiseJudges })).toThrow(message);
  });

  it("rejects a namespace the eval doesn't load", () => {
    // Installed (by another eval in the process), but not this eval's plugin.
    installPlugins([
      {
        meta: { name: 'other-plugin', namespace: 'other' },
        pairwiseJudges: { prefer: plugin.pairwiseJudges!.prefer! },
      },
    ]);
    expect(() =>
      validate({ pairwiseJudges: ['other/pairwise-judge/prefer'] })
    ).toThrow(
      `references "other/pairwise-judge/prefer", but doesn't load the "other" plugin`
    );
    expect(
      validate({ pairwiseJudges: ['other/pairwise-judge/prefer'] }, [
        'acme',
        'other',
      ]).pairwiseJudges
    ).toEqual([{ type: 'other/pairwise-judge/prefer' }]);
  });

  it("checks an eval config judge's threshold and reps when validating", () => {
    // These used to be caught only when the merged judges were re-parsed at run time.
    expect(() =>
      validate({ judges: [{ type: 'acme/judge/config', threshold: 2 }] })
    ).toThrow('Invalid judge "acme/judge/config": threshold');
    expect(() =>
      validate({
        variants: [
          { name: 'a', judges: [{ type: 'acme/judge/config', reps: 0 }] },
        ],
      })
    ).toThrow('Invalid judge "acme/judge/config": reps');
  });

  it('is not a variant setting', () => {
    expect(() =>
      loadEvalConfigFromObject(
        {
          name: 'p',
          datasets: ['x.json'],
          variants: [
            { name: 'a', pairwiseJudges: ['acme/pairwise-judge/prefer'] },
          ],
        },
        { skipDatasetValidation: true }
      )
    ).toThrow("list them in the eval config's top-level `pairwiseJudges`");
  });
});

describe('pairwise judges in a run', () => {
  const variants = [{ name: 'base' }, { name: 'better' }, { name: 'worse' }];

  it('compares each variant with the baseline and records it on the variant', async () => {
    const configPath = await evalConfig({
      variants,
      pairwiseJudges: ['acme/pairwise-judge/prefer'],
    });
    const { summary } = await run(configPath);
    const [base, better, worse] = summary.variants;
    expect(base?.pairwise).toBeUndefined();
    expect(better?.pairwise).toMatchObject({
      baseline: 'base',
      candidate: 'better',
      unmatched: { baselineOnly: [], candidateOnly: [] },
      summary: [
        {
          judge: 'acme/pairwise-judge/prefer',
          compared: 2,
          candidateWins: 2,
          baselineWins: 0,
          ties: 0,
          candidateWinRate: 1,
          consistency: 1,
        },
      ],
    });
    expect(
      better?.pairwise?.cases.map((entry) => [
        entry.id,
        entry.preferences.map((preference) => preference.preference),
      ])
    ).toEqual([
      ['own', ['candidate']],
      ['plain', ['candidate']],
    ]);
    // Neither side starts with "better": every case is a tie.
    expect(worse?.pairwise?.summary[0]).toMatchObject({
      compared: 2,
      ties: 2,
      candidateWinRate: 0.5,
    });
    // Both orders, two cases, two candidates: 8 calls of 5 + 1 tokens.
    expect(compared).toHaveLength(8);
    expect(summary.telemetry?.pairwiseJudgeUsage).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
    });
    expect(summary.telemetry?.totalJudgeUsage).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
    });
  });

  it('passes options and reps, and takes pairwise judges from a shared config', async () => {
    const configPath = await evalConfig({
      extends: ['acme/config/shared'],
      variants: variants.slice(0, 2),
    });
    const { summary } = await run(configPath);
    expect(summary.variants[1]?.pairwise?.summary[0]?.candidateWins).toBe(2);

    compared.length = 0;
    const tagged = await evalConfig({
      variants: variants.slice(0, 2),
      pairwiseJudges: [
        { type: 'acme/pairwise-judge/prefer', favour: 'base', reps: 2 },
      ],
    });
    const rerun = await run(tagged);
    expect(rerun.summary.variants[1]?.pairwise?.summary[0]).toMatchObject({
      baselineWins: 2,
      candidateWins: 0,
    });
    expect(compared).toHaveLength(8);
  });

  it('runs no pairwise judge without variants to compare', async () => {
    const configPath = await evalConfig({
      pairwiseJudges: ['acme/pairwise-judge/prefer'],
    });
    const { summary } = await run(configPath);
    expect(summary.variants.map((variant) => variant.pairwise)).toEqual([
      undefined,
    ]);
    expect(compared).toHaveLength(0);
    expect(summary.telemetry?.pairwiseJudgeUsage).toBeUndefined();
  });

  it('skips pairwise, with a note, when --variant leaves out the baseline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = await evalConfig({
      variants,
      pairwiseJudges: ['acme/pairwise-judge/prefer'],
    });
    const { summary } = await run(configPath, ['better', 'worse']);
    expect(summary.variants.map((variant) => variant.pairwise)).toEqual([
      undefined,
      undefined,
    ]);
    expect(compared).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      `[mst] The baseline "base" didn't run, so no pairwise judge compared the variants with it.`
    );
  });

  it('compares the variants --variant runs when the baseline is among them', async () => {
    const configPath = await evalConfig({
      variants,
      baseline: 'worse',
      pairwiseJudges: ['acme/pairwise-judge/prefer'],
    });
    const { summary } = await run(configPath, ['better', 'worse']);
    expect(summary.variants.map((variant) => variant.name)).toEqual([
      'worse',
      'better',
    ]);
    expect(summary.variants[1]?.pairwise).toMatchObject({
      baseline: 'worse',
      candidate: 'better',
    });
  });
});
