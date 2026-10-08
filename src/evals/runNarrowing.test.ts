import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

let dir: string;
const prompts: string[] = [];

const plugin: Plugin = {
  meta: { name: 'acme-plugin', namespace: 'acme' },
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-narrowing-'));
  prompts.length = 0;
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        { id: 'a', input: 'qa', tags: ['keep'] },
        { id: 'b', input: 'qb', trials: 3 },
        { id: 'c', input: 'qc', tags: ['keep'] },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'narrowing',
      datasets: ['./cases.json'],
      client: 'acme/client/record',
      servers: {},
      trials: 2,
      filterTags: ['keep'],
      maxCases: 1,
    })
  );
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

const suite = (
  options: {
    cases?: string[];
    trials?: number;
    filterTags?: string[];
    maxCases?: number;
    variant?: string | string[];
  } = {}
) =>
  runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    ...options,
  });

describe('mst run --case / --trials', () => {
  it("runs the config's selection by default", async () => {
    await suite();
    expect(prompts).toEqual(['qa', 'qa']);
  });

  it("runs named cases instead of the config's tags and case cap", async () => {
    const { summary } = await suite({ cases: ['b', 'c'] });
    // b keeps its own 3 trials; c gets the config's 2.
    expect(prompts).toEqual(['qb', 'qb', 'qb', 'qc', 'qc']);
    expect(summary.results.map((result) => result.id).sort()).toEqual([
      'b',
      'c',
    ]);
  });

  it('--trials replaces both the config and the case trials', async () => {
    await suite({ cases: ['b', 'c'], trials: 1 });
    expect(prompts).toEqual(['qb', 'qc']);
  });

  it('fails before running when a named case is in no dataset', async () => {
    await expect(suite({ cases: ['a', 'nope'] })).rejects.toThrow(
      'No case "nope" in the config\'s datasets. Cases: a, b, c'
    );
    expect(prompts).toEqual([]);
  });

  it('checks named cases on a dry run too', async () => {
    await expect(
      runEval({
        configPath: path.join(dir, 'eval.json'),
        rootDir: dir,
        plugins: [plugin],
        dryRun: true,
        cases: ['nope'],
      })
    ).rejects.toThrow('No case "nope"');
  });
});

describe('mst run --filter-tag / --max-cases', () => {
  it("--max-cases replaces the config's case cap", async () => {
    await suite({ maxCases: 2 });
    // The config's tag selection still applies: a and c, then the cap.
    expect(prompts).toEqual(['qa', 'qa', 'qc', 'qc']);
  });

  it("--filter-tag replaces the config's tags", async () => {
    await suite({ filterTags: ['none'] });
    expect(prompts).toEqual([]);
  });

  it('--case wins over --filter-tag and --max-cases', async () => {
    await suite({ cases: ['b'], filterTags: ['keep'], maxCases: 1 });
    expect(prompts).toEqual(['qb', 'qb', 'qb']);
  });
});

describe('partial runs', () => {
  it('a full run is not partial', async () => {
    const { summary } = await suite();
    expect(summary.partial).toBe(false);
    expect(summary.selection).toBeUndefined();
  });

  it('records what narrowed a run', async () => {
    const { summary } = await suite({ cases: ['c', 'a'], trials: 1 });
    expect(summary.partial).toBe(true);
    expect(summary.selection).toEqual({ cases: ['a', 'c'], trials: 1 });
    expect(summary.selectionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same narrowing gives the same selection hash', async () => {
    const first = await suite({ maxCases: 2, filterTags: ['keep'] });
    const second = await suite({ filterTags: ['keep'], maxCases: 2 });
    expect(second.summary.selectionHash).toBe(first.summary.selectionHash);
  });
});

describe('mst run --variant', () => {
  beforeEach(async () => {
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'narrowing',
        datasets: ['./cases.json'],
        client: 'acme/client/record',
        servers: {},
        maxCases: 1,
        variants: [{ name: 'base' }, { name: 'one' }, { name: 'two' }],
      })
    );
  });

  it('runs several variants, in the config order', async () => {
    const { summary } = await suite({ variant: ['two', 'base'] });
    expect(summary.variants.map((variant) => variant.name)).toEqual([
      'base',
      'two',
    ]);
    expect(summary.selection).toEqual({ variants: ['base', 'two'] });
  });

  it('fails before running when a variant is not in the config', async () => {
    await expect(suite({ variant: ['one', 'nope'] })).rejects.toThrow(
      'No variant "nope" in the eval config. Variants: base, one, two.'
    );
    expect(prompts).toEqual([]);
  });

  it('still takes one variant name', async () => {
    const { summary } = await suite({ variant: 'one' });
    expect(summary.variants.map((variant) => variant.name)).toEqual(['one']);
  });
});
