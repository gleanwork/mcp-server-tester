import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatasetSource } from './builtinDatasetSources.js';
import type { EvalConfig } from './evalConfig.js';

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

describe('canonical built-in dataset sources', () => {
  let rootDir: string;
  const evalConfig: EvalConfig = { name: 'source-tests', datasets: [] };
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
        // The eval expands dir into paths; this exercises each entry's loader.
        const source =
          type === 'gcs'
            ? { type, uri: 'gs://datasets/cases.json' }
            : { type, path: 'cases.json' };
        await fs.writeFile(
          path.join(rootDir, 'cases.json'),
          JSON.stringify(raw)
        );
        gcs.download.mockResolvedValue([Buffer.from(JSON.stringify(raw))]);
        return getDatasetSource(type).load(source, { rootDir, evalConfig });
      }
      it('loads a minimal case with no assertions or client', async () => {
        const raw = {
          name: 'canonical',
          cases: [{ id: 'search', input: 'Find it' }],
        };
        expect((await load(raw)).cases).toEqual(raw.cases);
        if (type === 'gcs') {
          expect(gcs.bucket).toHaveBeenCalledWith('datasets');
          expect(gcs.file).toHaveBeenCalledWith('cases.json');
          expect(gcs.download).toHaveBeenCalledTimes(1);
        }
      });
      it('preserves canonical client mode, per-case client, trials and judges', async () => {
        const case_ = {
          id: 'question',
          input: 'Find policy',
          client: 'custom-host',
          clientOptions: { option: true },
          trials: 3,
          judges: [{ type: 'custom-quality', threshold: 0.8 }],
        };
        expect(
          (await load({ name: 'canonical', cases: [case_] })).cases[0]
        ).toEqual(case_);
      });
      it.each([
        { id: 'selection', input: 'Find policy', expected_tool: 'search' },
        { id: 'call', tool: 'search', assertions: { isError: false } },
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
