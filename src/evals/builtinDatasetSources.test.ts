import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinDatasetSources } from './builtinDatasetSources.js';
import { getDatasetSource } from './frameworkRegistries.js';
import type { EvalManifest } from './evalManifest.js';

const gcs = vi.hoisted(() => ({
  download: vi.fn(),
  bucket: vi.fn(),
  file: vi.fn(),
}));
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      gcs.bucket(name);
      return {
        file(name: string) {
          gcs.file(name);
          return { download: gcs.download };
        },
      };
    }
  },
}));
registerBuiltinDatasetSources();

describe('canonical built-in dataset sources', () => {
  let rootDir: string;
  const manifest: EvalManifest = { name: 'source-tests', datasets: [] };
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataset-source-'));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  for (const type of ['file', 'dir', 'gcs'] as const) {
    describe(type, () => {
      async function load(raw: unknown) {
        // The suite expands dir into paths; this exercises each entry's loader.
        const source =
          type === 'gcs'
            ? { type, uri: 'gs://datasets/cases.json' }
            : { type, path: 'cases.json' };
        await fs.writeFile(
          path.join(rootDir, 'cases.json'),
          JSON.stringify(raw)
        );
        gcs.download.mockResolvedValue([Buffer.from(JSON.stringify(raw))]);
        return getDatasetSource(type).load(source, { rootDir, manifest });
      }
      it('loads minimal direct JSON with no mode, expect, args, or host', async () => {
        const raw = {
          name: 'canonical',
          cases: [{ id: 'search', toolName: 'search' }],
        };
        expect((await load(raw)).cases).toEqual(raw.cases);
        if (type === 'gcs') {
          expect(gcs.bucket).toHaveBeenCalledWith('datasets');
          expect(gcs.file).toHaveBeenCalledWith('cases.json');
          expect(gcs.download).toHaveBeenCalledTimes(1);
        }
      });
      it('preserves canonical host mode, per-case host, iterations and judges', async () => {
        const case_ = {
          id: 'question',
          mode: 'host',
          scenario: 'Find policy',
          host: { type: 'custom-host', option: true },
          iterations: 3,
          expect: { passesJudge: { judge: 'custom-quality', threshold: 0.8 } },
        };
        expect(
          (await load({ name: 'canonical', cases: [case_] })).cases[0]
        ).toEqual(case_);
      });
      it.each([
        { id: 'question', scenario: 'What is our policy?' },
        { id: 'selection', scenario: 'Find policy', expected_tool: 'search' },
        { id: 'call', tool: 'search', expect: { isError: false } },
      ])(
        'rejects legacy cases rather than inferring a shape',
        async (case_) => {
          await expect(
            load({ name: 'legacy', cases: [case_] })
          ).rejects.toThrow(
            /canonical EvalDataset.*explicit dataset source adapter/
          );
        }
      );
    });
  }
});
