import { RUN_FORMAT, olderResultsError } from './resultFormat.js';
import { loadGCSStorage } from './gcsStorage.js';
import { isHostContentAttribute } from './telemetry/hostContent.js';
import type { ProtocolEra } from '../types/index.js';
import { readdir } from 'fs/promises';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseChunked } from '@discoveryjs/json-ext';
import {
  jsonChunks,
  jsonCopy,
  readJsonFile,
  writeJsonFile,
} from '../utils/jsonFile.js';
import { join } from 'path';

export type StoredArtifactKind =
  | 'eval-runner-result'
  | 'eval-run-summary'
  | 'eval-run-comparison';

export interface StoredEvalArtifactMetadata {
  datasetName?: string;
  gitHash?: string;
  branch?: string;
  runNumber?: string;
  trigger?: string;
  packageVersion?: string;
  toolVariantId?: string;
  model?: string;
  judgeModel?: string;
  /** Negotiated MCP protocol revision of the run, e.g. '2026-07-28'. */
  protocolVersion?: string;
  /** Protocol era of the run ('legacy' or 'modern'). */
  protocolEra?: ProtocolEra;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface StoredEvalArtifact<T> {
  /** The run format: see `RUN_FORMAT`. */
  format: typeof RUN_FORMAT;
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
  'eval-run-summary': 'eval-summaries',
  'eval-run-comparison': 'comparisons/eval-runs',
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

/**
 * Stored results omit raw responses unless a caller opts out. Every API that
 * persists results (eval runner, eval, reporter, run and server
 * comparisons) uses this default.
 */
export const REDACT_STORED_RESPONSES_BY_DEFAULT = true;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An eval case result, recognised by shape wherever it is nested. */
function isCaseResult(value: JsonObject): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.pass === 'boolean' &&
    isJsonObject(value.scores)
  );
}

/** A trace keeps its structure; its answer and tool outputs go. */
function stripTrace(trace: unknown): void {
  if (!isJsonObject(trace)) return;
  delete trace.finalText;
  if (Array.isArray(trace.events))
    for (const event of trace.events)
      if (isJsonObject(event)) delete event.output;
  if (Array.isArray(trace.modelCalls))
    for (const call of trace.modelCalls)
      if (isJsonObject(call)) delete call.text;
  // The host's content attributes, kept with `telemetry.host.content`.
  const host = trace.hostTelemetry;
  if (isJsonObject(host)) {
    const strip = (attributes: unknown) => {
      if (isJsonObject(attributes))
        for (const key of Object.keys(attributes))
          if (isHostContentAttribute(key)) delete attributes[key];
    };
    for (const kind of ['events', 'spans'] as const)
      if (Array.isArray(host[kind]))
        for (const record of host[kind])
          if (isJsonObject(record)) {
            strip(record.attributes);
            if (Array.isArray(record.events))
              for (const event of record.events)
                if (isJsonObject(event)) strip(event.attributes);
          }
  }
}

/**
 * A judge's `metadata` is the judge's own: an agentic judge's audit, a
 * plugin's working notes. It can quote the evidence, so it goes too; the
 * score, pass and reasoning stay.
 */
function stripScoreMetadata(scores: unknown): void {
  if (!isJsonObject(scores)) return;
  for (const score of Object.values(scores))
    if (isJsonObject(score)) delete score.metadata;
}

function stripResponses(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripResponses(item);
    return;
  }
  if (!isJsonObject(value)) return;
  if (isCaseResult(value)) {
    delete value.response;
    const request = value.request;
    if (isJsonObject(request) && isJsonObject(request.assertions))
      delete request.assertions.response;
    stripTrace(value.trace);
    stripScoreMetadata(value.scores);
    if (Array.isArray(value.trialResults))
      for (const trial of value.trialResults)
        if (isJsonObject(trial)) {
          stripTrace(trial.trace);
          stripScoreMetadata(trial.scores);
        }
  }
  for (const nested of Object.values(value)) stripResponses(nested);
}

/**
 * The one redaction policy for stored results: returns a deep copy in which
 * every eval case result, wherever it is nested (runs, eval variants, reports,
 * comparisons), has no raw `response`, no echoed exact-match
 * `expect.response`, no `finalText`, event `output` or model call `text` in
 * its traces, and no judge score `metadata` (in it or its trials).
 * These may hold data from the server under test. Everything else is kept,
 * including each trace's events, servers, arguments and usage.
 */
