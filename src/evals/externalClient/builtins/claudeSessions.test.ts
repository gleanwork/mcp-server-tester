import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeSession,
  waitForClaudeTrace,
} from './claudeSessions.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-exact-prompt-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const startedAtMs = Date.now();
  const prompt = '  café\n重复 query  ';
  async function session(
    id: string,
    initialMessage: string | undefined = prompt,
    createdAt: string | undefined = new Date(startedAtMs).toISOString()
  ) {
    const name = `local_${id}`;
    await mkdir(join(root, name), { recursive: true });
    const metadataPath = join(root, `${name}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({ sessionId: name, initialMessage, createdAt })
    );
    await writeFile(
      join(root, name, 'audit.jsonl'),
      JSON.stringify({ type: 'result', result: prompt }) + '\n'
    );
    return metadataPath;
  }
  return { root, startedAtMs, prompt, session };
}
it('binds the exact initial prompt among new recent sessions, never updated old sessions or answer echoes', async () => {
  const f = await fixture();
  await f.session('old');
  const snapshot = await snapshotClaudeSessions(f.root);
  await f.session('old'); // Existing metadata changing is not a new submission.
  await f.session('unrelated', 'another prompt');
  await f.session('substring', 'prefix ' + f.prompt);
  await f.session('whitespace', f.prompt.trim());
  await f.session('unicode', f.prompt.normalize('NFD'));
  await f.session(
    'stale',
    f.prompt,
    new Date(f.startedAtMs - 60000).toISOString()
  );
  await f.session('bad-date', f.prompt, 'invalid');
  await f.session(
    'future',
    f.prompt,
    new Date(f.startedAtMs + 60000).toISOString()
  );
  const expected = await f.session('right');
  const matches = await findMatchingClaudeSessions({
    dataDir: f.root,
    snapshot,
    startedAtMs: f.startedAtMs,
    exactPrompt: f.prompt,
  });
  expect(matches.map((trace) => trace.candidate.metadataPath)).toEqual([
    expected,
  ]);
});
it('fails ambiguous prompt binding; fresh snapshots distinguish repeated prompts and pinned collection cannot switch sessions', async () => {
  const f = await fixture();
  const first = await f.session('first');
  const options = {
    dataDir: f.root,
    snapshot: new Map(),
    startedAtMs: f.startedAtMs,
    exactPrompt: f.prompt,
    timeoutMs: 1000,
  };
  expect((await waitForClaudeSession(options)).candidate.metadataPath).toBe(
    first
  );
  const nextSnapshot = await snapshotClaudeSessions(f.root);
  const second = await f.session('second');
  await expect(waitForClaudeSession(options)).rejects.toThrow('Ambiguous');
  expect(
    (await waitForClaudeSession({ ...options, snapshot: nextSnapshot }))
      .candidate.metadataPath
  ).toBe(second);
  expect(
    (await waitForClaudeTrace({ ...options, sessionPath: first })).candidate
      .metadataPath
  ).toBe(first);
});
it('binds the only new session when Claude changed its stored prompt, recording how, never the text', async () => {
  const f = await fixture();
  await f.session('old', 'another prompt');
  const snapshot = await snapshotClaudeSessions(f.root);
  const options = {
    dataDir: f.root,
    snapshot,
    startedAtMs: f.startedAtMs,
    exactPrompt: '"quoted prompt"',
    timeoutMs: 5000,
  };
  const only = await f.session('only', 'quoted prompt');
  const bound = await waitForClaudeSession(options);
  expect(bound.candidate.metadataPath).toBe(only);
  expect(bound.binding).toEqual({
    kind: 'only-new-session',
    promptDifference: {
      storedChars: 13,
      promptChars: 15,
      firstDifferenceAt: 0,
    },
  });
  // Collection pinned to it keeps it, though its text differs.
  expect(
    (await findMatchingClaudeSessions({ ...options, sessionPath: only })).map(
      (t) => t.candidate.metadataPath
    )
  ).toEqual([only]);
});
it('prefers an exact session, and fails two new sessions without one as ambiguous', async () => {
  const f = await fixture();
  const options = {
    dataDir: f.root,
    snapshot: new Map(),
    startedAtMs: f.startedAtMs,
    exactPrompt: f.prompt,
    timeoutMs: 2000,
  };
  await f.session('changed', 'changed prompt');
  const exact = await f.session('exact');
  const bound = await waitForClaudeSession(options);
  expect(bound.candidate.metadataPath).toBe(exact);
  expect(bound.binding).toEqual({ kind: 'exact-initial-prompt' });

  const g = await fixture();
  await g.session('one', 'changed prompt');
  await g.session('two', 'other changed prompt');
  await expect(
    waitForClaudeSession({ ...options, dataDir: g.root })
  ).rejects.toThrow('Ambiguous');
});
it('does not bind the only new session until it stayed the only one for a poll', async () => {
  const f = await fixture();
  await f.session('first', 'changed prompt');
  const waiting = waitForClaudeSession({
    dataDir: f.root,
    snapshot: new Map(),
    startedAtMs: f.startedAtMs,
    exactPrompt: f.prompt,
    timeoutMs: 3000,
  });
  // Appears before the next poll: neither can be the submission's for sure.
  await f.session('second', 'another changed prompt');
  await expect(waiting).rejects.toThrow('Ambiguous');
});
it('fails when no new session appeared, saying so', async () => {
  const f = await fixture();
  await f.session('old', 'different query');
  const snapshot = await snapshotClaudeSessions(f.root);
  await f.session(
    'stale',
    f.prompt,
    new Date(f.startedAtMs - 60000).toISOString()
  );
  expect(
    await findMatchingClaudeSessions({
      dataDir: f.root,
      snapshot,
      startedAtMs: f.startedAtMs,
      exactPrompt: f.prompt,
    })
  ).toEqual([]);
  await expect(
    waitForClaudeSession({
      dataDir: f.root,
      snapshot,
      startedAtMs: f.startedAtMs,
      exactPrompt: f.prompt,
      timeoutMs: 0,
    })
  ).rejects.toThrow(
    'No matching Claude session found for a new native session after submission'
  );
});
