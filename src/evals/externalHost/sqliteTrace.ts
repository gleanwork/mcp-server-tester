import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';

const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 4096;
const MAX_PARAMETERS = 128;
const MAX_SQL_BYTES = 64 * 1024;
const SNAPSHOT_ATTEMPTS = 3;
const COPY_BUFFER_BYTES = 1024 * 1024;

export type SqliteTraceValue = string | number | bigint | Uint8Array | null;
export type SqliteSidecars = 'required' | 'optional' | 'none';

export interface SqliteTraceDatabaseSource {
  /** Stable adapter-local name, not a filesystem path. */
  name: string;
  /** Path relative to root. Absolute paths and traversal are rejected. */
  relativePath: string;
  /** WAL and SHM policy. Trace sources default to fail-closed required sidecars. */
  sidecars?: SqliteSidecars;
  maxFileBytes?: number;
}

export interface SqliteTraceSnapshotOptions {
  root: string;
  databases: SqliteTraceDatabaseSource[];
  maxTotalBytes?: number;
  maxRows?: number;
}

export interface ReadonlySqliteTraceDatabase {
  rows<T>(
    sql: string,
    parameters?: readonly SqliteTraceValue[],
    options?: { maxRows?: number }
  ): T[];
}

export interface ReadonlySqliteTraceSnapshot {
  database(name: string): ReadonlySqliteTraceDatabase;
}

interface SourceFile {
  database: string;
  sourcePath: string;
  snapshotName: string;
  kind: 'database' | 'wal' | 'shm';
  maxBytes: number;
}

interface OpenSourceFile extends SourceFile {
  handle: FileHandle;
  before: BigIntStats;
}

interface BigIntStats {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
}

/**
 * Inspect a stable private copy of an explicit SQLite database family. The
 * callback receives only bounded SELECT/WITH queries; source paths, handles,
 * writable connections, and snapshot files stay inside this module.
 */
export async function inspectReadonlySqliteTrace<T>(
  options: SqliteTraceSnapshotOptions,
  inspect: (snapshot: ReadonlySqliteTraceSnapshot) => T | Promise<T>
): Promise<T> {
  const config = await validateOptions(options);
  let lastFailure: unknown;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    const snapshotRoot = await mkdtemp(join(tmpdir(), 'mcp-sqlite-trace-'));
    await chmod(snapshotRoot, 0o700);
    try {
      const copied = await copyStableFamily(config, snapshotRoot);
      return await inspectCopiedDatabases(config, copied, inspect);
    } catch (error) {
      lastFailure = error;
      if (!(error instanceof UnstableSqliteFamilyError)) throw error;
      if (attempt + 1 < SNAPSHOT_ATTEMPTS) await delay(10);
    } finally {
      await chmod(snapshotRoot, 0o700).catch(() => {});
      await rm(snapshotRoot, { recursive: true, force: true });
    }
  }
  throw new Error(
    lastFailure instanceof UnstableSqliteFamilyError
      ? 'SQLite trace source changed during every bounded snapshot attempt.'
      : 'SQLite trace snapshot failed.'
  );
}

