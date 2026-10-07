import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExternalClientConfig, ClientRunContext } from '../types.js';
import { POLL_INTERVAL_MS, delay } from './claudeCommon.js';
import { NativeTraceError } from '../nativeTraceError.js';

/**
 * Message prefixes the eval runner counts as infrastructure failures. Cowork
 * reports a binding failure as text, so the runner matches these exact
 * prefixes; keep the wording here and nowhere else.
 */
export const CLAUDE_SESSION_TIMEOUT_MESSAGE =
  'Timed out waiting for Claude session';
export const CLAUDE_NO_MATCHING_SESSION_MESSAGE = 'No matching Claude session';
import {
  type ClaudeSessionMetadata,
  type ClaudeTrace,
  type SessionCandidate,
  metadataTimestampMs,
  parseClaudeTrace,
} from './claudeTrace.js';
import { findFile } from './claudeCommon.js';
import { configStringOption, runStringOption } from './bindingOptions.js';

const TRACE_SETTLE_AFTER_COMPLETE_MS = 1_500;
interface SnapshotEntry {
  mtimeMs: number;
}

export type ClaudeSessionSnapshot = Map<string, SnapshotEntry>;

export function getClaudeDataDir(
  config: ExternalClientConfig,
  binding?: { with?: Record<string, unknown> }
): string {
  const configuredDataDir = binding
    ? runStringOption(config, binding, 'dataDir')
    : configStringOption(config, 'dataDir');

  return (
    configuredDataDir ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions'
    )
  );
}

export async function snapshotClaudeSessions(
  dataDir: string
): Promise<ClaudeSessionSnapshot> {
  const snapshot = new Map<string, SnapshotEntry>();
  const sessions = await listSessionCandidates(dataDir);
  for (const session of sessions) {
    snapshot.set(session.metadataPath, { mtimeMs: session.statMtimeMs });
  }
  return snapshot;
}

interface ClaudeSessionMatchOptions {
  dataDir: string;
  marker?: string;
  correlation?: ClientRunContext['correlation'];
  snapshot: ClaudeSessionSnapshot;
  startedAtMs: number;
  /** Fresh-session correlation: exact initial user text, never raw-text substring matching. */
  exactPrompt?: string;
  sessionPath?: string;
  /** Bound pending trace inspection; never submits or changes session identity. */
  onPending?: (trace: ClaudeTrace) => Promise<void>;
}

