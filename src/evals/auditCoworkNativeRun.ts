import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { UsageMetrics } from '../types/index.js';
import {
  parseClaudeTrace,
  type ClaudeTrace,
} from './externalHost/builtins/anthropicClaude.js';
import { hostTraceToExecution, simulationToHostTrace } from './hostTrace.js';

export interface AuditCoworkNativeRunOptions {
  rawResultsPath: string;
  nativeRoot: string;
  expectedCases: number;
  expectedModel?: string;
}

export type CoworkNativeAuditIssue =
  | 'INVALID_OPTIONS'
  | 'INPUT_UNREADABLE'
  | 'INPUT_LIMIT'
  | 'UNSAFE_PATH'
  | 'INVALID_RESULTS'
  | 'CASE_COUNT_MISMATCH'
  | 'DUPLICATE_CASE_ID'
  | 'INVALID_CASE_ID'
  | 'INVALID_SESSION_ID'
  | 'DUPLICATE_SESSION_ID'
  | 'SESSION_UNREADABLE'
  | 'SESSION_ID_MISMATCH'
  | 'TRANSCRIPT_AMBIGUOUS'
  | 'NATIVE_PARSE_FAILED'
  | 'AUDIT_NOT_PARSED'
  | 'TRANSCRIPT_NOT_PARSED'
  | 'PARSE_WARNINGS'
  | 'NATIVE_INCOMPLETE'
  | 'NATIVE_ERROR'
  | 'USAGE_UNAVAILABLE'
  | 'COST_UNAVAILABLE'
  | 'TIMING_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_MISMATCH'
  | 'PROMPT_MISMATCH'
  | 'FINAL_RESPONSE_MISMATCH'
  | 'EVENTS_MISMATCH'
  | 'TOOL_CALLS_MISMATCH'
  | 'USAGE_MISMATCH'
  | 'TIMING_MISMATCH'
  | 'TELEMETRY_MISMATCH'
  | 'EVIDENCE_FLAGS_MISMATCH'
  | 'ARM_RESULTS_MISMATCH'
  | 'TOOL_OUTPUT_UNAVAILABLE'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_EMPTY'
  | 'ATTACHMENT_UNSAFE'
  | 'ATTACHMENT_LIMIT';

export interface CoworkNativeAuditUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
}
export interface CoworkNativeAuditTiming {
  durationMs: number | null;
  durationApiMs: number | null;
}
export interface CoworkNativeAuditAttachment {
  /** Index in the native-normalized tool call order. No recorded paths are returned. */
  toolCallIndex: number;
  valid: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  issues: CoworkNativeAuditIssue[];
}
export interface CoworkNativeAuditCase {
  /** Recognized numeric case IDs are retained; all other IDs are SHA-256 pseudonyms. */
  id: string;
  pass: boolean | null;
  sessionId: string | null;
  model: string | null;
  usage: CoworkNativeAuditUsage | null;
  timing: CoworkNativeAuditTiming | null;
  toolCounts: {
    total: number;
    mcp: number;
    host: number;
    errors: number | null;
  } | null;
  validity: {
    auditParsed: boolean | null;
    transcriptParsed: boolean | null;
    complete: boolean | null;
    nonError: boolean | null;
    hasUsage: boolean | null;
    hasCost: boolean | null;
    noWarnings: boolean | null;
  };
  attachments: CoworkNativeAuditAttachment[];
  evidencePassed: boolean;
  issues: CoworkNativeAuditIssue[];
}
export interface CoworkNativeAuditReport {
  schemaVersion: 1;
  expectedCases: number;
  observedCases: number;
  qualityPassed: boolean | null;
  evidencePassed: boolean;
  status: 'verified' | 'failed';
  cases: CoworkNativeAuditCase[];
  issues: CoworkNativeAuditIssue[];
  /** Available only for verified evidence. Each unknown field stays null. */
  totals:
    | (CoworkNativeAuditUsage &
        CoworkNativeAuditTiming & { costScope: 'native-inference-only' })
    | null;
}

type ObjectValue = Record<string, unknown>;
const SESSION =
  /^local_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Deliberately reject arbitrary model strings: the report must not echo private data.
