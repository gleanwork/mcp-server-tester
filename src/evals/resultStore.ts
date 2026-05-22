import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

export type StoredArtifactKind =
  | 'eval-runner-result'
  | 'reporter-run'
  | 'eval-run-comparison'
  | 'server-comparison';

export interface StoredEvalArtifactMetadata {
  datasetName?: string;
  gitHash?: string;
  branch?: string;
  runNumber?: string;
  trigger?: string;
  packageVersion?: string;
  toolOverrideVariantId?: string;
  mcpHostModel?: string;
  judgeModel?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface StoredEvalArtifact<T> {
  schemaVersion: 1;
  kind: StoredArtifactKind;
  id: string;
  createdAt: string;
  metadata: StoredEvalArtifactMetadata;
  data: T;
}

export interface StoredArtifactSummary {
  kind: StoredArtifactKind;
  id: string;
  createdAt: string;
  metadata: StoredEvalArtifactMetadata;
}

export interface ListStoredArtifactsOptions {
  limit?: number;
}

export interface EvalResultStore {
  saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void>;
  loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>>;
  loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null>;
  listArtifacts(
    kind: StoredArtifactKind,
    options?: ListStoredArtifactsOptions
  ): Promise<StoredArtifactSummary[]>;
}

export interface FileEvalResultStoreConfig {
  provider: 'file';
  dir: string;
}

export interface GCSEvalResultStoreConfig {
  provider: 'gcs';
  bucket: string;
  prefix?: string;
}

export type EvalResultStoreConfig =
  | FileEvalResultStoreConfig
  | GCSEvalResultStoreConfig;

export type EvalResultStoreLike = EvalResultStore | EvalResultStoreConfig;

const KIND_DIRS: Record<StoredArtifactKind, string> = {
  'eval-runner-result': 'eval-runs',
  'reporter-run': 'reporter-runs',
  'eval-run-comparison': 'comparisons/eval-runs',
  'server-comparison': 'comparisons/servers',
};

export function createEvalResultStore(
  config: EvalResultStoreConfig
): EvalResultStore {
  if (config.provider === 'file') {
    return new FileEvalResultStore(config);
  }
  return new GCSEvalResultStore(config);
}

export function resolveEvalResultStore(
  store: EvalResultStoreLike
): EvalResultStore {
  return isEvalResultStore(store) ? store : createEvalResultStore(store);
}

export function isEvalResultStore(value: unknown): value is EvalResultStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'saveArtifact' in value &&
    'loadArtifact' in value &&
    'loadLatestArtifact' in value &&
    'listArtifacts' in value
  );
}

export function createStoredEvalArtifact<T>(options: {
  kind: StoredArtifactKind;
  data: T;
  id?: string;
  metadata?: StoredEvalArtifactMetadata;
  createdAt?: string;
}): StoredEvalArtifact<T> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    kind: options.kind,
    id: options.id ?? createDefaultArtifactId(createdAt),
    createdAt,
    metadata: {
      ...defaultEnvironmentMetadata(),
      ...(options.metadata ?? {}),
    },
    data: options.data,
  };
}

export function createDefaultArtifactId(timestamp = new Date().toISOString()) {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  const runNumber = process.env.GITHUB_RUN_NUMBER;
  const sha = process.env.GITHUB_SHA?.slice(0, 12);
  const suffix = runNumber ?? sha;
  return suffix ? `${safeTimestamp}-${suffix}` : safeTimestamp;
}

export function defaultEnvironmentMetadata(): StoredEvalArtifactMetadata {
  return {
    ...(process.env.GITHUB_SHA !== undefined && {
      gitHash: process.env.GITHUB_SHA,
    }),
    ...(process.env.GITHUB_REF_NAME !== undefined && {
      branch: process.env.GITHUB_REF_NAME,
    }),
    ...(process.env.GITHUB_RUN_NUMBER !== undefined && {
      runNumber: process.env.GITHUB_RUN_NUMBER,
    }),
    ...(process.env.GITHUB_EVENT_NAME !== undefined && {
      trigger: process.env.GITHUB_EVENT_NAME,
    }),
  };
}

export class FileEvalResultStore implements EvalResultStore {
  private readonly dir: string;

  constructor(config: FileEvalResultStoreConfig) {
    this.dir = config.dir;
  }

  async saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void> {
    const artifactDir = join(this.dir, KIND_DIRS[artifact.kind]);
    await mkdir(artifactDir, { recursive: true });
    const serialized = JSON.stringify(artifact, null, 2);
    await writeFile(
      join(artifactDir, `${artifact.id}.json`),
      serialized,
      'utf8'
    );
    await writeFile(join(artifactDir, 'latest.json'), serialized, 'utf8');
  }

