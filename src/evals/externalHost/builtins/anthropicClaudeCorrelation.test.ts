import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeSession,
  waitForClaudeTrace,
} from './anthropicClaude.js';

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
it('matches only the exact initial prompt of a new recent session, never updated old sessions or answer echoes', async () => {
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
it('fails a missing binding without choosing an unrelated recent session', async () => {
  const f = await fixture();
  await f.session('wrong', 'different query');
  expect(
    await findMatchingClaudeSessions({
      dataDir: f.root,
      snapshot: new Map(),
      startedAtMs: f.startedAtMs,
      exactPrompt: f.prompt,
    })
  ).toEqual([]);
  await expect(
    waitForClaudeSession({
      dataDir: f.root,
      snapshot: new Map(),
      startedAtMs: f.startedAtMs,
      exactPrompt: f.prompt,
      timeoutMs: 0,
    })
  ).rejects.toThrow('No matching Claude session');
});
