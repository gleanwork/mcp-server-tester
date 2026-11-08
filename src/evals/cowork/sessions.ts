import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { POLL_INTERVAL_MS, delay, findFile } from './sessionFiles.js';
import { NativeTranscriptError } from '../nativeTranscriptError.js';
import {
  type ClaudeSessionBinding,
  type ClaudeSessionMetadata,
  type ClaudeTranscript,
  type SessionCandidate,
  metadataTimestampMs,
  parseClaudeTranscript,
} from './transcript.js';

const TRANSCRIPT_SETTLE_AFTER_COMPLETE_MS = 1_500;

/** The parts of a run's correlation that session matching reads. */
interface ClaudeSessionCorrelation {
  strategy: string;
  includedInPrompt: boolean;
}
interface SnapshotEntry {
  mtimeMs: number;
}

export type ClaudeSessionSnapshot = Map<string, SnapshotEntry>;

export function getClaudeDataDir(configuredDataDir?: string): string {
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
  correlation?: ClaudeSessionCorrelation;
  snapshot: ClaudeSessionSnapshot;
  startedAtMs: number;
  /**
   * Fresh-session correlation: the session the submission created. One whose
   * initial user text is exactly this binds; without one, the only new
   * session does (see `findMatchingClaudeSessions`). Never raw-text substring
   * matching.
   */
  exactPrompt?: string;
  sessionPath?: string;
  /** Bound pending transcript inspection; never submits or changes session identity. */
  onPending?: (transcript: ClaudeTranscript) => Promise<void>;
}

