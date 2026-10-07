/**
 * runToolOptimization on an eval, end to end: the use-case fixture's model
 * client (a plugin client, so variants reach it through MST's tool proxy) and a
 * stdio catalog server. The model calls the tool whose description mentions
 * "connected sources", so only the verbose variant passes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runEval } from './runEval.js';
import { runToolOptimization } from './toolOptimization.js';
import type { ToolOverrideVariant } from './evalRunner.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/usecases/fixtures'
);

const concise: ToolOverrideVariant = {
  id: 'concise',
  tools: { search: { description: 'Search.' } },
};
const verbose: ToolOverrideVariant = {
  id: 'verbose',
  tools: {
    search: {
      description:
        'Search across all connected sources: documents, tickets, chat and mail.',
    },
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function evalRun(variants?: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-suite-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'triggering',
      cases: [
        {
          id: 'cross-source',
          input: 'Find everything about the checkout outage',
          assertions: {
            toolsTriggered: { calls: [{ name: 'search', required: true }] },
          },
        },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'description-variants',
      datasets: ['./cases.json'],
      plugins: [path.join(FIXTURES, 'plugin.mjs')],
      servers: [
        {
          transport: 'stdio',
          command: process.execPath,
          args: [
            path.join(FIXTURES, 'catalogServer.mjs'),
            path.join(FIXTURES, 'catalogs', 'aggregate.json'),
          ],
          label: 'agg',
        },
      ],
      client: 'usecase/model',
      clientOptions: {
        policy: [
          {
            steps: [
              {
                call: { description: 'connected sources' },
                args: { query: 'checkout outage' },
              },
            ],
          },
        ],
      },
      metrics: ['passed', 'input_tokens'],
      ...(variants ? { variants } : {}),
    })
  );
  return path.join(dir, 'eval.json');
}

describe('runToolOptimization on an eval', () => {
  it('runs candidates as variants and ranks the one that passes first', async () => {
    const configPath = await evalRun();
    const result = await runToolOptimization({
      evalConfig: { configPath, rootDir: path.dirname(configPath) },
      variants: [concise, verbose],
    });

    expect(result.baseline.passed).toBe(0);
    expect(
      result.rounds[0]?.candidates.map((c) => [c.variant.id, c.metricValue])
    ).toEqual([
      ['concise', 0],
      ['verbose', 1],
    ]);
    expect(result.winner?.variant.id).toBe('verbose');
    // One case can't show a clear improvement (the exact paired test's
    // smallest p-value is 0.5), so the winner isn't recommended.
    expect(result.proposal).toMatchObject({
      variantId: 'verbose',
      metric: 'passRate',
      recommendation: 'inconclusive',
      improvedCaseIds: ['cross-source'],
    });
  }, 60_000);

  it('optimizes a metric where lower is better', async () => {
    const configPath = await evalRun();
    const result = await runToolOptimization({
      evalConfig: { configPath, rootDir: path.dirname(configPath) },
      variants: [concise, verbose],
      metric: 'input_tokens_mean',
      better: 'lower',
    });

    const [conciseRun, verboseRun] = result.rounds[0]!.candidates;
    expect(conciseRun!.metricValue).toBeLessThan(
      result.proposal!.baselineValue
    );
    expect(verboseRun!.metricValue).toBeGreaterThan(conciseRun!.metricValue);
    expect(result.winner?.variant.id).toBe('concise');
    expect(result.proposal?.recommendation).toBe('apply');
    expect(result.proposal!.delta).toBeLessThan(0);
  }, 60_000);

  it('builds on a named variant', async () => {
    const configPath = await evalRun([{ name: 'control' }, { name: 'other' }]);
    const result = await runToolOptimization({
      evalConfig: {
        configPath,
        baseVariant: 'control',
        rootDir: path.dirname(configPath),
      },
      variants: [verbose],
    });
    expect(result.baseline.caseResults[0]?.variant).toBe('control');
    expect(result.winner?.result.caseResults[0]?.variant).toBe('verbose');
  }, 60_000);

  it("builds on the config's baseline, which the candidates replace", async () => {
    const configPath = await evalRun([{ name: 'other' }, { name: 'control' }]);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, baseline: 'control' })
    );
    const result = await runToolOptimization({
      evalConfig: { configPath, rootDir: path.dirname(configPath) },
      variants: [verbose],
    });
    expect(result.baseline.caseResults[0]?.variant).toBe('control');
    expect(result.winner?.result.caseResults[0]?.variant).toBe('verbose');
  }, 60_000);

  it('names the replacement for a renamed eval option', async () => {
    await expect(
      runToolOptimization({
        evalConfig: { configPath: 'x.json', arm: 'control' } as never,
        variants: [verbose],
      })
    ).rejects.toThrow(
      'runToolOptimization evalConfig: `arm` is now `baseVariant`.'
    );
  });

  it('rejects an unknown base variant and clashing ids before running anything', async () => {
    const configPath = await evalRun([{ name: 'control' }]);
    const rootDir = path.dirname(configPath);
    await expect(
      runToolOptimization({
        evalConfig: { configPath, baseVariant: 'missing', rootDir },
        variants: [verbose],
      })
    ).rejects.toThrow('The eval config has no variant named "missing".');
    await expect(
      runToolOptimization({
        evalConfig: { configPath, baseVariant: 'control', rootDir },
        variants: [{ ...verbose, id: 'control' }],
      })
    ).rejects.toThrow(
      "Candidate ids must be unique and differ from the base variant's name"
    );
    await expect(
      fs.access(path.join(rootDir, '.mcp-test-results'))
    ).rejects.toThrow();
  }, 60_000);

  it('runs proposed variants round by round until a round stops improving', async () => {
    const configPath = await evalRun();
    const seen: Array<{ round: number; baseline: number }> = [];
    const result = await runToolOptimization({
      evalConfig: { configPath, rootDir: path.dirname(configPath) },
      metric: 'input_tokens_mean',
      better: 'lower',
      maxRounds: 3,
      proposeVariants: async ({ round, baseline }) => {
        seen.push({ round, baseline: baseline.total });
        return round === 0 ? [concise] : round === 1 ? [verbose] : [];
      },
    });
    // Round 1 (verbose) is worse than the best so far, so the loop stops.
    expect(seen.map((entry) => entry.round)).toEqual([0, 1]);
    expect(
      result.rounds.map((round) => round.candidates[0]?.variant.id)
    ).toEqual(['concise', 'verbose']);
    expect(result.winner?.variant.id).toBe('concise');
    expect(result.reason).toBe('no-improvement');
  }, 60_000);
});

describe('runEval variants', () => {
  it('runs the baseline first, as `baseline` names it', async () => {
    const configPath = await evalRun([{ name: 'a' }, { name: 'b' }]);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, baseline: 'b' })
    );
    const result = await runEval({
      configPath,
      rootDir: path.dirname(configPath),
      dryRun: true,
    });
    expect(result.evalConfig.variants?.map((variant) => variant.name)).toEqual([
      'b',
      'a',
    ]);
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, baseline: 'missing' })
    );
    await expect(
      runEval({
        configPath,
        rootDir: path.dirname(configPath),
        dryRun: true,
      })
    ).rejects.toThrow(
      'baseline "missing" names no variant; the variants are "a", "b".'
    );
  }, 60_000);

  it('names the replacement for a renamed option', async () => {
    await expect(runEval({ manifestPath: 'x.json' } as never)).rejects.toThrow(
      'runEval: `manifestPath` is now `configPath`.'
    );
  });

  it('replaces the config variants with a list, or a function of them', async () => {
    const configPath = await evalRun([{ name: 'a' }, { name: 'b' }]);
    const rootDir = path.dirname(configPath);
    const listed = await runEval({
      configPath,
      rootDir,
      dryRun: true,
      variants: [{ name: 'x' }],
    });
    expect(listed.evalConfig.variants?.map((variant) => variant.name)).toEqual([
      'x',
    ]);
    const derived = await runEval({
      configPath,
      rootDir,
      dryRun: true,
      variants: (variants) => [...variants].reverse(),
    });
    expect(derived.evalConfig.variants?.map((variant) => variant.name)).toEqual(
      ['b', 'a']
    );
  }, 60_000);
});