const MODEL =
  /^claude-(?:opus|sonnet|haiku)-(?:[3-9])(?:-[0-9]{1,2})?(?:-[0-9]{8})?$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_RAW = 32 * 1024 * 1024;
const MAX_SESSION = 64 * 1024 * 1024;

class AuditFailure extends Error {
  constructor(readonly code: CoworkNativeAuditIssue) {
    super(code);
  }
}
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function same(a: unknown, b: unknown): boolean {
  // The stored envelope is JSON, whereas normalizers retain undefined properties.
  return isDeepStrictEqual(
    a,
    b === undefined ? undefined : JSON.parse(JSON.stringify(b))
  );
}
function issue(
  error: unknown,
  fallback: CoworkNativeAuditIssue
): CoworkNativeAuditIssue {
  return error instanceof AuditFailure ? error.code : fallback;
}
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function caseId(value: unknown, index: number): string {
  return typeof value === 'string'
    ? /^(?:e2e|case)-[0-9]{1,8}$/.test(value)
      ? value
      : `case-${hash(value).slice(0, 16)}`
    : `invalid-case-${index}`;
}

/** Reject symlinks in every existing path component, including caller-supplied roots. */
async function safePath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  while (current !== dirname(current)) {
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      // macOS exposes its system temporary directories through these fixed aliases.
      const systemAlias =
        process.platform === 'darwin' &&
        (current === '/tmp' || current === '/var') &&
        (await realpath(current)) === `/private${current}`;
      if (!systemAlias) throw new AuditFailure('UNSAFE_PATH');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical =
    process.platform === 'darwin'
      ? absolute.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1')
      : absolute;
  if ((await realpath(absolute)) !== canonical)
    throw new AuditFailure('UNSAFE_PATH');
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  await safePath(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AuditFailure('UNSAFE_PATH');
    if (before.size > limit) throw new AuditFailure('INPUT_LIMIT');
    // A bounded buffer also prevents an actively growing file from exhausting memory.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new AuditFailure('INPUT_LIMIT');
    await safePath(path);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function sessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let count = 0;
  let bytes = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 12) throw new AuditFailure('INPUT_LIMIT');
    await safePath(path);
    for await (const entry of await opendir(path)) {
      if (++count > 4096) throw new AuditFailure('INPUT_LIMIT');
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new AuditFailure('UNSAFE_PATH');
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile()) {
        const stats = await lstat(child);
        bytes += stats.size;
        if (stats.size > MAX_FILE || bytes > MAX_SESSION)
          throw new AuditFailure('INPUT_LIMIT');
        files.push(child);
      } else throw new AuditFailure('UNSAFE_PATH');
    }
  }
  await visit(root, 0);
  return files;
}

