import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import {
  FileEvalResultStore,
  GCSEvalResultStore,
  createStoredEvalArtifact,
  type EvalResultStore,
} from './resultStore.js';

describe('FileEvalResultStore', () => {
  let tmpDir: string;
  let store: EvalResultStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-result-store-'));
    store = new FileEvalResultStore({ provider: 'file', dir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads an artifact by kind and id', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      createdAt: '2026-05-22T12:00:00.000Z',
      metadata: { datasetName: 'dataset-a' },
      data: { passed: 1 },
    });

    await store.saveArtifact(artifact);
    const loaded = await store.loadArtifact<{ passed: number }>(
      'eval-runner-result',
      'run-1'
    );

    expect(loaded).toEqual(artifact);
  });

  it('loads the latest artifact for a kind', async () => {
    const first = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      createdAt: '2026-05-22T12:00:00.000Z',
      data: { passed: 1 },
    });
    const second = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-2',
      createdAt: '2026-05-22T12:01:00.000Z',
      data: { passed: 2 },
    });

    await store.saveArtifact(first);
    await store.saveArtifact(second);

    const latest = await store.loadLatestArtifact<{ passed: number }>(
      'eval-runner-result'
    );
    expect(latest?.id).toBe('run-2');
    expect(latest?.data.passed).toBe(2);
  });

  it('returns null for a missing latest artifact', async () => {
    await expect(
      store.loadLatestArtifact('eval-runner-result')
    ).resolves.toBeNull();
  });

  it('lists artifacts sorted newest first with a limit', async () => {
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'old',
        createdAt: '2026-05-22T12:00:00.000Z',
        data: {},
      })
    );
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'new',
        createdAt: '2026-05-22T12:01:00.000Z',
        data: {},
      })
    );

    const summaries = await store.listArtifacts('eval-runner-result', {
      limit: 1,
    });

    expect(summaries.map((s) => s.id)).toEqual(['new']);
  });

  it('round-trips comparison artifacts', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'server-comparison',
      id: 'comparison-1',
      data: { aWins: 1, bWins: 0 },
    });

    await store.saveArtifact(artifact);

    const loaded = await store.loadArtifact<{ aWins: number; bWins: number }>(
      'server-comparison',
      'comparison-1'
    );
    expect(loaded.data).toEqual({ aWins: 1, bWins: 0 });
  });
});

describe('GCSEvalResultStore', () => {
  const originalEmulatorHost = process.env.STORAGE_EMULATOR_HOST;

  beforeEach(() => {
    process.env.STORAGE_EMULATOR_HOST = 'http://storage.test';
    nock.disableNetConnect();
  });

  afterEach(() => {
    if (originalEmulatorHost === undefined) {
      delete process.env.STORAGE_EMULATOR_HOST;
    } else {
      process.env.STORAGE_EMULATOR_HOST = originalEmulatorHost;
    }
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('saves immutable and latest artifacts through the official SDK', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      data: { total: 1 },
    });

    const uploadScope = nock('http://storage.test')
      .post('/upload/storage/v1/b/bucket/o')
      .query({
        uploadType: 'multipart',
        name: 'prefix/eval-runs/run-1.json',
      })
      .reply(200, { name: 'prefix/eval-runs/run-1.json' })
      .post('/upload/storage/v1/b/bucket/o')
      .query({
        uploadType: 'multipart',
        name: 'prefix/eval-runs/latest.json',
      })
      .reply(200, { name: 'prefix/eval-runs/latest.json' });

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    await store.saveArtifact(artifact);

    expect(uploadScope.isDone()).toBe(true);
  });

  it('loads latest artifacts through the official SDK', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      data: { total: 1 },
    });
    const objectPath = '/b/bucket/o/prefix%2Feval-runs%2Flatest.json';

    nock('http://storage.test')
      .get(objectPath)
      .query(true)
      .reply(200, { name: 'prefix/eval-runs/latest.json' })
      .get(objectPath)
      .query({ alt: 'media' })
      .reply(200, artifact);

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const loaded = await store.loadLatestArtifact<{ total: number }>(
      'eval-runner-result'
    );

    expect(loaded?.id).toBe('run-1');
    expect(loaded?.data.total).toBe(1);
  });

  it('loads an immutable artifact by id', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-2',
      data: { total: 2 },
    });
    // GCSEvalResultStore.loadArtifact builds the object path via
    // `${kind-prefix}/eval-runs/${encodeURIComponent(id)}.json`. The GCS SDK
    // URL-encodes the resulting path once when constructing the request, so
    // the test endpoint sees the path-separator slashes mapped to %2F.
    const objectPath = '/b/bucket/o/prefix%2Feval-runs%2Frun-2.json';

    nock('http://storage.test')
      .get(objectPath)
      .query({ alt: 'media' })
      .reply(200, artifact);

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const loaded = await store.loadArtifact<{ total: number }>(
      'eval-runner-result',
      'run-2'
    );

    expect(loaded.id).toBe('run-2');
    expect(loaded.data.total).toBe(2);
  });

  it('lists artifacts by kind, filters out latest.json, sorts newest-first, and respects limit', async () => {
    const olderArtifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'older',
      data: { total: 1 },
      createdAt: '2026-05-20T00:00:00.000Z',
    });
    const newerArtifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'newer',
      data: { total: 2 },
      createdAt: '2026-05-21T00:00:00.000Z',
    });

    // Use a content-based matcher so the test is robust to changes in the
    // exact URL shape (the GCS SDK with STORAGE_EMULATOR_HOST builds slightly
    // different URLs depending on the operation; matching on URL substring
    // covers list, download, and any internal redirects without enumerating
    // every path the SDK might use).
    nock('http://storage.test')
      .persist()
      .get(/.*/)
      .query(true)
      .reply(function (uri) {
        if (uri.includes('older.json')) return [200, olderArtifact];
        if (uri.includes('newer.json')) return [200, newerArtifact];
        if (uri.includes('?prefix=') || uri.includes('&prefix=')) {
          return [
            200,
            {
              items: [
                { name: 'prefix/eval-runs/older.json' },
                { name: 'prefix/eval-runs/newer.json' },
                // latest.json must be excluded from the listing because it
                // duplicates the most recent immutable artifact.
                { name: 'prefix/eval-runs/latest.json' },
                // Non-JSON files (e.g. partial uploads) must be excluded too.
                { name: 'prefix/eval-runs/stray.txt' },
              ],
            },
          ];
        }
        return [404, {}];
      });

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const summaries = await store.listArtifacts('eval-runner-result', {
      limit: 5,
    });

    expect(summaries.map((s) => s.id)).toEqual(['newer', 'older']);
  });
});
