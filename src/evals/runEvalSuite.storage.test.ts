import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FileEvalResultStore,
  compareEvalRuns,
  loadStoredEvalRunnerResult,
  registerHost,
  registerResultStore,
  runEvalBatch,
  runEvalSuite,
  type EvalManifest,
  type EvaluationSummary,
  type HostDefinition,
} from '../index.js';

const dirs: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function fixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-storage-'));
  dirs.push(rootDir);
  const hostName = `storage-host-${sequence++}`;
  const run = vi.fn<NonNullable<HostDefinition['run']>>(
    async (_input, _config, context) => ({
      finalText: 'PRIVATE_RESPONSE_MARKER',
      events: Array.from(
        { length: context.arm?.name === 'candidate' ? 2 : 1 },
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
  registerHost({
    name: hostName,
    schema: z.object({}),
    evidence: 'structured',
    run,
  });
  await fs.writeFile(
    path.join(rootDir, 'dataset.json'),
    JSON.stringify({
      name: 'canonical-storage-dataset',
      cases: [
        {
          id: 'search-case',
          mode: 'host',
          scenario: 'Find documents',
          expect: { toolCallCount: { min: 1, max: 1 } },
        },
      ],
    })
  );
  const storeDir = path.join(rootDir, 'store');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest: EvalManifest = {
    name: 'storage-suite',
    host: { type: hostName },
    datasets: [{ type: 'file', path: './dataset.json' }],
    results: { store: { type: 'file', dir: storeDir } },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { rootDir, manifestPath, manifest, storeDir, run };
}

describe('suite storage through public APIs', () => {
  it.each(['explicit', 'default'])(
    'saves and resumes with a once-transformed %s store directory',
    async (directory) => {
      const f = await fixture();
      const type = `transformed-store-${sequence++}`;
      const alias = `decoy-store-${sequence++}`;
      registerResultStore({
        name: type,
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
      });
      registerResultStore({
        name: alias,
        schema: z.object({}),
        create() {
          throw new Error('Plugin-owned name must not route to another store');
        },
      });
      f.manifest.results = {
        store: {
          type,
          name: alias,
          ...(directory === 'explicit' ? { dir: f.storeDir } : {}),
        },
      };
      await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));

      const first = await runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.rootDir,
      });
      expect(first.summary.metrics).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
      });
      expect(f.run).toHaveBeenCalledTimes(1);
      const resumed = await runEvalBatch({
        manifestPaths: [f.manifestPath],
        rootDir: f.rootDir,
        skipExisting: true,
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
      expect(saved.data.manifestId).toBe(first.summary.manifestId);
      expect(saved.data.contentHash).toBe(first.summary.contentHash);
      expect(await store.listArtifacts('eval-run-summary')).toHaveLength(1);

      f.manifest.name = 'changed-storage-suite';
      await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
      const changed = await runEvalBatch({
        manifestPaths: [f.manifestPath],
        rootDir: f.rootDir,
        skipExisting: true,
      });
      expect(changed).toMatchObject({ skipped: 0, passed: 1, failed: 0 });
      expect(f.run).toHaveBeenCalledTimes(2);
      expect(await store.listArtifacts('eval-run-summary')).toHaveLength(2);
    }
  );

  it.each([
    {
      label: 'default redaction',
      manifestRedact: undefined,
      apiRedact: undefined,
      redact: true,
    },
    {
      label: 'manifest opt-out',
      manifestRedact: false,
      apiRedact: undefined,
      redact: false,
    },
    {
      label: 'API opt-out',
      manifestRedact: true,
      apiRedact: false,
      redact: false,
    },
    {
      label: 'API enforcement',
      manifestRedact: false,
      apiRedact: true,
      redact: true,
    },
  ])(
    'roundtrips persisted per-arm pointers with $label',
    async ({ manifestRedact, apiRedact, redact }) => {
      const f = await fixture();
      f.manifest.arms = [{ name: 'baseline' }, { name: 'candidate' }];
      f.manifest.iterations = 2;
      f.manifest.redactStoredResponses = manifestRedact;
      await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
      // Exercise unique per-ID artifacts; shared latest.json atomicity is out of scope.
      const runs = await Promise.all(
        Array.from({ length: 2 }, () =>
          runEvalSuite({
            manifestPath: f.manifestPath,
            rootDir: f.rootDir,
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
          manifestId: result.summary.manifestId,
          contentHash: result.summary.contentHash,
        });
        const artifacts = [];
        for (const arm of local.arms) {
          const pointers = local.caseArtifactPointers![arm.name]!;
          expect(pointers).toHaveLength(1);
          allPointers.push(...pointers);
          const artifact = await loadStoredEvalRunnerResult(store, {
            id: pointers[0]!,
          });
          expect(artifact.kind).toBe('eval-runner-result');
          expect(artifact.id).toBe(pointers[0]);
          expect(artifact.metadata.labels).toMatchObject({
            arm: arm.name,
            manifestId: local.manifestId,
            contentHash: local.contentHash,
          });
          expect(artifact.data).toEqual(arm.result);
          expect(artifact.data.caseResults).toHaveLength(1);
          expect(artifact.data.caseResults[0]?.iterationResults).toHaveLength(
            2
          );
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
        manifestPaths: [f.manifestPath],
        rootDir: f.rootDir,
        skipExisting: true,
      });
      expect(resumed).toMatchObject({ skipped: 1, failed: 0, passed: 0 });
      expect(f.run).toHaveBeenCalledTimes(8);
    }
  );
});
