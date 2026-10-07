import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

const dirs: string[] = [];
afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A host that reports 1M input and 100k output tokens, and no cost. */
const plugin: Plugin = {
  meta: { name: 'arm-comparison', namespace: 'arms' },
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

async function suite(manifest: Record<string, unknown>, cases: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arm-comparison-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases })
  );
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name: 'arms', datasets: ['./cases.json'], ...manifest })
  );
  return runEvalSuite({
    manifestPath: path.join(dir, 'manifest.json'),
    rootDir: dir,
    plugins: [plugin],
  });
}

describe('pricing', () => {
  it('prices each case at the model it ran, records the prices, and lists unpriced models', async () => {
    const { summary } = await suite(
      {
        extends: ['arms/prices'],
        arms: [
          { name: 'a', client: 'arms/tokens', model: 'model-a' },
          { name: 'b', client: 'arms/tokens', model: 'model-b' },
        ],
      },
      [
        { id: 'arm-model', input: 'q' },
        {
          // Its own host: priced at its model, not the arm's.
          id: 'own-model',
          input: 'q',
          client: 'arms/tokens',
          model: 'model-a',
        },
      ]
    );
    const [a, b] = summary.arms;
    // 1M input at $2 and 100k output at $10 per million: $3 a trial.
    expect(a!.metrics?.cost_usd_mean).toBeCloseTo(3, 9);
    expect(a!.costSource).toBe('pricing');
    expect(a!.pricing).toEqual({ 'model-a': { input: 2, output: 10 } });
    expect(a!.unpricedModels).toBeUndefined();
    // Arm b's own case is unpriced; only the case host's model has a price.
    expect(b!.metrics?.cost_usd_mean).toBeCloseTo(3, 9);
    expect(b!.unpricedModels).toEqual(['model-b']);
    // Totals include estimates; the run total is unknown while usage is unpriced.
    expect(a!.result?.totalHostUsage?.estimatedCostUsd).toBeCloseTo(6, 9);
    expect(summary.telemetry?.totalHostUsage?.estimatedCostUsd).toBeUndefined();
  });
});

describe('judge scores in the comparison', () => {
  it('reports per-judge score deltas between arms', async () => {
    const { summary } = await suite(
      {
        client: 'arms/tokens',
        arms: [
          { name: 'low' },
          {
            name: 'high',
            judges: [{ type: 'arms/score', name: 'quality', value: 0.9 }],
          },
        ],
        judges: [{ type: 'arms/score', name: 'quality', value: 0.4 }],
      },
      [{ id: 'one', input: 'q' }]
    );
    const delta = summary.armDeltas.high as {
      metricDeltas: Record<string, unknown>;
    };
    expect(summary.arms[0]!.metrics?.judge_score).toEqual({
      'arms/score': 0.4,
    });
    expect(summary.arms[1]!.metrics?.judge_score).toEqual({
      'arms/score': 0.9,
    });
    expect(
      (delta.metricDeltas.judge_score as Record<string, number>)['arms/score']
    ).toBeCloseTo(0.5, 9);
  });
});
