import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];
afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A client that reports 1M input and 100k output tokens, and no cost. */
const plugin: Plugin = {
  meta: { name: 'variant-comparison', namespace: 'variants' },
  clients: {
    tokens: {
      schema: z
        .object({ type: z.string(), model: z.string().optional() })
        .strict(),
      evidence: 'structured',
      run: async () => ({
        finalText: 'answer',
        events: [],
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, durationMs: 1 },
      }),
    },
  },
  judges: {
    score: {
      schema: z.object({ value: z.number() }).strict(),
      evaluate: async (_input, options) => ({
        score: (options as { value: number }).value,
      }),
    },
  },
  configs: {
    prices: { pricing: { 'model-a': { input: 2, output: 10 } } },
  },
};

async function evalRun(evalConfig: Record<string, unknown>, cases: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-comparison-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'variants',
      datasets: ['./cases.json'],
      ...evalConfig,
    })
  );
  return runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
  });
}

describe('pricing', () => {
  it('prices each case at the model it ran, records the prices, and lists unpriced models', async () => {
    const { summary } = await evalRun(
      {
        extends: ['variants/prices'],
        variants: [
          { name: 'a', client: 'variants/tokens', model: 'model-a' },
          { name: 'b', client: 'variants/tokens', model: 'model-b' },
        ],
      },
      [
        { id: 'variant-model', input: 'q' },
        {
          // Its own client: priced at its model, not the variant's.
          id: 'own-model',
          input: 'q',
          client: 'variants/tokens',
          model: 'model-a',
        },
      ]
    );
    const [a, b] = summary.variants;
    // 1M input at $2 and 100k output at $10 per million: $3 a trial.
    expect(a!.metrics?.cost_usd_mean).toBeCloseTo(3, 9);
    expect(a!.costSource).toBe('pricing');
    expect(a!.pricing).toEqual({ 'model-a': { input: 2, output: 10 } });
    expect(a!.unpricedModels).toBeUndefined();
    // Variant b's own case is unpriced; only the case client's model has a price.
    expect(b!.metrics?.cost_usd_mean).toBeCloseTo(3, 9);
    expect(b!.unpricedModels).toEqual(['model-b']);
    // Totals include estimates; the run total is unknown while usage is unpriced.
    expect(a!.result?.totalClientUsage?.estimatedCostUsd).toBeCloseTo(6, 9);
    expect(
      summary.telemetry?.totalClientUsage?.estimatedCostUsd
    ).toBeUndefined();
  });
});

describe('judge scores in the comparison', () => {
  it('reports per-judge score deltas between variants', async () => {
    const { summary } = await evalRun(
      {
        client: 'variants/tokens',
        variants: [
          { name: 'low' },
          {
            name: 'high',
            judges: [{ type: 'variants/score', name: 'quality', value: 0.9 }],
          },
        ],
        judges: [{ type: 'variants/score', name: 'quality', value: 0.4 }],
      },
      [{ id: 'one', input: 'q' }]
    );
    const delta = summary.variantDeltas.high as {
      metricDeltas: Record<string, unknown>;
    };
    expect(summary.variants[0]!.metrics?.judge_score).toEqual({
      'variants/score': 0.4,
    });
    expect(summary.variants[1]!.metrics?.judge_score).toEqual({
      'variants/score': 0.9,
    });
    expect(
      (delta.metricDeltas.judge_score as Record<string, number>)[
        'variants/score'
      ]
    ).toBeCloseTo(0.5, 9);
  });
});
