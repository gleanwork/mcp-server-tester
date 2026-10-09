import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { datasetRequest } from './builtinDatasetSources.js';
import { isDatasetReference, loadEvalConfigFromObject } from './evalConfig.js';
import type { DatasetRequest } from './evalFrameworkTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import { assertPlugin, type Plugin } from '../plugins/plugin.js';

let dir: string;
const requests: Array<DatasetRequest | undefined> = [];
const prompts: string[] = [];

const CASES = [
  { id: 'a', input: 'qa', tags: ['keep'] },
  { id: 'b', input: 'qb' },
];
const NoOptions = z.object({ type: z.string() }).strict();

const plugin: Plugin = {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  datasetSources: {
    'info-seeking': {
      description: 'Questions with one right answer.',
      snapshots: true,
      schema: NoOptions,
      async load(_config, context) {
        requests.push(context.request);
        const dataset = loadEvalDatasetFromObject({
          name: 'info-seeking',
          cases: CASES,
        });
        return context.request?.source === 'live'
          ? dataset
          : { ...dataset, snapshot: context.request?.snapshot ?? '2026-10-06' };
      },
    },
    // Reports a different snapshot from the one asked for.
    drifting: {
      snapshots: true,
      schema: NoOptions,
      async load() {
        return {
          ...loadEvalDatasetFromObject({ name: 'drifting', cases: CASES }),
          snapshot: '2026-01-01',
        };
      },
    },
    // A plugin dataset without snapshots.
    fixed: {
      schema: NoOptions,
      async load(_config, context) {
        requests.push(context.request);
        return loadEvalDatasetFromObject({ name: 'fixed', cases: CASES });
      },
    },
  },
  clients: {
    record: {
      schema: z.object({ type: z.string() }).strict(),
      evidence: 'structured',
      run: async (input) => {
        prompts.push(input.prompt);
        return { finalText: 'ok', events: [] };
      },
    },
  },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-plugin-datasets-'));
  requests.length = 0;
  prompts.length = 0;
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

async function suite(datasets: unknown[], options: { dryRun?: boolean } = {}) {
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'named',
      datasets,
      client: 'acme/client/record',
      servers: {},
    })
  );
  return runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    dryRun: options.dryRun,
  });
}

async function storedDatasets(outputDir: string): Promise<unknown> {
  const run = JSON.parse(
    await fs.readFile(path.join(outputDir, 'run.json'), 'utf8')
  ) as { datasets: unknown };
  return run.datasets;
}

describe('dataset references', () => {
  it.each([
    ['acme/dataset/info-seeking', true],
    ['@acme/tools/dataset/info-seeking', true],
    ['acme/dataset/info.v2', true],
    ['acme/judge/x', false],
    ['datasets/cases.json', false],
    ['data/dataset/cases.json', false],
    ['./acme/dataset/info-seeking', false],
    ['cases.json', false],
  ])('%s is a dataset reference: %s', (value, expected) => {
    expect(isDatasetReference(value)).toBe(expected);
  });

  it('normalizes names and { ref } entries', () => {
    const config = loadEvalConfigFromObject(
      {
        name: 'x',
        datasets: [
          'acme/dataset/info-seeking',
          'datasets/cases.json',
          { ref: 'acme/dataset/info-seeking', snapshot: '2026-10-01' },
          { ref: 'acme/dataset/info-seeking', source: 'live' },
          { ref: 'mst/dataset/file', snapshot: '1' },
        ],
      },
      { skipDatasetValidation: true }
    );
    expect(config.datasets).toEqual([
      { type: 'acme/dataset/info-seeking' },
      { type: 'file', path: 'datasets/cases.json' },
      { type: 'acme/dataset/info-seeking', snapshot: '2026-10-01' },
      { type: 'acme/dataset/info-seeking', source: 'live' },
      { type: 'file', snapshot: '1' },
    ]);
  });

  it('rejects unknown keys and sources in { ref }', () => {
    for (const entry of [
      { ref: 'acme/dataset/x', snapshots: '1' },
      { ref: 'acme/dataset/x', source: 'nightly' },
    ])
      expect(() =>
        loadEvalConfigFromObject(
          { name: 'x', datasets: [entry] },
          { skipDatasetValidation: true }
        )
      ).toThrow();
  });

  it('asks for a snapshot id only with snapshots', () => {
    expect(datasetRequest({})).toBeUndefined();
    expect(datasetRequest({ snapshot: '1' })).toEqual({
      source: 'snapshot',
      snapshot: '1',
    });
    expect(datasetRequest({ source: 'live' })).toEqual({ source: 'live' });
    expect(() => datasetRequest({ source: 'live', snapshot: '1' })).toThrow(
      /live dataset has no snapshot/
    );
  });
});