export async function waitForClaudeSession(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTranscript> {
  return waitForClaudeMatch(options, false);
}

export async function waitForClaudeTranscript(
  options: ClaudeSessionMatchOptions & { timeoutMs: number }
): Promise<ClaudeTranscript> {
  return waitForClaudeMatch(options, true);
}

async function waitForClaudeMatch(
  options: ClaudeSessionMatchOptions & { timeoutMs: number },
  requireCompletion: boolean
): Promise<ClaudeTranscript> {
  const deadline = Date.now() + options.timeoutMs;
  let lastPending: ClaudeTranscript | undefined;
  let completeTranscriptFirstSeenAtMs: number | undefined;
  // The only new session, seen on the previous poll without an exact match.
  let onlyNewSeen: string | undefined;

  while (Date.now() < deadline) {
    const matches = await findMatchingClaudeSessions(options);

    if (matches.length > 1) {
      throw new NativeTranscriptError(
        'ambiguous_matching_sessions',
        `Ambiguous Claude sessions for ${describeCorrelation(options)}: ${matches
          .map((m) => m.candidate.id)
          .join(', ')}`
      );
    }

    if (matches.length === 1) {
      const transcript = matches[0]!;
      // Bind the only new session only once it stayed the only one for a
      // poll: a second session appearing makes the binding ambiguous.
      if (
        !options.sessionPath &&
        transcript.binding?.kind === 'only-new-session' &&
        onlyNewSeen !== transcript.candidate.metadataPath
      ) {
        onlyNewSeen = transcript.candidate.metadataPath;
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      if (
        !requireCompletion ||
        isTranscriptReady(transcript, completeTranscriptFirstSeenAtMs)
      ) {
        return transcript;
      }
      if (
        transcript.isComplete &&
        completeTranscriptFirstSeenAtMs === undefined
      ) {
        completeTranscriptFirstSeenAtMs = Date.now();
      }
      lastPending = transcript;
      if (requireCompletion && !transcript.isComplete && options.onPending)
        await options.onPending(transcript);
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (lastPending) {
    throw new NativeTranscriptError(
      'timeout',
      `Timed out waiting for Claude session ${lastPending.candidate.id} to complete`
    );
  }

  throw new NativeTranscriptError(
    'no_matching_session',
    `No matching Claude session found for ${describeCorrelation(options)}`
  );
}

function isTranscriptReady(
  transcript: ClaudeTranscript,
  completeTranscriptFirstSeenAtMs: number | undefined
): boolean {
  if (!transcript.isComplete) {
    return false;
  }

  if (
    !transcript.candidate.metadata.cliSessionId ||
    transcript.transcriptParsed
  ) {
    return true;
  }

  return (
    completeTranscriptFirstSeenAtMs !== undefined &&
    Date.now() - completeTranscriptFirstSeenAtMs >=
      TRANSCRIPT_SETTLE_AFTER_COMPLETE_MS
  );
}

export async function findMatchingClaudeSessions(
  options: ClaudeSessionMatchOptions
): Promise<ClaudeTranscript[]> {
  const sessions = await listSessionCandidates(options.dataDir);
  const transcripts: ClaudeTranscript[] = [];
  // Fresh-session correlation: the sessions the submission could have created.
  const fresh: SessionCandidate[] = [];

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
      // Only sessions the submission created: existing ones remain excluded
      // even if they change. Do not match answers or tool output.
      if (
        previous !== undefined ||
        !isRecent ||
        createdAtMs > Date.now() + 5_000
      )
        continue;
      fresh.push(session);
      continue;
    }
    if (!isNewOrUpdated && !isRecent) {
      continue;
    }

    if (!options.marker && options.correlation?.includedInPrompt !== false)
      continue;
    const transcript = await parseClaudeTranscript(
      session,
      options.correlation?.includedInPrompt === false
        ? undefined
        : options.marker,
      LIVE_COLLECTION
    );
    if (
      sessionMatchesCorrelation({
        session,
        transcript,
        marker: options.marker ?? '',
        correlation: options.correlation,
        isNewOrUpdated,
        isRecent,
      })
    ) {
      transcripts.push(transcript);
    }
  }

  if (options.exactPrompt === undefined) return transcripts;
  return bindFreshSessions(fresh, options.exactPrompt);
}

/**
 * The fresh sessions a case binds: those whose initial message is exactly the
 * prompt; without one, the only fresh session, whatever Claude stored as its
 * prompt (it can drop a prompt's surrounding quotes, say). Several fresh
 * sessions without exactly one exact match are all returned: ambiguous.
 */
async function bindFreshSessions(
  fresh: readonly SessionCandidate[],
  prompt: string
): Promise<ClaudeTranscript[]> {
  const exact = fresh.filter((s) => s.metadata.initialMessage === prompt);
  const bound = exact.length > 0 ? exact : fresh;
  return Promise.all(
    bound.map(async (session) => ({
      ...(await parseClaudeTranscript(session, undefined, LIVE_COLLECTION)),
      binding: sessionBinding(session.metadata.initialMessage, prompt),
    }))
  );
}

function sessionBinding(
  stored: string | undefined,
  prompt: string
): ClaudeSessionBinding {
  if (stored === prompt) return { kind: 'exact-initial-prompt' };
  const text = stored ?? '';
  let i = 0;
  while (i < text.length && i < prompt.length && text[i] === prompt[i]) i++;
  return {
    kind: 'only-new-session',
    promptDifference: {
      storedChars: text.length,
      promptChars: prompt.length,
      firstDifferenceAt: i,
    },
  };
}

function describeCorrelation(options: ClaudeSessionMatchOptions): string {
  if (options.exactPrompt !== undefined)
    return 'a new native session after submission';
  if (options.correlation?.includedInPrompt) {
    return `marker ${options.marker}`;
  }
  return `${options.correlation?.strategy ?? 'none'} correlation near the run start`;
}

/** Collecting a trial: the session's files are still there. */
const LIVE_COLLECTION = { resolvePersistedOutputs: true } as const;

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
  transcript: ClaudeTranscript,
  marker: string
): boolean {
  if (session.metadata.initialMessage?.includes(marker)) {
    return true;
  }
  if (transcript.finalAnswer?.includes(marker)) {
    return true;
  }
  return transcript.rawText.includes(marker);
}

function sessionMatchesCorrelation(options: {
  session: SessionCandidate;
  transcript: ClaudeTranscript;
  marker: string;
  correlation?: ClaudeSessionCorrelation;
  isNewOrUpdated: boolean;
  isRecent: boolean;
}): boolean {
  if (options.correlation?.includedInPrompt !== false) {
    return sessionMatchesMarker(
      options.session,
      options.transcript,
      options.marker
    );
  }

  return options.isNewOrUpdated || options.isRecent;
}