export function redactStoredResponses<T>(value: T): T {
  // JSON's semantics, as stored results are JSON: a judge's metadata only has
  // to be JSON-serializable, which a structured clone is not (a URL, say).
  const copy = jsonCopy(value);
  stripResponses(copy);
  return copy;
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
    format: RUN_FORMAT,
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

/** A partial run's artifacts never become a store's latest. */
function isPartial(artifact: StoredEvalArtifact<unknown>): boolean {
  return artifact.metadata?.labels?.partial === 'true';
}

export class FileEvalResultStore implements EvalResultStore {
  private readonly dir: string;

  constructor(config: FileEvalResultStoreConfig) {
    this.dir = config.dir;
  }

  async saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void> {
    const artifactDir = join(this.dir, KIND_DIRS[artifact.kind]);
    await writeJsonFile(join(artifactDir, `${artifact.id}.json`), artifact);
    if (!isPartial(artifact))
      await writeJsonFile(join(artifactDir, 'latest.json'), artifact);
  }

  async loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>> {
    const raw = await readJsonFile(
      join(this.dir, KIND_DIRS[kind], `${id}.json`)
    );
    return currentArtifact<T>(raw, `Stored ${kind} '${id}'`);
  }

  async loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null> {
    try {
      const raw = await readJsonFile(
        join(this.dir, KIND_DIRS[kind], 'latest.json')
      );
      return currentArtifact<T>(raw, `The latest stored ${kind}`);
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
          const raw = await readJsonFile(join(this.dir, KIND_DIRS[kind], file));
          return raw as StoredEvalArtifact<unknown>;
        })
    );

    return currentSummaries(summaries)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }
}

interface GCSBucket {
  file(name: string): GCSFile;
  getFiles(options: { prefix: string }): Promise<[GCSFile[]]>;
}

interface GCSFile {
  name: string;
  createWriteStream(options: {
    contentType: string;
    resumable: boolean;
    validation: false;
  }): Writable;
  createReadStream(): Readable;
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
    const upload = async (name: string): Promise<void> => {
      await pipeline(
        Readable.from(jsonChunks(artifact)),
        bucket.file(this.objectPath(artifact.kind, name)).createWriteStream({
          contentType: 'application/json',
          resumable: false,
          validation: false,
        })
      );
    };
    await upload(`${encodeURIComponent(artifact.id)}.json`);
    if (!isPartial(artifact)) await upload('latest.json');
  }

  async loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>> {
    const bucket = await this.getBucket();
    const file = bucket.file(
      this.objectPath(kind, `${encodeURIComponent(id)}.json`)
    );
    return currentArtifact<T>(
      await parseChunked(file.createReadStream()),
      `Stored ${kind} '${id}'`
    );
  }

  async loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null> {
    const bucket = await this.getBucket();
    const file = bucket.file(this.objectPath(kind, 'latest.json'));
    const [exists] = await file.exists();
    if (!exists) return null;

    return currentArtifact<T>(
      await parseChunked(file.createReadStream()),
      `The latest stored ${kind}`
    );
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
          return (await parseChunked(
            file.createReadStream()
          )) as StoredEvalArtifact<unknown>;
        })
    );

    return currentSummaries(summaries)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  private async getBucket(): Promise<GCSBucket> {
    this.storage ??= await loadGCSStorage<GCSBucket>();
    return this.storage.bucket(this.bucketName);
  }

  private objectPath(kind: StoredArtifactKind, filename: string): string {
    const parts = [this.prefix, KIND_DIRS[kind], filename].filter(Boolean);
    return parts.join('/');
  }
}

/** An artifact an explicit load asked for: older formats fail clearly. */
function currentArtifact<T>(
  value: unknown,
  what: string
): StoredEvalArtifact<T> {
  const artifact = value as StoredEvalArtifact<T>;
  if (artifact?.format !== RUN_FORMAT)
    throw olderResultsError(what, artifact?.format);
  return artifact;
}

/** History listings skip artifacts in an older result format. */
function currentSummaries(
  artifacts: Array<StoredEvalArtifact<unknown>>
): StoredArtifactSummary[] {
  return artifacts
    .filter((artifact) => artifact?.format === RUN_FORMAT)
    .map(toSummary);
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
