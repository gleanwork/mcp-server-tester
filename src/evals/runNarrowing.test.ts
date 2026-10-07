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
      servers: [],
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

const suite = (options: { cases?: string[]; trials?: number } = {}) =>
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