async function nativeTrace(
  root: string,
  sessionId: string
): Promise<ClaudeTrace> {
  const sessionDir = join(root, sessionId);
  const files = await sessionFiles(sessionDir);
  const metadataPath = join(sessionDir, `${sessionId}.json`);
  const metadata = object(
    JSON.parse((await readBounded(metadataPath, MAX_FILE)).toString('utf8'))
  );
  if (metadata.sessionId !== sessionId)
    throw new AuditFailure('SESSION_ID_MISMATCH');
  if (
    typeof metadata.cliSessionId !== 'string' ||
    !UUID.test(metadata.cliSessionId)
  )
    throw new AuditFailure('TRANSCRIPT_NOT_PARSED');
  const cliSessionId = metadata.cliSessionId;
  const transcripts = files.filter(
    (path) => basename(path) === `${cliSessionId}.jsonl`
  );
  if (transcripts.length !== 1)
    throw new AuditFailure(
      transcripts.length ? 'TRANSCRIPT_AMBIGUOUS' : 'TRANSCRIPT_NOT_PARSED'
    );
  const audit = await readBounded(join(sessionDir, 'audit.jsonl'), MAX_FILE);
  const transcript = await readBounded(transcripts[0]!, MAX_FILE);
  // Parse only an isolated bounded copy. The existing parser never traverses the archive.
  const snapshot = await mkdtemp(join(tmpdir(), 'mst-cowork-audit-'));
  try {
    await writeFile(join(snapshot, 'audit.jsonl'), audit, { mode: 0o600 });
    await writeFile(
      join(snapshot, `${metadata.cliSessionId}.jsonl`),
      transcript,
      { mode: 0o600 }
    );
    return await parseClaudeTrace({
      id: sessionId,
      sessionDir: snapshot,
      metadataPath,
      statMtimeMs: 0,
      metadata: {
        sessionId,
        cliSessionId: metadata.cliSessionId,
        initialMessage:
          typeof metadata.initialMessage === 'string'
            ? metadata.initialMessage
            : undefined,
      },
    });
  } catch {
    throw new AuditFailure('NATIVE_PARSE_FAILED');
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

function attachmentPath(
  pointer: string,
  root: string,
  sessionId: string
): string {
  // Linux absolute pointers only; never read their recorded absolute location.
  if (
    !pointer.startsWith('/') ||
    pointer.length > 4096 ||
    /[\\%]/.test(pointer) ||
    [...pointer].some((character) => character.charCodeAt(0) < 32)
  )
    throw new AuditFailure('ATTACHMENT_UNSAFE');
  const parts = pointer.split('/');
  if (parts.some((part) => part === '..' || part === '.'))
    throw new AuditFailure('ATTACHMENT_UNSAFE');
  const sessionSegments = parts.filter((part) => SESSION.test(part));
  if (sessionSegments.length !== 1 || sessionSegments[0] !== sessionId)
    throw new AuditFailure('ATTACHMENT_UNSAFE');
  const suffix = parts.slice(parts.indexOf(sessionId) + 1);
  // Native saved outputs are only .claude/projects/<project>/<CLI UUID>/tool-results/*.txt.
  if (
    suffix.length !== 6 ||
    suffix[0] !== '.claude' ||
    suffix[1] !== 'projects' ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(suffix[2]!) ||
    !UUID.test(suffix[3]!) ||
    suffix[4] !== 'tool-results' ||
    !/^[A-Za-z0-9_-]{1,240}\.txt$/.test(suffix[5]!)
  )
    throw new AuditFailure('ATTACHMENT_UNSAFE');
  const sessionRoot = resolve(root, sessionId);
  const target = resolve(sessionRoot, ...suffix);
  if (!target.startsWith(`${sessionRoot}${sep}`))
    throw new AuditFailure('ATTACHMENT_UNSAFE');
  return target;
}
async function attachments(
  trace: ClaudeTrace,
  root: string,
  sessionId: string
): Promise<CoworkNativeAuditAttachment[]> {
  const results: CoworkNativeAuditAttachment[] = [];
  for (const [toolCallIndex, tool] of trace.toolCalls.entries()) {
    const output = typeof tool.output === 'string' ? tool.output : '';
    // Also inspect structured block text serialized by the native normalizer.
    let texts = [output];
    try {
      const blocks: unknown = JSON.parse(output);
      if (Array.isArray(blocks))
        texts = blocks
          .map((block) => object(block).text)
          .filter((text): text is string => typeof text === 'string');
    } catch {
      /* Plain text is the usual native output form. */
    }
    for (const text of texts)
      for (const match of text.matchAll(/Output has been saved to\b/g)) {
        if (results.length >= 1024) throw new AuditFailure('ATTACHMENT_LIMIT');
        const entry: CoworkNativeAuditAttachment = {
          toolCallIndex,
          valid: false,
          sizeBytes: null,
          sha256: null,
          issues: [],
        };
        try {
          const tail = text.slice(match.index + match[0].length);
          const pointerMatch = /^\s+["'`]?([^\s"'`<>]+)/.exec(tail);
          if (!pointerMatch) throw new AuditFailure('ATTACHMENT_UNSAFE');
          const pointer = pointerMatch[1]!.replace(/\.$/, '');
          const bytes = await readBounded(
            attachmentPath(pointer, root, sessionId),
            MAX_FILE
          );
          if (bytes.length === 0) throw new AuditFailure('ATTACHMENT_EMPTY');
          entry.sizeBytes = bytes.length;
          entry.sha256 = hash(bytes);
          entry.valid = true;
        } catch (error) {
          const code = issue(error, 'ATTACHMENT_MISSING');
          entry.issues.push(
            code === 'UNSAFE_PATH'
              ? 'ATTACHMENT_UNSAFE'
              : code === 'INPUT_LIMIT'
                ? 'ATTACHMENT_LIMIT'
                : code
          );
        }
        results.push(entry);
      }
  }
  return results;
}
function numeric(trace: ClaudeTrace, key: keyof UsageMetrics): number | null {
  const value = trace.usage?.[key];
  return trace.knownUsageFields.includes(key) &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}
function freshCase(saved: ObjectValue, index: number): CoworkNativeAuditCase {
  return {
    id: caseId(saved.id, index),
    pass: typeof saved.pass === 'boolean' ? saved.pass : null,
    sessionId: null,
    model: null,
    usage: null,
    timing: null,
    toolCounts: null,
    validity: {
      auditParsed: null,
      transcriptParsed: null,
      complete: null,
      nonError: null,
      hasUsage: null,
      hasCost: null,
      noWarnings: null,
    },
    attachments: [],
    evidencePassed: false,
    issues: [],
  };
}
async function auditCase(
  saved: ObjectValue,
  result: CoworkNativeAuditCase,
  servers: MCPConfig[],
  options: AuditCoworkNativeRunOptions
): Promise<void> {
  const sessionId = object(saved.hostTelemetry).nativeSessionId;
  if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) {
    result.issues.push('INVALID_SESSION_ID');
    return;
  }
  result.sessionId = sessionId;
  const trace = await nativeTrace(resolve(options.nativeRoot), sessionId);
  result.validity = {
    auditParsed: trace.auditParsed,
    transcriptParsed: trace.transcriptParsed,
    complete: trace.isComplete,
    nonError: trace.isError === false,
    hasUsage:
      numeric(trace, 'inputTokens') !== null &&
      numeric(trace, 'outputTokens') !== null,
    hasCost: trace.costAvailable && numeric(trace, 'totalCostUsd') !== null,
    noWarnings: trace.parseWarnings.length === 0,
  };
  const flags: [
    keyof CoworkNativeAuditCase['validity'],
    CoworkNativeAuditIssue,
  ][] = [
    ['auditParsed', 'AUDIT_NOT_PARSED'],
    ['transcriptParsed', 'TRANSCRIPT_NOT_PARSED'],
    ['complete', 'NATIVE_INCOMPLETE'],
    ['nonError', 'NATIVE_ERROR'],
    ['hasUsage', 'USAGE_UNAVAILABLE'],
    ['hasCost', 'COST_UNAVAILABLE'],
    ['noWarnings', 'PARSE_WARNINGS'],
  ];
  for (const [flag, code] of flags)
    if (!result.validity[flag]) result.issues.push(code);
  const models = trace.telemetry.models;
  if (models.length === 1 && MODEL.test(models[0]!)) result.model = models[0]!;
  else result.issues.push('MODEL_UNAVAILABLE');
  if (
    options.expectedModel &&
    (models.length !== 1 || models[0] !== options.expectedModel)
  )
    result.issues.push('MODEL_MISMATCH');
  result.usage = {
    inputTokens: numeric(trace, 'inputTokens'),
    outputTokens: numeric(trace, 'outputTokens'),
    cacheReadInputTokens: numeric(trace, 'cacheReadInputTokens'),
    cacheCreationInputTokens: numeric(trace, 'cacheCreationInputTokens'),
    totalCostUsd: numeric(trace, 'totalCostUsd'),
  };
  result.timing = {
    durationMs: numeric(trace, 'durationMs'),
    durationApiMs: numeric(trace, 'durationApiMs'),
  };
  if (result.timing.durationMs === null || result.timing.durationApiMs === null)
    result.issues.push('TIMING_UNAVAILABLE');
  result.toolCounts = {
    total: trace.toolCalls.length,
    mcp: trace.toolCalls.filter((call) => call.source === 'mcp').length,
    host: trace.toolCalls.filter((call) => call.source === 'host').length,
    errors: trace.telemetry.toolErrorCount ?? null,
  };
  if (trace.toolCalls.some((call) => call.output === undefined))
    result.issues.push('TOOL_OUTPUT_UNAVAILABLE');
  const response = object(saved.response);
  const replay = object(
    hostTraceToExecution(
      simulationToHostTrace(
        {
          success: !trace.isError && trace.finalAnswer !== undefined,
          response: trace.finalAnswer,
          toolCalls: trace.toolCalls,
          usage: trace.usage,
        },
        servers
      ),
      'structured',
      servers
    ).response
  );
  if (
    typeof object(saved.request).scenario !== 'string' ||
    trace.candidate.metadata.initialMessage !== object(saved.request).scenario
  )
    result.issues.push('PROMPT_MISMATCH');
  if (
    trace.finalAnswer === undefined ||
    response.response !== trace.finalAnswer
  )
    result.issues.push('FINAL_RESPONSE_MISMATCH');
  if (!same(response.events, replay.events))
    result.issues.push('EVENTS_MISMATCH');
  if (!same(response.toolCalls, replay.toolCalls))
    result.issues.push('TOOL_CALLS_MISMATCH');
  if (!same(response.usage, trace.usage) || !same(saved.hostUsage, trace.usage))
    result.issues.push('USAGE_MISMATCH');
  if (response.llmDurationMs !== trace.llmDurationMs)
    result.issues.push('TIMING_MISMATCH');
  if (
    response.success !== true ||
    response.evidence !== 'structured' ||
    saved.hostEvidence !== 'structured'
  )
    result.issues.push('EVIDENCE_FLAGS_MISMATCH');
  const telemetry = {
    source: 'claude-native',
    costScope: 'native-inference-only',
    ...trace.telemetry,
    nativeSessionId: sessionId,
    correlation: 'exact-initial-prompt',
  };
  for (const stored of [
    object(saved.hostTelemetry),
    object(response.telemetry),
  ]) {
    // Only live controller observations are excluded; all native-derived fields must match.
    const {
      computerUse: _computerUse,
      hitlWarning: _hitlWarning,
      ...native
    } = stored;
    if (!same(native, telemetry)) result.issues.push('TELEMETRY_MISMATCH');
  }
  result.attachments = await attachments(
    trace,
    resolve(options.nativeRoot),
    sessionId
  );
  result.issues.push(...result.attachments.flatMap((entry) => entry.issues));
}

function sumKnown(
  cases: CoworkNativeAuditCase[],
  key: keyof CoworkNativeAuditUsage | keyof CoworkNativeAuditTiming
): number | null {
  const values = cases.map(
    (result) => ({ ...result.usage, ...result.timing })[key]
  );
  if (!values.every((value): value is number => typeof value === 'number'))
    return null;
  const total = values.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? total : null;
}

/** Offline, metadata-only audit of MST schema-v1 raw results and a saved Linux Cowork archive. */
export async function auditCoworkNativeRun(
  options: AuditCoworkNativeRunOptions
): Promise<CoworkNativeAuditReport> {
  const report: CoworkNativeAuditReport = {
    schemaVersion: 1,
    expectedCases: Number.isSafeInteger(options?.expectedCases)
      ? options.expectedCases
      : 0,
    observedCases: 0,
    qualityPassed: null,
    evidencePassed: false,
    status: 'failed',
    cases: [],
    issues: [],
    totals: null,
  };
  if (
    !options ||
    !Number.isSafeInteger(options.expectedCases) ||
    options.expectedCases < 1 ||
    options.expectedCases > 1000 ||
    typeof options.rawResultsPath !== 'string' ||
    typeof options.nativeRoot !== 'string' ||
    options.rawResultsPath.length > 4096 ||
    options.nativeRoot.length > 4096 ||
    (options.expectedModel !== undefined &&
      (typeof options.expectedModel !== 'string' ||
        !MODEL.test(options.expectedModel)))
  ) {
    report.issues.push('INVALID_OPTIONS');
    return report;
  }
  try {
    await safePath(options.nativeRoot);
    if (!(await lstat(options.nativeRoot)).isDirectory())
      throw new AuditFailure('UNSAFE_PATH');
    const raw = object(
      JSON.parse(
        (await readBounded(options.rawResultsPath, MAX_RAW)).toString('utf8')
      )
    );
    if (
      raw.schemaVersion !== 1 ||
      !Array.isArray(raw.results) ||
      raw.results.length > 1000 ||
      !Array.isArray(raw.arms) ||
      raw.arms.length > 1000
    )
      throw new AuditFailure('INVALID_RESULTS');
    report.observedCases = raw.results.length;
    if (report.observedCases !== options.expectedCases)
      report.issues.push('CASE_COUNT_MISMATCH');
    const armCases = raw.arms.flatMap((arm) => {
      const value = object(object(arm).result).caseResults;
      return Array.isArray(value) ? (value as unknown[]) : [];
    });
    if (!same(raw.results, armCases))
      report.issues.push('ARM_RESULTS_MISMATCH');
    const ids = new Map<string, CoworkNativeAuditCase>();
    const sessions = new Map<string, CoworkNativeAuditCase>();
    for (const [index, value] of raw.results.entries()) {
      const saved = object(value);
      const result = freshCase(saved, index);
      report.cases.push(result);
      if (
        typeof saved.id !== 'string' ||
        saved.id.length < 1 ||
        saved.id.length > 512
      )
        result.issues.push('INVALID_CASE_ID');
      else {
        const prior = ids.get(saved.id);
        if (prior) {
          prior.issues.push('DUPLICATE_CASE_ID');
          result.issues.push('DUPLICATE_CASE_ID');
        }
        ids.set(saved.id, result);
      }
      const arm = object(
        raw.arms.find((arm) => {
          const cases = object(object(arm).result).caseResults;
          return (
            Array.isArray(cases) &&
            cases.some((entry) => object(entry).id === saved.id)
          );
        })
      );
      const servers: MCPConfig[] = Array.isArray(arm.servers)
        ? arm.servers.map((server) => ({
            transport: 'http',
            serverUrl: 'https://invalid.local',
            ...(typeof object(server).label === 'string'
              ? { label: object(server).label as string }
              : {}),
          }))
        : [];
      try {
        await auditCase(saved, result, servers, options);
      } catch (error) {
        result.issues.push(issue(error, 'SESSION_UNREADABLE'));
      }
      if (result.sessionId) {
        const prior = sessions.get(result.sessionId);
        if (prior) {
          prior.issues.push('DUPLICATE_SESSION_ID');
          result.issues.push('DUPLICATE_SESSION_ID');
        }
        sessions.set(result.sessionId, result);
      }
    }
    report.qualityPassed = report.cases.some((result) => result.pass === false)
      ? false
      : report.cases.length === 0 ||
          report.cases.some((result) => result.pass === null)
        ? null
        : true;
    for (const result of report.cases) {
      result.issues = [...new Set(result.issues)];
      result.evidencePassed = result.issues.length === 0;
    }
    report.evidencePassed =
      report.issues.length === 0 &&
      report.cases.every((result) => result.evidencePassed);
    report.status = report.evidencePassed ? 'verified' : 'failed';
    if (report.evidencePassed) {
      report.totals = {
        costScope: 'native-inference-only',
        inputTokens: sumKnown(report.cases, 'inputTokens'),
        outputTokens: sumKnown(report.cases, 'outputTokens'),
        cacheReadInputTokens: sumKnown(report.cases, 'cacheReadInputTokens'),
        cacheCreationInputTokens: sumKnown(
          report.cases,
          'cacheCreationInputTokens'
        ),
        totalCostUsd: sumKnown(report.cases, 'totalCostUsd'),
        durationMs: sumKnown(report.cases, 'durationMs'),
        durationApiMs: sumKnown(report.cases, 'durationApiMs'),
      };
    }
  } catch (error) {
    report.issues.push(issue(error, 'INPUT_UNREADABLE'));
  }
  return report;
}
