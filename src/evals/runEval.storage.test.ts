import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FileEvalResultStore,
  compareEvalRuns,
  loadStoredEvalRunnerResult,
  runEvalBatch,
  runEval,
  type EvalConfig,
  type EvaluationSummary,
  type ClientDefinition,
  type ResultStoreDefinition,
} from '../entries/evals.js';
import type { Plugin } from '../index.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

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
    client: `test/${clientName}`,
    datasets: [{ type: 'file', path: './dataset.json' }],
    results: { store: { type: 'file', dir: storeDir } },
  };
  await fs.writeFile(configPath, JSON.stringify(evalConfig));
  return { rootDir, configPath, evalConfig, storeDir, run };
}

describe('eval storage through public APIs', () => {
  it.each(['explicit', 'default'])(
    'saves and resumes with a once-transformed %s store directory',
    async (directory) => {
      const f = await fixture();
      const typeName = `transformed-store-${sequence++}`;
      const aliasName = `decoy-store-${sequence++}`;
      const type = `test/${typeName}`;
      const alias = `test/${aliasName}`;
      testPlugin.resultStores[typeName] = {
        schema: z.object({
          dir: z
            .string()
            .default(f.storeDir)
            .transform((dir) => path.join(dir, 'resolved')),
        }),
        create(config) {
          return new FileEvalResultStore({
            provider: 'file',
            dir: String(config.dir),
          });
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

      const store = new FileEvalResultStore({
        provider: 'file',
        dir: path.join(f.storeDir, 'resolved'),
      });
      const saved = await store.loadArtifact<EvaluationSummary>(
        'eval-run-summary',
        path.basename(first.outputDir)
      );
      expect(saved.data.configId).toBe(first.summary.configId);
      expect(saved.data.contentHash).toBe(first.summary.contentHash);
      expect(await store.listArtifacts('eval-run-summary')).toHaveLength(1);

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
      expect(await store.listArtifacts('eval-run-summary')).toHaveLength(2);
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
    'roundtrips persisted per-variant pointers with $label',
    async ({ configRedact, apiRedact, redact }) => {
      const f = await fixture();
      f.evalConfig.variants = [{ name: 'baseline' }, { name: 'candidate' }];
      f.evalConfig.trials = 2;
      f.evalConfig.redactStoredResponses = configRedact;
      await fs.writeFile(f.configPath, JSON.stringify(f.evalConfig));
      // Exercise unique per-ID artifacts; shared latest.json atomicity is out of scope.
      const runs = await Promise.all(
        Array.from({ length: 2 }, () =>
          runEval({
            configPath: f.configPath,
            rootDir: f.rootDir,
            plugins: [testPlugin],
            redactStoredResponses: apiRedact,
          })
        )
      );
      expect(f.run).toHaveBeenCalledTimes(8);
      expect(new Set(runs.map((run) => run.outputDir)).size).toBe(2);
      const store = new FileEvalResultStore({
        provider: 'file',
        dir: f.storeDir,
      });
      const allPointers: string[] = [];
      for (const result of runs) {
        const id = path.basename(result.outputDir);
        expect(z.uuidv4().safeParse(id).success).toBe(true);
        const localText = await fs.readFile(
          path.join(result.outputDir, 'results.json'),
          'utf8'
        );
        const local = JSON.parse(localText) as EvaluationSummary;
        const saved = await store.loadArtifact<EvaluationSummary>(
          'eval-run-summary',
          id
        );
        expect(local.caseArtifactPointers).toEqual(
          result.summary.caseArtifactPointers
        );
        expect(saved.data.caseArtifactPointers).toEqual(
          result.summary.caseArtifactPointers
        );
        expect(Object.keys(local.caseArtifactPointers!)).toEqual([
          'baseline',
          'candidate',
        ]);
        expect(saved.data).toEqual(local);
        expect(saved.metadata.labels).toMatchObject({
          configId: result.summary.configId,
          contentHash: result.summary.contentHash,
        });
        const artifacts = [];
        for (const variant of local.variants) {
          const pointers = local.caseArtifactPointers![variant.name]!;
          expect(pointers).toHaveLength(1);
          allPointers.push(...pointers);
          const artifact = await loadStoredEvalRunnerResult(store, {
            id: pointers[0]!,
          });
          expect(artifact.kind).toBe('eval-runner-result');
          expect(artifact.id).toBe(pointers[0]);
          expect(artifact.metadata.labels).toMatchObject({
            variant: variant.name,
            configId: local.configId,
            contentHash: local.contentHash,
          });
          expect(artifact.data).toEqual(variant.result);
          expect(artifact.data.caseResults).toHaveLength(1);
          expect(artifact.data.caseResults[0]?.trialResults).toHaveLength(2);
          artifacts.push(artifact.data);
        }
        expect(
          compareEvalRuns({ baseline: artifacts[0]!, candidate: artifacts[1]! })
        ).toMatchObject({
          baselinePassRate: 1,
          candidatePassRate: 0,
          deltaPassRate: -1,
        });
        for (const marker of [
          'PRIVATE_RESPONSE_MARKER',
          'PRIVATE_TOOL_OUTPUT_MARKER',
        ]) {
          expect(JSON.stringify(result.summary)).toContain(marker);
          for (const persisted of [
            localText,
            JSON.stringify(saved),
            ...artifacts.map((data) => JSON.stringify(data)),
          ]) {
            expect(persisted.includes(marker)).toBe(!redact);
          }
        }
      }
      expect(allPointers).toHaveLength(4);
      expect(new Set(allPointers).size).toBe(4);
      expect(await store.listArtifacts('eval-runner-result')).toHaveLength(4);
      expect(await store.listArtifacts('eval-run-summary')).toHaveLength(2);
      const resumed = await runEvalBatch({
        configPaths: [f.configPath],
        rootDir: f.rootDir,
        skipExisting: true,
        plugins: [testPlugin],
      });
      expect(resumed).toMatchObject({ skipped: 1, failed: 0, passed: 0 });
      expect(f.run).toHaveBeenCalledTimes(8);
    }
  );
});
