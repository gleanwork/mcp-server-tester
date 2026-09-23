import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { HostArtifact } from '../types.js';
import {
  snapshotChatgptSessions,
  type ChatgptSessionSnapshot,
} from './chatgptTrace.js';

export const CHATGPT_EVIDENCE_LIMITS = {
  fileBytes: 32 * 1024 * 1024,
  candidateFiles: 8,
  candidateBytes: 16 * 1024 * 1024,
};

export interface ChatgptEvidenceCopy {
  artifacts: HostArtifact[];
  limitations: string[];
  /** Set when a matched transcript was requested; false means it was not preserved. */
  matchedCopied?: boolean;
}

/**
 * Copy native transcripts into the uploaded evidence directory before the MST
 * profile is torn down. The matched transcript is the only accepted evidence;
 * fresh unmatched sessions are bounded, labeled UNVERIFIED, and never parsed.
 */
export async function copyChatgptEvidence(options: {
  evidenceDir: string;
  sessionsRoot: string;
  caseId: string;
  baseline?: ChatgptSessionSnapshot;
  matched?: { path: string; summary: string };
}): Promise<ChatgptEvidenceCopy> {
  const result: ChatgptEvidenceCopy = { artifacts: [], limitations: [] };
  let directory: string;
  try {
    const slug = options.caseId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
    directory = await mkdtemp(join(options.evidenceDir, `${slug || 'case'}-`));
  } catch {
    if (options.matched) result.matchedCopied = false;
    result.limitations.push('Native evidence directory is unavailable.');
    return result;
  }
  let root: string | undefined;
  try {
    root = await realpath(options.sessionsRoot);
  } catch {
    root = undefined;
  }
  if (options.matched) {
    try {
      if (!root) throw new Error();
      const copy = await copyOwned(
        options.matched.path,
        root,
        directory,
        'matched'
      );
      result.matchedCopied = true;
      result.artifacts.push({
        kind: 'transcript',
        name: 'ChatGPT native session',
        path: copy.path,
        contentType: 'application/x-ndjson',
        summary: `${options.matched.summary}; sha256=${copy.sha256}`,
      });
    } catch {
      result.matchedCopied = false;
      result.limitations.push(
        'The matched native transcript could not be preserved.'
      );
    }
  }
  if (!root || !options.baseline) return result;
  let current: ChatgptSessionSnapshot;
  try {
    current = await snapshotChatgptSessions(root);
  } catch {
    result.limitations.push('Fresh native sessions could not be listed.');
    return result;
  }
  const matched = options.matched
    ? await realpath(options.matched.path).catch(() => options.matched!.path)
    : undefined;
  // Baseline keys use the caller's sessionsRoot spelling; compare by relative path.
  const baseline = new Map(
    [...options.baseline].map(([path, info]) => [
      relative(options.sessionsRoot, path),
      info,
    ])
  );
  const candidates = [...current]
    .filter(([path, info]) => {
      if (path === matched) return false;
      const old = baseline.get(relative(root, path));
      return !old || old.size !== info.size || old.mtimeMs !== info.mtimeMs;
    })
    .map(([path]) => path)
    .sort();
  let bytes = 0;
  let skipped = 0;
  for (const [index, path] of candidates.entries()) {
    if (index >= CHATGPT_EVIDENCE_LIMITS.candidateFiles) {
      skipped++;
      continue;
    }
    try {
      const copy = await copyOwned(
        path,
        root,
        directory,
        `unverified-${index + 1}`,
        CHATGPT_EVIDENCE_LIMITS.candidateBytes - bytes
      );
      bytes += copy.size;
      result.artifacts.push({
        kind: 'metadata',
        name: `ChatGPT fresh native session ${index + 1} — UNVERIFIED`,
        path: copy.path,
        contentType: 'application/x-ndjson',
        summary: `Fresh unmatched session; not accepted as this query's trace, answer, or source count. sha256=${copy.sha256}`,
      });
    } catch {
      skipped++;
    }
  }
  if (skipped)
    result.limitations.push(
      `${skipped} fresh unmatched native session(s) were not preserved (bounded copy).`
    );
  return result;
}

async function copyOwned(
  source: string,
  root: string,
  directory: string,
  label: string,
  budget = CHATGPT_EVIDENCE_LIMITS.fileBytes
): Promise<{ path: string; sha256: string; size: number }> {
  const canonical = await realpath(source);
  const path = relative(root, canonical);
  if (!path || path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path))
    throw new Error('outside sessions root');
  const handle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let data: Buffer;
  try {
    const info = await handle.stat();
    const limit = Math.min(budget, CHATGPT_EVIDENCE_LIMITS.fileBytes);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.size > limit
    )
      throw new Error('unsafe source');
    data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, info.size, 0);
    data = data.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const sha256 = createHash('sha256').update(data).digest('hex');
  const target = join(directory, `${label}-${basename(source)}`);
  const output = await open(target, 'wx', 0o600);
  try {
    await output.writeFile(data);
  } finally {
    await output.close();
  }
  const written = await readFile(target);
  if (createHash('sha256').update(written).digest('hex') !== sha256)
    throw new Error('copy mismatch');
  return { path: target, sha256, size: data.length };
}