  async loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>> {
    const raw = await readFile(
      join(this.dir, KIND_DIRS[kind], `${id}.json`),
      'utf8'
    );
    return JSON.parse(raw) as StoredEvalArtifact<T>;
  }

  async loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null> {
    try {
      const raw = await readFile(
        join(this.dir, KIND_DIRS[kind], 'latest.json'),
        'utf8'
      );
      return JSON.parse(raw) as StoredEvalArtifact<T>;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listArtifacts(
    kind: StoredArtifactKind,
    options: ListStoredArtifactsOptions = {}
  ): Promise<StoredArtifactSummary[]> {
    let files: string[];
    try {
      files = await readdir(join(this.dir, KIND_DIRS[kind]));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const summaries = await Promise.all(
      files
        .filter((f) => f.endsWith('.json') && f !== 'latest.json')
        .map(async (file) => {
          const raw = await readFile(
            join(this.dir, KIND_DIRS[kind], file),
            'utf8'
          );
          return toSummary(JSON.parse(raw) as StoredEvalArtifact<unknown>);
        })
    );

    return summaries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }
}

type GCSStorageConstructor = new () => {
  bucket(name: string): GCSBucket;
};

interface GCSBucket {
  file(name: string): GCSFile;
  getFiles(options: { prefix: string }): Promise<[GCSFile[]]>;
}

interface GCSFile {
  name: string;
  save(
    data: string,
    options?: { contentType?: string; resumable?: boolean; validation?: false }
  ): Promise<unknown>;
  download(): Promise<[Buffer]>;
  exists(): Promise<[boolean]>;
}

export class GCSEvalResultStore implements EvalResultStore {
  private readonly bucketName: string;
  private readonly prefix: string;
  private storage: { bucket(name: string): GCSBucket } | undefined;

  constructor(config: GCSEvalResultStoreConfig) {
    this.bucketName = config.bucket;
    this.prefix = trimSlashes(config.prefix ?? '');
  }

  async saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void> {
    const bucket = await this.getBucket();
    const serialized = JSON.stringify(artifact, null, 2);
    await bucket
      .file(
        this.objectPath(
          artifact.kind,
          `${encodeURIComponent(artifact.id)}.json`
        )
      )
      .save(serialized, {
        contentType: 'application/json',
        resumable: false,
        validation: false,
      });
    await bucket
      .file(this.objectPath(artifact.kind, 'latest.json'))
      .save(serialized, {
        contentType: 'application/json',
        resumable: false,
        validation: false,
      });
  }

  async loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>> {
    const bucket = await this.getBucket();
    const file = bucket.file(
      this.objectPath(kind, `${encodeURIComponent(id)}.json`)
    );
    const [buffer] = await file.download();
    return JSON.parse(buffer.toString('utf8')) as StoredEvalArtifact<T>;
  }

  async loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(kind, 'latest.json'));
    const [exists] = await file.exists();
    if (!exists) return null;

    const [buffer] = await file.download();
    return JSON.parse(buffer.toString('utf8')) as StoredEvalArtifact<T>;
  }

  async listArtifacts(
    kind: StoredArtifactKind,
    options: ListStoredArtifactsOptions = {}
  ): Promise<StoredArtifactSummary[]> {
    const bucket = await this.getBucket();
    const [files] = await bucket.getFiles({
      prefix: this.objectPath(kind, ''),
    });

    const summaries = await Promise.all(
      files
        .filter(
          (f) => f.name.endsWith('.json') && !f.name.endsWith('/latest.json')
        )
        .map(async (file) => {
          const [buffer] = await file.download();
          return toSummary(
            JSON.parse(buffer.toString('utf8')) as StoredEvalArtifact<unknown>
          );
        })
    );

    return summaries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  private async getBucket(): Promise<GCSBucket> {
    if (!this.storage) {
      const moduleName = '@google-cloud/storage';
      let Storage: GCSStorageConstructor;
      try {
        const mod = (await import(moduleName)) as {
          Storage: GCSStorageConstructor;
        };
        Storage = mod.Storage;
      } catch (error) {
        throw new Error(
          'GCS result storage requires the optional `@google-cloud/storage` package. ' +
            'Install it and authenticate with Application Default Credentials via GOOGLE_APPLICATION_CREDENTIALS.\n' +
            `Original error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.storage = new Storage();
    }
    return this.storage.bucket(this.bucketName);
  }

  private objectPath(kind: StoredArtifactKind, filename: string): string {
    const parts = [this.prefix, KIND_DIRS[kind], filename].filter(Boolean);
    return parts.join('/');
  }
}

function toSummary(
  artifact: StoredEvalArtifact<unknown>
): StoredArtifactSummary {
  return {
    kind: artifact.kind,
    id: artifact.id,
    createdAt: artifact.createdAt,
    metadata: artifact.metadata,
  };
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
