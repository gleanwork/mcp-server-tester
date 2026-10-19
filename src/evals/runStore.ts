import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
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

/**
 * Like eachLimited, but on the first failure it starts no more items and
 * waits for those under way before it throws: nothing writes after it fails.
 */
async function eachSettled<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failure && next < items.length)
        try {
          await work(items[next++]!);
        } catch (error) {
          failure ??= { error };
        }
    })
  );
  if (failure) throw failure.error;
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
 * The file a stored run's upload writes last: each file's size and SHA-256.
 * A run without it is still uploading, or its upload failed, and is never
 * fetched; one whose files don't match it is refused.
 */
const RUN_MANIFEST = 'manifest.json';

interface RunManifest {
  readonly format: 1;
  readonly runId: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Copy a run directory to a store, under `<eval name>/runs/<run-id>/`, with
 * its manifest last. With `latest`, point the store's `latest.json` at it
 * once every file is there, so a failed upload leaves the store's latest run
 * as it was.
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
    // Not a fetched run's manifest, nor an atomic write's temporary.
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.endsWith('.tmp') &&
        !(
          entry.name === RUN_MANIFEST &&
          entry.parentPath === options.runDirectory
        )
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
  const manifest: Array<RunManifest['files'][number]> = [];
  await eachLimited(files, 16, async (file) => {
    const relative = path
      .relative(options.runDirectory, file)
      .split(path.sep)
      .join('/');
    const body = await fs.readFile(file);
    await store.put(root + relative, body);
    manifest.push({ path: relative, bytes: body.length, sha256: sha256(body) });
  });
  await store.put(
    root + RUN_MANIFEST,
    `${JSON.stringify(
      {
        format: 1,
        runId: options.runId,
        files: manifest.sort((a, b) => a.path.localeCompare(b.path)),
      } satisfies RunManifest,
      null,
      2
    )}\n`
  );
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
    runIds: () => storedRunIds(store, evalName),
    summary: (runId) => getJson(store, `${runs}${runId}/summary.json`),
    async cases(runId) {
      const results = (await getJson(store, `${runs}${runId}/results.json`)) as
        | { cases?: EvalCaseResult[] }
        | undefined;
      return results?.cases ?? [];
    },
  };
}

const RunManifestSchema = z.object({
  format: z.literal(1),
  runId: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
  ),
});

function parseManifest(bytes: Uint8Array): RunManifest | undefined {
  try {
    const parsed = RunManifestSchema.safeParse(
      JSON.parse(Buffer.from(bytes).toString('utf8'))
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The run IDs a store has (with their manifest), for an eval. */
export async function storedRunIds(
  store: RunStore,
  evalName: string
): Promise<string[]> {
  const runs = `${evalKey(evalName)}runs/`;
  return (await store.list(runs, { shallow: true }))
    .filter((key) => key.endsWith('/'))
    .map((key) => key.slice(runs.length, -1))
    .filter((id) => RUN_ID_PATTERN.test(id));
}

/** Whether the store has run `runId` complete: its manifest is there. */
export async function hasStoredRun(
  store: RunStore,
  evalName: string,
  runId: string
): Promise<boolean> {
  return (
    (await store.get(`${evalKey(evalName)}runs/${runId}/${RUN_MANIFEST}`)) !==
    null
  );
}

/**
 * Fetch stored run `runId` into `directory`, which mustn't exist: every file
 * checked against the run's manifest, into a temporary sibling renamed into
 * place, so a local run directory is never half a run. Throws when the store
 * hasn't the run complete. A store's contents are input: a manifest path
 * that would leave the run is refused.
 */
export async function fetchRun(
  store: RunStore,
  options: { evalName: string; runId: string; directory: string }
): Promise<{ files: number; bytes: number }> {
  const { evalName, runId, directory } = options;
  const root = `${evalKey(evalName)}runs/${checkedKey(runId)}/`;
  const what = `Run ${runId} in the result store ${store.location}`;
  const manifestBytes = await store.get(root + RUN_MANIFEST);
  if (!manifestBytes)
    throw new Error(
      `${what} isn't complete: it has no ${RUN_MANIFEST} (it isn't there, its upload didn't finish, or an MST before beta.13 uploaded it).`
    );
  const manifest = parseManifest(manifestBytes);
  if (
    !manifest ||
    manifest.runId !== runId ||
    !manifest.files.some((file) => file.path === 'run.json')
  )
    throw new Error(
      `${what}: its ${RUN_MANIFEST} isn't a manifest of this run.`
    );
  for (const file of manifest.files)
    if (
      file.path === RUN_MANIFEST ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => part === '')
    )
      throw new Error(`${what}: its ${RUN_MANIFEST} lists "${file.path}".`);
    else checkedKey(file.path);
  const staging = `${directory}.${randomBytes(4).toString('hex')}.fetching`;
  try {
    await eachSettled(manifest.files, 16, async (file) => {
      const body = await store.get(root + file.path);
      if (!body) throw new Error(`${what} is missing ${file.path}.`);
      if (body.length !== file.bytes || sha256(body) !== file.sha256)
        throw new Error(`${what}: ${file.path} doesn't match its manifest.`);
      const target = path.join(staging, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    });
    await fs.writeFile(path.join(staging, RUN_MANIFEST), manifestBytes);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.rename(staging, directory);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}