describe('dataset source fields', () => {
  it('are checked when the plugin loads', () => {
    const source = { schema: NoOptions, load: async () => ({}) };
    const withSource = (extra: Record<string, unknown>) => () =>
      assertPlugin(
        {
          meta: { name: 'p', namespace: 'p' },
          datasetSources: { d: { ...source, ...extra } },
        },
        'inline'
      );
    expect(withSource({ description: 'x', snapshots: true })).not.toThrow();
    expect(withSource({ description: 1 })).toThrow(
      /description must be a string/
    );
    expect(withSource({ describe: 'x' })).toThrow(
      /describe must be a function/
    );
    expect(withSource({ snapshots: 'yes' })).toThrow(
      /snapshots must be true or false/
    );
  });
});

describe('runs with a plugin dataset', () => {
  it('reads the latest snapshot by default and records it in run.json', async () => {
    const { outputDir } = await suite(['acme/dataset/info-seeking']);
    expect(requests).toEqual([{ source: 'snapshot' }]);
    expect(prompts.sort()).toEqual(['qa', 'qb']);
    expect(await storedDatasets(outputDir)).toEqual([
      {
        name: 'info-seeking',
        caseCount: 2,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        ref: 'acme/dataset/info-seeking',
        snapshot: '2026-10-06',
      },
    ]);
  });

  it('pins a snapshot, or reads live data', async () => {
    const pinned = await suite([
      { ref: 'acme/dataset/info-seeking', snapshot: '2026-10-01' },
    ]);
    expect(requests).toEqual([{ source: 'snapshot', snapshot: '2026-10-01' }]);
    const live = await suite([
      { ref: 'acme/dataset/info-seeking', source: 'live' },
    ]);
    const [pinnedSet] = (await storedDatasets(pinned.outputDir)) as Array<
      Record<string, unknown>
    >;
    const [liveSet] = (await storedDatasets(live.outputDir)) as Array<
      Record<string, unknown>
    >;
    expect(pinnedSet).toMatchObject({ snapshot: '2026-10-01' });
    expect(liveSet).toMatchObject({
      ref: 'acme/dataset/info-seeking',
      live: true,
    });
    expect(liveSet).not.toHaveProperty('snapshot');
    // Same cases, same hash, whichever copy they came from.
    expect(liveSet!.contentHash).toBe(pinnedSet!.contentHash);
  });

  it('records a plugin dataset without snapshots by its ref only', async () => {
    const { outputDir } = await suite(['acme/dataset/fixed']);
    expect(requests).toEqual([undefined]);
    expect(await storedDatasets(outputDir)).toEqual([
      expect.objectContaining({ name: 'fixed', ref: 'acme/dataset/fixed' }),
    ]);
  });

  it('records file datasets as before', async () => {
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({ name: 'cases', cases: CASES })
    );
    const { outputDir } = await suite(['./cases.json']);
    const [stored] = (await storedDatasets(outputDir)) as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(stored!).sort()).toEqual([
      'caseCount',
      'contentHash',
      'name',
    ]);
  });

  it('refuses a snapshot other than the one asked for', async () => {
    await expect(
      suite([{ ref: 'acme/dataset/drifting', snapshot: '2026-10-01' }], {
        dryRun: true,
      })
    ).rejects.toThrow(/asked for snapshot 2026-10-01, got 2026-01-01/);
  });

  it('refuses snapshot options for a source without snapshots', async () => {
    await expect(
      suite([{ ref: 'acme/dataset/fixed', snapshot: '1' }], { dryRun: true })
    ).rejects.toThrow(/"acme\/dataset\/fixed" has no snapshots/);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({ name: 'c', cases: CASES })
    );
    await expect(
      suite([{ type: 'file', path: './cases.json', source: 'live' }], {
        dryRun: true,
      })
    ).rejects.toThrow(/"file" has no snapshots/);
    expect(requests).toEqual([]);
  });

  it('rejects an unknown dataset before loading anything', async () => {
    await expect(
      suite(['acme/dataset/action-taking'], { dryRun: true })
    ).rejects.toThrow(/"acme\/dataset\/action-taking" is not available/);
    expect(requests).toEqual([]);
  });
});
