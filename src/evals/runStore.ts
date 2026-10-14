import fs from 'node:fs/promises';
import path from 'node:path';
import { loadGCSStorage } from './gcsStorage.js';
import { latestRecord, RUN_ID_PATTERN } from './runFormat.js';
import type { RunHistory } from './runBaseline.js';
import type { EvalCaseResult } from '../types/reporter.js';

/**
 * Where an eval config's runs are kept besides the local run directory: a
 * result store. It holds bytes under `/`-separated keys; MST owns the layout,
 * the same `mst.run/v1` layout as a local results directory:
 *
 * ```text
 * <eval name>/latest.json
 * <eval name>/runs/<run-id>/…   (run.json, traces/, scores/, results.json, summary.json, report/)
 * ```
 *
 * A plugin's result store (`resultStores` in a plugin) returns one of these
 * from `create`.
 */
export interface RunStore {
  /** Where the store is, for messages: a directory or `gs://bucket/prefix`. */
  readonly location: string;
  /** Write `body` at `key`, replacing what's there. */
  put(key: string, body: Uint8Array | string): Promise<void>;
  /** The bytes at `key`, or null when there are none. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Every key under `prefix` (which ends in `/`), as full keys. With
   * `shallow`, only the next level: keys, and the "directories" below
   * `prefix` as keys ending in `/`.
   */
  list(prefix: string, options?: { shallow?: boolean }): Promise<string[]>;
}

/** Whether `value` is a RunStore. */
export function isRunStore(value: unknown): value is RunStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RunStore).put === 'function' &&
    typeof (value as RunStore).get === 'function' &&
    typeof (value as RunStore).list === 'function'
  );
}

/** A key, checked: relative, `/`-separated, with no `.` or `..` segments. */
function checkedKey(key: string): string {
  if (
    key.startsWith('/') ||
    key.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(`Invalid result store key "${key}"`);
  return key;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 404)
  );
}

/** A result store in a local directory (`--results file:<dir>`). */
export function fileRunStore(dir: string): RunStore {
  const root = path.resolve(dir);
  const at = (key: string) => path.join(root, ...checkedKey(key).split('/'));
  return {
    location: root,
    async put(key, body) {
      const file = at(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    },
    async get(key) {
      try {
        return await fs.readFile(at(key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async list(prefix, options = {}) {
      const dir = at(prefix);
      try {
        if (options.shallow)
          return (await fs.readdir(dir, { withFileTypes: true })).map(
            (entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`
          );
        return (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map(
            (entry) =>
              prefix +
              path
                .relative(dir, path.join(entry.parentPath, entry.name))
                .split(path.sep)
                .join('/')
          );
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

/** The part of a GCS bucket's API the store uses. */
interface GCSRunBucket {
  file(name: string): {
    save(
      data: Uint8Array | string,
      options?: { resumable?: boolean; validation?: false }
    ): Promise<unknown>;
    download(): Promise<[Buffer]>;
  };
  getFiles(options: {
    prefix: string;
    delimiter?: string;
    autoPaginate?: boolean;
    pageToken?: string;
  }): Promise<
    [
      Array<{ name: string }>,
      { pageToken?: string } | null | undefined,
      { prefixes?: string[] } | undefined,
    ]
  >;
}

/** A result store in a GCS bucket (`--results gs://<bucket>/<prefix>`). */
export function gcsRunStore(options: {
  bucket: string;
  prefix?: string;
}): RunStore {
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const base = prefix ? `${prefix}/` : '';
  let bucket: GCSRunBucket | undefined;
  const open = async () =>
    (bucket ??= (await loadGCSStorage<GCSRunBucket>()).bucket(options.bucket));
  const strip = (name: string) => name.slice(base.length);
  return {
    location: `gs://${options.bucket}${prefix ? `/${prefix}` : ''}`,
    async put(key, body) {
      await (await open())
        .file(base + checkedKey(key))
        .save(body, { resumable: false, validation: false });
    },
    async get(key) {
      try {
        const [bytes] = await (await open())
          .file(base + checkedKey(key))
          .download();
        return bytes;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async list(listPrefix, listOptions = {}) {
      const gcs = await open();
      const full = base + checkedKey(listPrefix);
      if (!listOptions.shallow) {
        const [files] = await gcs.getFiles({ prefix: full });
        return files.map((file) => strip(file.name));
      }
      // One level: GCS returns the "directories" as prefixes, page by page.
      const keys: string[] = [];
      let pageToken: string | undefined;
      do {
        const [files, next, response] = await gcs.getFiles({
          prefix: full,
          delimiter: '/',
          autoPaginate: false,
          ...(pageToken ? { pageToken } : {}),
        });
        keys.push(
          ...files.map((file) => strip(file.name)),
          ...(response?.prefixes ?? []).map(strip)
        );
        pageToken = next?.pageToken;
      } while (pageToken);
      return keys;
    },
  };
}

/** The key of an eval's directory in a store: its name, as locally. */
function evalKey(evalName: string): string {
  return `${checkedKey(evalName)}/`;
}

/** Run `work` on every item, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    })
  );
}

/**
 * Copy a run directory to a store, under `<eval name>/runs/<run-id>/`. With
 * `latest`, point the store's `latest.json` at it once every file is there,
 * so a failed upload leaves the store's latest run as it was.
 */
export async function uploadRun(
  store: RunStore,
  options: {
    evalName: string;
    runId: string;
    runDirectory: string;
    latest?: { createdAt: string };
  }
): Promise<void> {
  const root = `${evalKey(options.evalName)}runs/${options.runId}/`;
  const files = (
    await fs.readdir(options.runDirectory, {
      recursive: true,
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  await eachLimited(files, 16, async (file) => {
    const key =
      root +
      path.relative(options.runDirectory, file).split(path.sep).join('/');
    await store.put(key, await fs.readFile(file));
  });
  if (options.latest)
    await store.put(
      `${evalKey(options.evalName)}latest.json`,
      `${JSON.stringify(latestRecord(options.runId, options.latest.createdAt), null, 2)}\n`
    );
}

async function getJson(store: RunStore, key: string): Promise<unknown> {
  const bytes = await store.get(key);
  return bytes === null
    ? undefined
    : JSON.parse(Buffer.from(bytes).toString('utf8'));
}

/** An eval's runs in a store, for finding the previous run. */
export function storeRunHistory(store: RunStore, evalName: string): RunHistory {
  const runs = `${evalKey(evalName)}runs/`;
  return {
    async runIds() {
      return (await store.list(runs, { shallow: true }))
        .filter((key) => key.endsWith('/'))
        .map((key) => key.slice(runs.length, -1))
        .filter((id) => RUN_ID_PATTERN.test(id));
    },
    summary: (runId) => getJson(store, `${runs}${runId}/summary.json`),
    async cases(runId) {
      const results = (await getJson(store, `${runs}${runId}/results.json`)) as
        | { cases?: EvalCaseResult[] }
        | undefined;
      return results?.cases ?? [];
    },
  };
}
