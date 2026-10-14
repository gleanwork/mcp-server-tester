import fs from 'node:fs/promises';
import { RUN_ID_PATTERN } from './runFormat.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FileEvalResultStore,
  runEvalBatch,
  runEval,
  type EvalConfig,
  type ClientDefinition,
  type ResultStoreDefinition,
  type RunStore,
} from '../entries/evals.js';
import type { Plugin } from '../index.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import { fileRunStore } from './runStore.js';

const dirs: string[] = [];
let sequence = 0;

interface TestPlugin extends Plugin {
  clients: Record<string, ClientDefinition>;
  resultStores: Record<string, ResultStoreDefinition>;
}
function newTestPlugin(): TestPlugin {
  return {
    meta: { name: 'storage-test-plugin', namespace: 'test' },
    clients: {},
    resultStores: {},
  };
}
/** Extensions defined by the current test; evals load it as the `test` plugin. */
let testPlugin = newTestPlugin();

afterEach(async () => {
  resetPluginsForTests();
  testPlugin = newTestPlugin();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function fixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-storage-'));
  dirs.push(rootDir);
  const clientName = `storage-client-${sequence++}`;
  const run = vi.fn<NonNullable<ClientDefinition['run']>>(
    async (_input, _config, context) => ({
      finalText: 'PRIVATE_RESPONSE_MARKER',
      events: Array.from(
        { length: context.variant?.name === 'candidate' ? 2 : 1 },
        () => ({
          kind: 'tool_call' as const,
          source: 'mcp' as const,
          name: 'search',
          arguments: { query: 'documents' },
          output: 'PRIVATE_TOOL_OUTPUT_MARKER',
        })
      ),
    })
  );
  testPlugin.clients[clientName] = {
    schema: z.object({}),
    evidence: 'structured',
    run,
  };
  await fs.writeFile(
    path.join(rootDir, 'dataset.json'),
    JSON.stringify({
      name: 'canonical-storage-dataset',
      cases: [
        {
          id: 'search-case',
          input: 'Find documents',
          assertions: { toolCallCount: { min: 1, max: 1 } },
        },
      ],
    })
  );
  const storeDir = path.join(rootDir, 'store');
  const configPath = path.join(rootDir, 'eval.json');
  const evalConfig: EvalConfig = {
    name: 'storage-suite',
    client: `test/client/${clientName}`,
    datasets: [{ type: 'file', path: './dataset.json' }],
    results: { store: { type: 'file', dir: storeDir } },
  };
  await fs.writeFile(configPath, JSON.stringify(evalConfig));
  return { rootDir, configPath, evalConfig, storeDir, run };
}

/** Every file under `dir`, relative and `/`-separated, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/')
    )
    .sort();
}

async function readLatest(storeDir: string, evalName: string) {
  return JSON.parse(
    await fs.readFile(path.join(storeDir, evalName, 'latest.json'), 'utf8')
  ) as { runId: string; path: string };
}

describe('eval storage through public APIs', () => {
  it.each(['explicit', 'default'])(
    'saves and resumes with a once-transformed %s store directory',
    async (directory) => {
      const f = await fixture();
      const typeName = `transformed-store-${sequence++}`;
      const aliasName = `decoy-store-${sequence++}`;
      const type = `test/result-store/${typeName}`;
      const alias = `test/result-store/${aliasName}`;
      testPlugin.resultStores[typeName] = {
        schema: z.object({
          dir: z
            .string()
            .default(f.storeDir)
            .transform((dir) => path.join(dir, 'resolved')),
        }),
        create(config) {
          return fileRunStore(String(config.dir));
        },
      };
      testPlugin.resultStores[aliasName] = {
        schema: z.object({}),
        create() {
          throw new Error('Plugin-owned name must not route to another store');
        },
      };
      f.evalConfig.results = {
        store: {
          type,
          name: alias,
          ...(directory === 'explicit' ? { dir: f.storeDir } : {}),
        },
      };
      await fs.writeFile(f.configPath, JSON.stringify(f.evalConfig));

      const first = await runEval({
        configPath: f.configPath,
        rootDir: f.rootDir,
        plugins: [testPlugin],
      });
      expect(first.summary.metrics).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
      });
      const resolved = path.join(f.storeDir, 'resolved');
      expect(first.storedIn).toBe(resolved);
      expect(f.run).toHaveBeenCalledTimes(1);
      const resumed = await runEvalBatch({
        configPaths: [f.configPath],
        rootDir: f.rootDir,
        skipExisting: true,
        plugins: [testPlugin],
      });
      expect(resumed).toMatchObject({ skipped: 1, passed: 0, failed: 0 });
      expect(resumed.items[0]?.result).toBeUndefined();
      expect(f.run).toHaveBeenCalledTimes(1);

      const runId = path.basename(first.outputDir);
      expect(await readLatest(resolved, 'storage-suite')).toMatchObject({
        runId,
        path: `runs/${runId}`,
      });
      expect(
        await fs.readdir(path.join(resolved, 'storage-suite', 'runs'))
      ).toEqual([runId]);

      f.evalConfig.name = 'changed-storage-suite';
      await fs.writeFile(f.configPath, JSON.stringify(f.evalConfig));
      const changed = await runEvalBatch({
        configPaths: [f.configPath],
        rootDir: f.rootDir,
        skipExisting: true,
        plugins: [testPlugin],
      });
      expect(changed).toMatchObject({ skipped: 0, passed: 1, failed: 0 });
      expect(f.run).toHaveBeenCalledTimes(2);
      expect((await fs.readdir(resolved)).sort()).toEqual([
        'changed-storage-suite',
        'storage-suite',
      ]);
    }
  );

  it.each([
    {
      label: 'default redaction',
      configRedact: undefined,
      apiRedact: undefined,
      redact: true,
    },
    {
      label: 'eval config opt-out',
      configRedact: false,
      apiRedact: undefined,
      redact: false,
    },
    {
      label: 'API opt-out',
      configRedact: true,
      apiRedact: false,
      redact: false,
    },
    {
      label: 'API enforcement',
      configRedact: false,
      apiRedact: true,
      redact: true,
    },
  ])(
    'stores the run directory as written, with $label',
    async ({ configRedact, apiRedact, redact }) => {
      const f = await fixture();
      f.evalConfig.variants = [{ name: 'baseline' }, { name: 'candidate' }];
      f.evalConfig.trials = 2;
      f.evalConfig.redactStoredResponses = configRedact;
      await fs.writeFile(f.configPath, JSON.stringify(f.evalConfig));
      const runs = [];
      for (let i = 0; i < 2; i++)
        runs.push(
          await runEval({
            configPath: f.configPath,
            rootDir: f.rootDir,
            plugins: [testPlugin],
            redactStoredResponses: apiRedact,
          })
        );
      expect(f.run).toHaveBeenCalledTimes(8);
      for (const result of runs) {
        const id = path.basename(result.outputDir);
        expect(id).toMatch(RUN_ID_PATTERN);
        const stored = path.join(f.storeDir, 'storage-suite', 'runs', id);
        // The same files, byte for byte, report included.
        const files = await filesUnder(result.outputDir);
        expect(files).toEqual(await filesUnder(stored));
        expect(files).toEqual(
          expect.arrayContaining([
            'run.json',
            'results.json',
            'summary.json',
            'report/index.html',
          ])
        );
        expect(files.some((file) => file.startsWith('traces/'))).toBe(true);
        for (const file of files)
          expect(await fs.readFile(path.join(stored, file))).toEqual(
            await fs.readFile(path.join(result.outputDir, file))
          );
        const storedText = await Promise.all(
          files
            .filter((file) => file.endsWith('.json'))
            .map((file) => fs.readFile(path.join(stored, file), 'utf8'))
        );
        for (const marker of [
          'PRIVATE_RESPONSE_MARKER',
          'PRIVATE_TOOL_OUTPUT_MARKER',
        ]) {
          expect(JSON.stringify(result.summary)).toContain(marker);
          expect(storedText.some((text) => text.includes(marker))).toBe(
            !redact
          );
        }
      }
      // The second run is the store's latest, and was compared with the first.
      const [first, second] = runs;
      expect((await readLatest(f.storeDir, 'storage-suite')).runId).toBe(
        path.basename(second!.outputDir)
      );
      expect(second!.summary.previousRun?.runId).toBe(first!.summary.runId);
    }
  );

  it('finds the previous run in the store when the run starts with no local runs', async () => {
    const f = await fixture();
    const first = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      outputDir: path.join(f.rootDir, 'machine-1'),
      plugins: [testPlugin],
    });
    // Another machine: an empty output directory, the same store.
    const second = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      outputDir: path.join(f.rootDir, 'machine-2'),
      plugins: [testPlugin],
    });
    expect(second.summary.previousRun).toMatchObject({
      runId: first.summary.runId,
      sameConfig: true,
    });
  });

  it('keeps the run in the store --results names, instead of the config store', async () => {
    const f = await fixture();
    const elsewhere = path.join(f.rootDir, 'elsewhere');
    const result = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
      results: `file:${elsewhere}`,
    });
    const runId = path.basename(result.outputDir);
    expect(result.storedIn).toBe(elsewhere);
    expect((await readLatest(elsewhere, 'storage-suite')).runId).toBe(runId);
    await expect(fs.stat(f.storeDir)).rejects.toThrow();
  });

  it('takes a plugin store by name in --results, and checks its namespace is loaded', async () => {
    const f = await fixture();
    const target = path.join(f.rootDir, 'plugin-store');
    testPlugin.resultStores['shared'] = {
      schema: z.object({ dir: z.string().default(target) }),
      create: (config) => fileRunStore(String(config.dir)),
    };
    delete f.evalConfig.results;
    await fs.writeFile(f.configPath, JSON.stringify(f.evalConfig));
    const result = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
      results: 'test/result-store/shared',
    });
    expect(result.storedIn).toBe(target);
    await expect(
      runEval({
        configPath: f.configPath,
        rootDir: f.rootDir,
        plugins: [testPlugin],
        results: 'other/result-store/shared',
      })
    ).rejects.toThrow(/other/);
    await expect(
      runEval({
        configPath: f.configPath,
        rootDir: f.rootDir,
        plugins: [testPlugin],
        results: './not-a-store',
      })
    ).rejects.toThrow(/isn't a result store/);
  });

  it('keeps a partial run in the store without making it the latest', async () => {
    const f = await fixture();
    const full = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
    });
    const partial = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
      trials: 1,
    });
    expect(partial.summary.partial).toBe(true);
    expect(
      (await fs.readdir(path.join(f.storeDir, 'storage-suite', 'runs'))).sort()
    ).toEqual(
      [full, partial].map((result) => path.basename(result.outputDir)).sort()
    );
    expect((await readLatest(f.storeDir, 'storage-suite')).runId).toBe(
      path.basename(full.outputDir)
    );
  });

  it('fails a run the store rejects, leaving the run on disk and the store latest as it was', async () => {
    const f = await fixture();
    const inner = fileRunStore(f.storeDir);
    let puts: number | undefined;
    const flaky: RunStore = {
      ...inner,
      async put(key, body) {
        // Once armed, fail partway through the upload.
        if (puts !== undefined && ++puts > 2)
          throw new Error('bucket unavailable');
        await inner.put(key, body);
      },
    };
    testPlugin.resultStores['flaky'] = {
      schema: z.object({}),
      create: () => flaky,
    };
    const kept = await runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
    });
    puts = 0;
    const failed = runEval({
      configPath: f.configPath,
      rootDir: f.rootDir,
      plugins: [testPlugin],
      results: 'test/result-store/flaky',
    });
    await expect(failed).rejects.toThrow(
      /wasn't saved to the result store .*bucket unavailable.*The run is in /
    );
    expect((await readLatest(f.storeDir, 'storage-suite')).runId).toBe(
      path.basename(kept.outputDir)
    );
    const local = await fs.readdir(
      path.join(f.rootDir, '.mcp-test-results', 'storage-suite', 'runs')
    );
    expect(local).toHaveLength(2);
  });

  it('rejects a store that returns an artifact store, with what to change', async () => {
    const f = await fixture();
    testPlugin.resultStores['old'] = {
      schema: z.object({}),
      create: () =>
        new FileEvalResultStore({
          provider: 'file',
          dir: f.storeDir,
        }) as unknown as RunStore,
    };
    await expect(
      runEval({
        configPath: f.configPath,
        rootDir: f.rootDir,
        plugins: [testPlugin],
        results: 'test/result-store/old',
        dryRun: true,
      })
    ).rejects.toThrow(
      /returns an artifact store .*RunStore \(put, get, list\)/
    );
    expect(f.run).not.toHaveBeenCalled();
  });
});
