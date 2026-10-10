import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDatasets, pullDataset, showDataset } from './index.js';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { runEval } from '../../../evals/runEval.js';

let dir: string;
let pluginPath: string;

// A plugin module, loaded the way --plugins loads one. Its cases are
// canonical, as loadEvalDatasetFromObject returns them.
const PLUGIN = `
import { z } from 'zod';
const cases = [
  { id: 'a', input: 'qa', tags: ['source:correctness', 'tool:search'],
    judges: [{ type: 'acme/judge/completeness' }] },
  { id: 'b', input: 'qb', tags: ['source:correctness'] },
  { id: 'c', input: 'qc', judges: [{ type: 'rubric', rubric: 'correctness' }] },
];
const none = z.object({ type: z.string() }).strict();
export default {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  judges: {
    completeness: { schema: z.object({}).passthrough(), async evaluate() { return { score: 1 }; } },
  },
  datasetSources: {
    'info-seeking': {
      description: 'Questions with one right answer.',
      snapshots: true,
      schema: none,
      async load(_config, { request }) {
        globalThis.__requests?.push(request);
        return request.source === 'live'
          ? { name: 'info-seeking', cases: cases.slice(0, 2) }
          : { name: 'info-seeking', cases, snapshot: request.snapshot ?? '2026-10-06' };
      },
      async describe() {
        return { cases: 3, snapshot: '2026-10-06', tags: ['source:correctness', 'tool:*'] };
      },
    },
    'action-taking': {
      schema: none,
      async load() { return { name: 'action-taking', cases }; },
    },
    broken: {
      description: 'Its index is down.',
      schema: none,
      async load() { throw new Error('index unavailable'); },
      async describe() { throw new Error('index unavailable'); },
    },
    bigquery: {
      description: 'Any table.',
      schema: z.object({ type: z.string(), table: z.string() }).strict(),
      async load() { return { name: 'bq', cases }; },
    },
  },
};
`;

const requests: unknown[] = [];
(globalThis as { __requests?: unknown[] }).__requests = requests;

