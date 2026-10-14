import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileRunStore,
  gcsRunStore,
  storeRunHistory,
  uploadRun,
  type RunStore,
} from './runStore.js';
import { parseResultsFlag } from './builtinResultStores.js';

/** Objects in the mocked bucket, by full name. */
const objects = new Map<string, Buffer>();
/** Page size for listings with a delimiter, small enough to page. */
const PAGE = 2;

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(bucketName: string) {
      return {
        file(name: string) {
          const key = `${bucketName}/${name}`;
          return {
            async save(data: Uint8Array | string) {
              objects.set(key, Buffer.from(data));
            },
            async download() {
              const bytes = objects.get(key);
              if (!bytes)
                throw Object.assign(new Error('No such object'), { code: 404 });
              return [bytes];
            },
          };
        },
        async getFiles(options: {
          prefix: string;
          delimiter?: string;
          pageToken?: string;
        }) {
          const names = [...objects.keys()]
            .filter((key) => key.startsWith(`${bucketName}/${options.prefix}`))
            .map((key) => key.slice(bucketName.length + 1))
            .sort();
          if (!options.delimiter)
            return [names.map((name) => ({ name })), null, {}];
          const entries = [
            ...new Set(
              names.map((name) => {
                const rest = name.slice(options.prefix.length);
                const slash = rest.indexOf('/');
                return slash < 0
                  ? name
                  : `${options.prefix}${rest.slice(0, slash + 1)}`;
              })
            ),
          ];
          const start = Number(options.pageToken ?? 0);
          const page = entries.slice(start, start + PAGE);
          const next = start + PAGE < entries.length;
          return [
            page.filter((e) => !e.endsWith('/')).map((name) => ({ name })),
            next ? { pageToken: String(start + PAGE) } : null,
            { prefixes: page.filter((e) => e.endsWith('/')) },
          ];
        },
      };
    }
  },
}));

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  objects.clear();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const stores: Array<[string, () => Promise<RunStore>]> = [
  ['file', async () => fileRunStore(await tempDir())],
  ['gcs', async () => gcsRunStore({ bucket: 'b', prefix: '/evals/' })],
];

describe.each(stores)('the %s run store', (_name, makeStore) => {
  it('puts, gets and lists keys', async () => {
    const store = await makeStore();
    expect(await store.get('a/missing.json')).toBeNull();
    expect(await store.list('a/')).toEqual([]);
    await store.put('a/one.json', '{"one":1}');
    await store.put('a/b/two.json', new Uint8Array([1, 2, 3]));
    await store.put('a/c/d/three.json', 'three');
    await store.put('a/e.json', 'e');
    expect(Buffer.from((await store.get('a/one.json'))!).toString()).toBe(
      '{"one":1}'
    );
    expect([...(await store.get('a/b/two.json'))!]).toEqual([1, 2, 3]);
    expect((await store.list('a/')).sort()).toEqual([
      'a/b/two.json',
      'a/c/d/three.json',
      'a/e.json',
      'a/one.json',
    ]);
    expect((await store.list('a/', { shallow: true })).sort()).toEqual([
      'a/b/',
      'a/c/',
      'a/e.json',
      'a/one.json',
    ]);
  });

  it('rejects keys that leave the store', async () => {
    const store = await makeStore();
    await expect(store.put('../outside.json', 'x')).rejects.toThrow(
      /Invalid result store key/
    );
    await expect(store.get('/absolute.json')).rejects.toThrow(
      /Invalid result store key/
    );
  });

  it('holds an uploaded run, and its history lists it', async () => {
    const store = await makeStore();
    const runDirectory = await tempDir();
    await fs.mkdir(path.join(runDirectory, 'traces', 'v', 'case'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(runDirectory, 'summary.json'),
      '{"runId":"r"}'
    );
    await fs.writeFile(
      path.join(runDirectory, 'results.json'),
      '{"cases":[{"id":"case"}]}'
    );
    await fs.writeFile(
      path.join(runDirectory, 'traces', 'v', 'case', '0.json'),
      '{}'
    );
    const runId = '20261013T000000Z-abc123';
    await uploadRun(store, {
      evalName: 'my-eval',
      runId,
      runDirectory,
      latest: { createdAt: '2026-10-13T00:00:00.000Z' },
    });
    expect((await store.list(`my-eval/runs/${runId}/`)).sort()).toEqual([
      `my-eval/runs/${runId}/results.json`,
      `my-eval/runs/${runId}/summary.json`,
      `my-eval/runs/${runId}/traces/v/case/0.json`,
    ]);
    expect(
      JSON.parse(
        Buffer.from((await store.get('my-eval/latest.json'))!).toString()
      )
    ).toEqual({
      format: 'mst.run/v1',
      kind: 'latest',
      runId,
      createdAt: '2026-10-13T00:00:00.000Z',
      path: `runs/${runId}`,
    });
    // Without `latest`, the store's latest run stays as it was.
    await uploadRun(store, {
      evalName: 'my-eval',
      runId: '20261014T000000Z-def456',
      runDirectory,
    });
    const history = storeRunHistory(store, 'my-eval');
    expect((await history.runIds()).sort()).toEqual([
      runId,
      '20261014T000000Z-def456',
    ]);
    expect(await history.summary(runId)).toEqual({ runId: 'r' });
    expect(await history.cases(runId)).toEqual([{ id: 'case' }]);
    expect(await history.summary('20991231T000000Z-000000')).toBeUndefined();
    expect(
      JSON.parse(
        Buffer.from((await store.get('my-eval/latest.json'))!).toString()
      ).runId
    ).toBe(runId);
  });
});

describe('the gcs run store', () => {
  it('keeps its keys under the prefix and names its location', async () => {
    const store = gcsRunStore({ bucket: 'b', prefix: 'evals' });
    expect(store.location).toBe('gs://b/evals');
    await store.put('x.json', '1');
    expect([...objects.keys()]).toEqual(['b/evals/x.json']);
    expect(gcsRunStore({ bucket: 'b' }).location).toBe('gs://b');
  });
});

describe('parseResultsFlag', () => {
  it('reads gs://, file: and plugin stores', () => {
    expect(parseResultsFlag('gs://bucket/cowork/evals')).toEqual({
      type: 'gcs',
      bucket: 'bucket',
      prefix: 'cowork/evals',
    });
    expect(parseResultsFlag('gs://bucket')).toEqual({
      type: 'gcs',
      bucket: 'bucket',
    });
    expect(parseResultsFlag('file:./shared')).toEqual({
      type: 'file',
      dir: path.resolve('shared'),
    });
    expect(parseResultsFlag('acme/result-store/eval-results')).toEqual({
      type: 'acme/result-store/eval-results',
    });
  });

  it.each(['gs://', 'file:', './shared', 'gcs', 'acme/judge/x'])(
    'rejects %s',
    (value) => {
      expect(() => parseResultsFlag(value)).toThrow(/--results/);
    }
  );
});