export async function waitForClaudeSession(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTrace> {
  return waitForClaudeMatch(options, false);
}

export async function waitForClaudeTrace(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTrace> {
  return waitForClaudeMatch(options, true);
}

async function waitForClaudeMatch(
  options: ClaudeSessionMatchOptions & { timeoutMs: number },
  requireCompletion: boolean
): Promise<ClaudeTrace> {
  const deadline = Date.now() + options.timeoutMs;
  let lastPending: ClaudeTrace | undefined;
  let completeTraceFirstSeenAtMs: number | undefined;

  while (Date.now() < deadline) {
    const matches = await findMatchingClaudeSessions(options);

    if (matches.length > 1) {
      throw new NativeTraceError(
        'ambiguous_matching_sessions',
        `Ambiguous Claude sessions for ${describeCorrelation(options)}: ${matches
          .map((m) => m.candidate.id)
          .join(', ')}`
      );
    }

    if (matches.length === 1) {
      const trace = matches[0]!;
      if (
        !requireCompletion ||
        isTraceReady(trace, completeTraceFirstSeenAtMs)
      ) {
        return trace;
      }
      if (trace.isComplete && completeTraceFirstSeenAtMs === undefined) {
        completeTraceFirstSeenAtMs = Date.now();
      }
      lastPending = trace;
      if (requireCompletion && !trace.isComplete && options.onPending)
        await options.onPending(trace);
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (lastPending) {
    throw new NativeTraceError(
      'timeout',
      `${CLAUDE_SESSION_TIMEOUT_MESSAGE} ${lastPending.candidate.id} to complete`
    );
  }

  throw new NativeTraceError(
    'no_matching_session',
    `${CLAUDE_NO_MATCHING_SESSION_MESSAGE} found for ${describeCorrelation(options)}`
  );
}

function isTraceReady(
  trace: ClaudeTrace,
  completeTraceFirstSeenAtMs: number | undefined
): boolean {
  if (!trace.isComplete) {
    return false;
  }

  if (!trace.candidate.metadata.cliSessionId || trace.transcriptParsed) {
    return true;
  }

  return (
    completeTraceFirstSeenAtMs !== undefined &&
    Date.now() - completeTraceFirstSeenAtMs >= TRACE_SETTLE_AFTER_COMPLETE_MS
  );
}

export async function findMatchingClaudeSessions(
  options: ClaudeSessionMatchOptions
): Promise<ClaudeTrace[]> {
  const sessions = await listSessionCandidates(options.dataDir);
  const traces: ClaudeTrace[] = [];

  for (const session of sessions) {
    const previous = options.snapshot.get(session.metadataPath);
    const isNewOrUpdated =
      previous === undefined || session.statMtimeMs > previous.mtimeMs;
    const createdAtMs = metadataTimestampMs(session.metadata.createdAt);
    const isRecent =
      !Number.isNaN(createdAtMs) && createdAtMs >= options.startedAtMs - 5_000;

    if (options.sessionPath && session.metadataPath !== options.sessionPath)
      continue;
    if (options.exactPrompt !== undefined) {
      // Existing sessions remain excluded even if they change. The creation window
      // alone is never evidence of ownership. Do not match answers or tool output.
      if (
        previous !== undefined ||
        !isRecent ||
        createdAtMs > Date.now() + 5_000 ||
        session.metadata.initialMessage !== options.exactPrompt
      )
        continue;
      traces.push(await parseClaudeTrace(session));
      continue;
    }
    if (!isNewOrUpdated && !isRecent) {
      continue;
    }

    if (!options.marker && options.correlation?.includedInPrompt !== false)
      continue;
    const trace = await parseClaudeTrace(
      session,
      options.correlation?.includedInPrompt === false
        ? undefined
        : options.marker
    );
    if (
      sessionMatchesCorrelation({
        session,
        trace,
        marker: options.marker ?? '',
        correlation: options.correlation,
        isNewOrUpdated,
        isRecent,
      })
    ) {
      traces.push(trace);
    }
  }

  return traces;
}

function describeCorrelation(options: ClaudeSessionMatchOptions): string {
  if (options.exactPrompt !== undefined)
    return 'exact initial prompt in a new native session';
  if (options.correlation?.includedInPrompt) {
    return `marker ${options.marker}`;
  }
  return `${options.correlation?.strategy ?? 'none'} correlation near the run start`;
}

async function listSessionCandidates(
  dataDir: string
): Promise<SessionCandidate[]> {
  const metadataPaths = await findClaudeMetadataFiles(dataDir);
  const candidates: SessionCandidate[] = [];

  for (const metadataPath of metadataPaths) {
    try {
      const metadata = JSON.parse(
        await readFile(metadataPath, 'utf-8')
      ) as ClaudeSessionMetadata;
      const metadataStat = await stat(metadataPath);
      const id = basename(metadataPath, '.json');
      // Claude 2.110 stores files under <short UUID>/ and points cwd at
      // that directory's outputs folder. Retain the legacy local_<UUID>/ layout.
      const shortId = /^local_([a-f0-9]{8})-/i.exec(id)?.[1];
      const nativeDir = shortId
        ? join(dirname(metadataPath), shortId)
        : undefined;
      const sessionDir =
        nativeDir &&
        typeof metadata.cwd === 'string' &&
        isAbsolute(metadata.cwd) &&
        dirname(resolve(metadata.cwd)) === resolve(nativeDir)
          ? nativeDir
          : join(dirname(metadataPath), id);
      const statMtimeMs = await getSessionObservedMtime({
        sessionDir,
        cliSessionId: metadata.cliSessionId,
        metadataMtimeMs: metadataStat.mtimeMs,
      });
      candidates.push({
        id,
        metadataPath,
        sessionDir,
        statMtimeMs,
        metadata,
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

async function getSessionObservedMtime(options: {
  sessionDir: string;
  cliSessionId?: string;
  metadataMtimeMs: number;
}): Promise<number> {
  const observed = [
    options.metadataMtimeMs,
    await getFileMtime(join(options.sessionDir, 'audit.jsonl')),
    await getFileMtime(options.sessionDir),
  ];

  if (options.cliSessionId) {
    const transcriptPath = await findFile(
      options.sessionDir,
      `${options.cliSessionId}.jsonl`
    );
    if (transcriptPath) {
      observed.push(await getFileMtime(transcriptPath));
    }
  }

  return Math.max(
    ...observed.filter((mtime): mtime is number => mtime !== undefined)
  );
}

async function getFileMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function findClaudeMetadataFiles(root: string): Promise<string[]> {
  const stack = [root];
  const matches: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && /^local_.+\.json$/.test(entry.name)) {
        matches.push(path);
      } else if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }

  return matches;
}

function sessionMatchesMarker(
  session: SessionCandidate,
  trace: ClaudeTrace,
  marker: string
): boolean {
  if (session.metadata.initialMessage?.includes(marker)) {
    return true;
  }
  if (trace.finalAnswer?.includes(marker)) {
    return true;
  }
  return trace.rawText.includes(marker);
}

function sessionMatchesCorrelation(options: {
  session: SessionCandidate;
  trace: ClaudeTrace;
  marker: string;
  correlation?: ClientRunContext['correlation'];
  isNewOrUpdated: boolean;
  isRecent: boolean;
}): boolean {
  if (options.correlation?.includedInPrompt !== false) {
    return sessionMatchesMarker(options.session, options.trace, options.marker);
  }

  return options.isNewOrUpdated || options.isRecent;
}
