/**
 * runVariantExperiment on a suite, end to end: the use-case fixture's model
 * host (a plugin host, so variants reach it through MST's tool proxy) and a
 * stdio catalog server. The model calls the tool whose description mentions
 * "connected sources", so only the verbose variant passes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runEvalSuite } from './runEvalSuite.js';
import { runVariantExperiment } from './variantExperiment.js';
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

async function suite(arms?: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-suite-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'triggering',
      cases: [
        {
          id: 'cross-source',
          mode: 'host',
          input: 'Find everything about the checkout outage',
          assertions: {
            toolsTriggered: { calls: [{ name: 'search', required: true }] },
          },
        },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
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
      ...(arms ? { arms } : {}),
    })
  );
  return path.join(dir, 'manifest.json');
}

describe('runVariantExperiment on a suite', () => {
  it('runs variants as arms and ranks the one that passes first', async () => {
    const manifestPath = await suite();
    const result = await runVariantExperiment({
      suite: { manifestPath, rootDir: path.dirname(manifestPath) },
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
    const manifestPath = await suite();
    const result = await runVariantExperiment({
      suite: { manifestPath, rootDir: path.dirname(manifestPath) },
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

  it('builds on a named arm', async () => {
    const manifestPath = await suite([{ name: 'control' }, { name: 'other' }]);
    const result = await runVariantExperiment({
      suite: {
        manifestPath,
        arm: 'control',
        rootDir: path.dirname(manifestPath),
      },
      variants: [verbose],
    });
    expect(result.baseline.caseResults[0]?.arm).toBe('control');
    expect(result.winner?.result.caseResults[0]?.arm).toBe('verbose');
  }, 60_000);

  it('rejects an unknown base arm and clashing ids before running anything', async () => {
    const manifestPath = await suite([{ name: 'control' }]);
    const rootDir = path.dirname(manifestPath);
    await expect(
      runVariantExperiment({
        suite: { manifestPath, arm: 'missing', rootDir },
        variants: [verbose],
      })
    ).rejects.toThrow('The manifest has no arm named "missing".');
    await expect(
      runVariantExperiment({
        suite: { manifestPath, arm: 'control', rootDir },
        variants: [{ ...verbose, id: 'control' }],
      })
    ).rejects.toThrow(
      "Variant ids must be unique and differ from the base arm's name"
    );
    await expect(
      fs.access(path.join(rootDir, '.mcp-test-results'))
    ).rejects.toThrow();
  }, 60_000);

  it('runs proposed variants round by round until a round stops improving', async () => {
    const manifestPath = await suite();
    const seen: Array<{ round: number; baseline: number }> = [];
    const result = await runVariantExperiment({
      suite: { manifestPath, rootDir: path.dirname(manifestPath) },
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

describe('runEvalSuite arms', () => {
  it('replaces the manifest arms with a list, or a function of them', async () => {
    const manifestPath = await suite([{ name: 'a' }, { name: 'b' }]);
    const rootDir = path.dirname(manifestPath);
    const listed = await runEvalSuite({
      manifestPath,
      rootDir,
      dryRun: true,
      arms: [{ name: 'x' }],
    });
    expect(listed.manifest.arms?.map((arm) => arm.name)).toEqual(['x']);
    const derived = await runEvalSuite({
      manifestPath,
      rootDir,
      dryRun: true,
      arms: (arms) => [...arms].reverse(),
    });
    expect(derived.manifest.arms?.map((arm) => arm.name)).toEqual(['b', 'a']);
  }, 60_000);
});