function capture(): { text: () => string; print: (text: string) => void } {
  let out = '';
  return { text: () => out, print: (text) => (out += text) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-datasets-'));
  pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(pluginPath, PLUGIN);
  // The plugin imports zod: resolve it from this package.
  await fs.symlink(
    path.resolve('node_modules'),
    path.join(dir, 'node_modules'),
    'dir'
  );
  requests.length = 0;
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

const plugins = () => ({ plugins: [pluginPath], rootDir: dir });

describe('mst datasets', () => {
  it('lists datasets with what describe() reports', async () => {
    const out = capture();
    await listDatasets(plugins(), out.print);
    expect(out.text()).toMatchInlineSnapshot(`
      "acme/dataset/action-taking
      acme/dataset/bigquery                                     (takes options; use it in an eval config)  Any table.
      acme/dataset/broken                                       (describe failed: index unavailable)
      acme/dataset/info-seeking   3 cases  snapshot 2026-10-06  tags: source:correctness, tool:*  Questions with one right answer.
      "
    `);
    // Listing reads no cases.
    expect(requests).toEqual([]);
  });

  it('lists as JSON', async () => {
    const out = capture();
    await listDatasets({ ...plugins(), json: true }, out.print);
    expect(JSON.parse(out.text())).toEqual([
      { ref: 'acme/dataset/action-taking' },
      {
        ref: 'acme/dataset/bigquery',
        description: 'Any table.',
        needsOptions: true,
      },
      {
        ref: 'acme/dataset/broken',
        description: 'Its index is down.',
        error: 'index unavailable',
      },
      {
        ref: 'acme/dataset/info-seeking',
        description: 'Questions with one right answer.',
        snapshots: true,
        cases: 3,
        snapshot: '2026-10-06',
        tags: ['source:correctness', 'tool:*'],
      },
    ]);
  });

  it("lists an eval config's plugins' datasets", async () => {
    const config = path.join(dir, 'eval.json');
    await fs.writeFile(
      config,
      JSON.stringify({
        name: 'x',
        plugins: ['./plugin.mjs'],
        datasets: ['acme/dataset/info-seeking'],
      })
    );
    const out = capture();
    await listDatasets({ config, rootDir: dir, json: true }, out.print);
    expect(
      (JSON.parse(out.text()) as Array<{ ref: string }>).map((d) => d.ref)
    ).toEqual([
      'acme/dataset/action-taking',
      'acme/dataset/bigquery',
      'acme/dataset/broken',
      'acme/dataset/info-seeking',
    ]);
  });

  it('needs plugins to look in', async () => {
    await expect(listDatasets({ rootDir: dir })).rejects.toThrow(
      /--plugins <module...>, or --config/
    );
  });
});

describe('mst datasets show', () => {
  it('shows the copy, cases, hash, tags and judges', async () => {
    const out = capture();
    await showDataset('acme/dataset/info-seeking', plugins(), out.print);
    expect(out.text()).toMatch(
      new RegExp(
        [
          'acme/dataset/info-seeking',
          '  Questions with one right answer.',
          '  copy      snapshot 2026-10-06',
          '  cases     3',
          '  hash      [0-9a-f]{64}',
          '  tags      source:correctness \\(2\\), tool:search \\(1\\)',
          '  judges    acme/judge/completeness \\(1\\), rubric \\(1\\)',
          '  case ids  a, b, c',
        ].join('\\n')
      )
    );
    expect(requests).toEqual([{ source: 'snapshot' }]);
  });

  it('shows a pinned snapshot or live data, as JSON', async () => {
    const pinned = capture();
    await showDataset(
      'acme/dataset/info-seeking',
      { ...plugins(), snapshot: '2026-10-01', json: true },
      pinned.print
    );
    expect(JSON.parse(pinned.text())).toMatchObject({
      snapshot: '2026-10-01',
      caseCount: 3,
      caseIds: ['a', 'b', 'c'],
    });
    const live = capture();
    await showDataset(
      'acme/dataset/info-seeking',
      { ...plugins(), source: 'live', json: true },
      live.print
    );
    const shown = JSON.parse(live.text()) as Record<string, unknown>;
    expect(shown).toMatchObject({ source: 'live', caseCount: 2 });
    expect(shown).not.toHaveProperty('snapshot');
  });

  it('rejects what it cannot show', async () => {
    await expect(showDataset('acme/dataset/nope', plugins())).rejects.toThrow(
      /"acme\/dataset\/nope" is not available/
    );
    await expect(showDataset('other/dataset/x', plugins())).rejects.toThrow(
      /isn't in the loaded plugins \(acme\)/
    );
    await expect(
      showDataset('acme/judge/completeness', plugins())
    ).rejects.toThrow(/judge/);
    await expect(
      showDataset('acme/dataset/bigquery', plugins())
    ).rejects.toThrow(/takes options/);
    await expect(
      showDataset('acme/dataset/action-taking', { ...plugins(), snapshot: '1' })
    ).rejects.toThrow(/has no snapshots/);
    await expect(
      showDataset('acme/dataset/info-seeking', {
        ...plugins(),
        source: 'live',
        snapshot: '1',
      })
    ).rejects.toThrow(/live dataset has no snapshot/);
    await expect(showDataset('acme/dataset/broken', plugins())).rejects.toThrow(
      /index unavailable/
    );
  });
});

describe('mst datasets pull', () => {
  it('writes a dataset file that runs with the same cases', async () => {
    const report = capture();
    await pullDataset(
      'acme/dataset/info-seeking',
      {
        ...plugins(),
        snapshot: '2026-10-01',
        out: path.join(dir, 'out', 'info.json'),
      },
      () => {},
      report.print
    );
    const pulled = JSON.parse(
      await fs.readFile(path.join(dir, 'out', 'info.json'), 'utf8')
    ) as Record<string, unknown> & { cases: unknown[] };
    expect(pulled.name).toBe('info-seeking');
    expect(pulled.cases).toHaveLength(3);
    expect(pulled).not.toHaveProperty('snapshot');
    expect(pulled).not.toHaveProperty('origin');
    expect(report.text()).toMatch(
      /^acme\/dataset\/info-seeking: 3 cases \(snapshot 2026-10-01, hash [0-9a-f]{64}\) -> /
    );
    const hash = /hash ([0-9a-f]{64})/.exec(report.text())?.[1];

    // The file, as a file dataset, hashes the same as the plugin's dataset.
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'pulled',
        // Its cases name the plugin's judge.
        plugins: ['./plugin.mjs'],
        datasets: ['./out/info.json'],
      })
    );
    resetPluginsForTests();
    const { datasets } = await runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
      dryRun: true,
    });
    const { datasetContentHash } = await import('../../../evals/runFormat.js');
    expect(datasetContentHash(datasets[0]!.dataset!)).toBe(hash);
  });

  it('prints to stdout without --out', async () => {
    const out = capture();
    const report = capture();
    await pullDataset(
      'acme/dataset/info-seeking',
      { ...plugins(), source: 'live' },
      out.print,
      report.print
    );
    expect((JSON.parse(out.text()) as { cases: unknown[] }).cases).toHaveLength(
      2
    );
    expect(report.text()).toMatch(/2 cases \(live, hash /);
  });
});
