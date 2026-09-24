import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyChatgptEvidence } from './chatgptEvidence.js';

let root: string;
let sessions: string;
let evidence: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mst-evidence-')));
  sessions = join(root, '.codex', 'sessions', '2026', '09', '23');
  evidence = join(root, 'evidence');
  await mkdir(sessions, { recursive: true });
  await mkdir(evidence, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('ChatGPT native evidence copy', () => {
  it('copies only the matched transcript, never other sessions', async () => {
    const sessionsRoot = join(root, '.codex', 'sessions');
    await writeFile(join(sessions, 'rollout-match.jsonl'), 'match\n');
    await writeFile(join(sessions, 'rollout-other.jsonl'), 'other\n');
    const copy = await copyChatgptEvidence({
      evidenceDir: evidence,
      sessionsRoot,
      caseId: 'case/../1',
      matched: {
        path: join(sessions, 'rollout-match.jsonl'),
        summary: 'Matched turn t',
      },
    });
    expect(copy.matchedCopied).toBe(true);
    expect(copy.limitations).toEqual([]);
    expect(copy.artifacts).toEqual([
      expect.objectContaining({
        kind: 'transcript',
        summary: `Matched turn t; sha256=${sha('match\n')}`,
      }),
    ]);
    expect(copy.artifacts[0]!.path!.startsWith(`${evidence}/case_.._1-`)).toBe(
      true
    );
    expect(await readFile(copy.artifacts[0]!.path!, 'utf8')).toBe('match\n');
    const [directory] = await readdir(evidence);
    expect(await readdir(join(evidence, directory!))).toEqual([
      'matched-rollout-match.jsonl',
    ]);
  });

  it('refuses symlinked or out-of-root transcripts and reports a missing match', async () => {
    const sessionsRoot = join(root, '.codex', 'sessions');
    await writeFile(join(root, 'private.jsonl'), 'private\n');
    await symlink(
      join(root, 'private.jsonl'),
      join(sessions, 'rollout-link.jsonl')
    );
    const copy = await copyChatgptEvidence({
      evidenceDir: evidence,
      sessionsRoot,
      caseId: 'c',
      matched: { path: join(root, 'private.jsonl'), summary: 'x' },
    });
    expect(copy.matchedCopied).toBe(false);
    expect(copy.artifacts).toEqual([]);
    expect(JSON.stringify(copy)).not.toContain('private\\n');
  });

  it('fails the matched copy when the evidence directory is unavailable', async () => {
    const copy = await copyChatgptEvidence({
      evidenceDir: join(root, 'missing'),
      sessionsRoot: join(root, '.codex', 'sessions'),
      caseId: 'c',
      matched: { path: join(sessions, 'rollout-x.jsonl'), summary: 'x' },
    });
    expect(copy).toMatchObject({ matchedCopied: false, artifacts: [] });
  });
});