async function validateOptions(options: SqliteTraceSnapshotOptions): Promise<{
  root: string;
  databases: Array<
    SqliteTraceDatabaseSource & {
      sidecars: SqliteSidecars;
      maxFileBytes: number;
    }
  >;
  maxTotalBytes: number;
  maxRows: number;
}> {
  if (!isAbsolute(options.root)) {
    throw new TypeError('SQLite trace root must be an absolute path.');
  }
  const root = await realpath(options.root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.()) {
    throw new Error('SQLite trace root is not an owned directory.');
  }
  if (options.databases.length === 0) {
    throw new TypeError('SQLite trace requires at least one database.');
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const databases = options.databases.map((source) => {
    if (!/^[a-z][a-z0-9_-]*$/i.test(source.name) || names.has(source.name)) {
      throw new TypeError('SQLite trace database names must be unique tokens.');
    }
    names.add(source.name);
    const relativePath = validateRelativePath(source.relativePath);
    if (paths.has(relativePath)) {
      throw new TypeError('SQLite trace database paths must be unique.');
    }
    paths.add(relativePath);
    return {
      ...source,
      relativePath,
      sidecars: source.sidecars ?? 'required',
      maxFileBytes: positiveBound(
        source.maxFileBytes,
        DEFAULT_MAX_FILE_BYTES,
        'SQLite trace file bound'
      ),
    };
  });
  return {
    root,
    databases,
    maxTotalBytes: positiveBound(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      'SQLite trace total bound'
    ),
    maxRows: positiveBound(
      options.maxRows,
      DEFAULT_MAX_ROWS,
      'SQLite trace row bound'
    ),
  };
}

function validateRelativePath(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    normalize(value) !== value ||
    value === '..' ||
    value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new TypeError(
      'SQLite trace database paths must be normalized and relative.'
    );
  }
  return value;
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

async function copyStableFamily(
  config: Awaited<ReturnType<typeof validateOptions>>,
  snapshotRoot: string
): Promise<Map<string, string>> {
  const sources = await sourceFiles(config);
  const opened: OpenSourceFile[] = [];
  try {
    let totalBytes = 0;
    for (const source of sources) {
      const handle = await open(
        source.sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      const before = (await handle.stat({ bigint: true })) as BigIntStats;
      validateSourceStat(before, source.maxBytes);
      await assertCanonicalChild(config.root, source.sourcePath);
      totalBytes += Number(before.size);
      if (totalBytes > config.maxTotalBytes) {
        throw new Error(
          'SQLite trace database family exceeds its total bound.'
        );
      }
      opened.push({ ...source, handle, before });
    }

    const databasePaths = new Map<string, string>();
    for (const source of opened) {
      const target = join(snapshotRoot, source.snapshotName);
      await copyHandle(source.handle, target, Number(source.before.size));
      if (source.kind === 'database')
        databasePaths.set(source.database, target);
    }
    for (const source of opened) {
      const after = (await source.handle.stat({ bigint: true })) as BigIntStats;
      if (!sameSourceVersion(source.before, after)) {
        throw new UnstableSqliteFamilyError();
      }
      const current = await open(
        source.sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        const currentStat = (await current.stat({
          bigint: true,
        })) as BigIntStats;
        if (
          currentStat.dev !== source.before.dev ||
          currentStat.ino !== source.before.ino
        ) {
          throw new UnstableSqliteFamilyError();
        }
      } finally {
        await current.close();
      }
    }
    for (const source of opened) {
      await chmod(join(snapshotRoot, source.snapshotName), 0o400);
    }
    await chmod(snapshotRoot, 0o500);
    return databasePaths;
  } finally {
    await Promise.all(opened.map((source) => source.handle.close()));
  }
}

async function sourceFiles(
  config: Awaited<ReturnType<typeof validateOptions>>
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const database of config.databases) {
    const sourcePath = join(config.root, database.relativePath);
    const snapshotName = `${database.name}-${basename(database.relativePath)}`;
    files.push({
      database: database.name,
      sourcePath,
      snapshotName,
      kind: 'database',
      maxBytes: database.maxFileBytes,
    });
    if (database.sidecars === 'none') continue;
    for (const kind of ['wal', 'shm'] as const) {
      const sidecarPath = `${sourcePath}-${kind}`;
      try {
        await lstat(sidecarPath);
      } catch (error) {
        if (
          database.sidecars === 'optional' &&
          isNodeError(error) &&
          error.code === 'ENOENT'
        ) {
          continue;
        }
        throw new Error('Required SQLite trace sidecar is unavailable.');
      }
      files.push({
        database: database.name,
        sourcePath: sidecarPath,
        snapshotName: `${snapshotName}-${kind}`,
        kind,
        maxBytes: database.maxFileBytes,
      });
    }
  }
  return files;
}

function validateSourceStat(info: BigIntStats, maxBytes: number): void {
  if (
    !info.isFile() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    info.nlink !== 1n ||
    info.size < 0n ||
    info.size > BigInt(maxBytes)
  ) {
    throw new Error('Unsafe SQLite trace source file.');
  }
}

async function assertCanonicalChild(root: string, path: string): Promise<void> {
  const canonical = await realpath(path);
  const child = relative(root, canonical);
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('SQLite trace source escapes its declared root.');
  }
}

function sameSourceVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function copyHandle(
  source: FileHandle,
  targetPath: string,
  size: number
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const target = await open(
    targetPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    const buffer = Buffer.allocUnsafe(
      Math.min(COPY_BUFFER_BYTES, Math.max(size, 1))
    );
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead <= 0) throw new UnstableSqliteFamilyError();
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(
          buffer,
          written,
          bytesRead - written,
          offset + written
        );
        if (result.bytesWritten <= 0) {
          throw new Error('SQLite trace snapshot write failed.');
        }
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await target.sync();
  } finally {
    await target.close();
  }
}

async function inspectCopiedDatabases<T>(
  config: Awaited<ReturnType<typeof validateOptions>>,
  paths: Map<string, string>,
  inspect: (snapshot: ReadonlySqliteTraceSnapshot) => T | Promise<T>
): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite');
  const opened = new Map<string, DatabaseSync>();
  try {
    for (const source of config.databases) {
      const path = paths.get(source.name);
      if (!path) throw new Error('SQLite trace snapshot is incomplete.');
      const database = new DatabaseSync(path, { readOnly: true });
      database.exec('PRAGMA query_only = ON');
      verifyIntegrity(database);
      opened.set(source.name, database);
    }
    const snapshot: ReadonlySqliteTraceSnapshot = {
      database(name) {
        const database = opened.get(name);
        if (!database) throw new Error('Unknown SQLite trace database.');
        return createDatabaseReader(database, config.maxRows);
      },
    };
    return await inspect(snapshot);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    if (
      error instanceof Error &&
      (error.message.startsWith('SQLite trace') ||
        error.message.startsWith('Unknown SQLite'))
    ) {
      throw error;
    }
    throw new Error('SQLite trace snapshot cannot be opened read-only.');
  } finally {
    for (const database of opened.values()) database.close();
  }
}

function verifyIntegrity(database: DatabaseSync): void {
  const rows = database.prepare('PRAGMA quick_check').all() as Array<
    Record<string, unknown>
  >;
  if (
    rows.length !== 1 ||
    !Object.values(rows[0] ?? {}).some((value) => value === 'ok')
  ) {
    throw new Error('SQLite trace snapshot failed its integrity check.');
  }
}

function createDatabaseReader(
  database: DatabaseSync,
  defaultMaxRows: number
): ReadonlySqliteTraceDatabase {
  return {
    rows<T>(
      sql: string,
      parameters: readonly SqliteTraceValue[] = [],
      options: { maxRows?: number } = {}
    ): T[] {
      validateQuery(sql, parameters);
      const maxRows = Math.min(
        positiveBound(
          options.maxRows,
          defaultMaxRows,
          'SQLite trace query row bound'
        ),
        defaultMaxRows
      );
      const statement = database.prepare(sql);
      const result: T[] = [];
      for (const row of statement.iterate(...parameters)) {
        if (result.length >= maxRows) {
          throw new Error('SQLite trace query exceeded its row bound.');
        }
        result.push(row as T);
      }
      return result;
    },
  };
}

function validateQuery(
  sql: string,
  parameters: readonly SqliteTraceValue[]
): void {
  if (
    Buffer.byteLength(sql) > MAX_SQL_BYTES ||
    !/^\s*(SELECT|WITH)\b/i.test(sql) ||
    sql.includes('\0') ||
    parameters.length > MAX_PARAMETERS
  ) {
    throw new TypeError(
      'SQLite trace queries must be bounded read statements.'
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

class UnstableSqliteFamilyError extends Error {}
