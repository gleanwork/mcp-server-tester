import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeChatOwnership } from './quitPrompt.js';

let root: string;
const since = Date.parse('2026-10-15T10:00:00Z');

async function rollout(
  name: string,
  {
    startedAt,
    user,
    ended,
  }: { startedAt: string; user: string; ended?: string }
) {
  const day = join(root, '2026', '10', '15');
  await mkdir(day, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { timestamp: startedAt } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: user }],
      },
    },
    ...(ended ? [{ type: 'event_msg', payload: { type: ended } }] : []),
  ];
  const path = join(day, `${name}.jsonl`);
  await writeFile(
    path,
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial'
  );
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-quit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('activeChatOwnership', () => {
  const queries = new Set(['Say done']);

  it('counts a mid-turn chat MST started in this run as owned', async () => {
    await rollout('mst', {
      startedAt: '2026-10-15T10:01:00Z',
      user: '  Say done\n',
    });
    expect(await activeChatOwnership(root, since, queries)).toEqual({
      active: 1,
      unowned: 0,
    });
  });

  it('ignores chats whose turn completed or aborted', async () => {
    await rollout('done', {
      startedAt: '2026-10-15T10:01:00Z',
      user: 'mine',
      ended: 'task_complete',
    });
    await rollout('aborted', {
      startedAt: '2026-10-15T10:01:00Z',
      user: 'mine',
      ended: 'turn_aborted',
    });
    expect(await activeChatOwnership(root, since, queries)).toEqual({
      active: 0,
      unowned: 0,
    });
  });

  it("treats other prompts, and chats begun before the launch, as not MST's", async () => {
    await rollout('other', {
      startedAt: '2026-10-15T10:01:00Z',
      user: 'my own question',
    });
    // An older chat someone resumed: written now, started before the launch.
    await rollout('resumed', {
      startedAt: '2026-10-15T09:00:00Z',
      user: 'Say done',
    });
    expect(await activeChatOwnership(root, since, queries)).toEqual({
      active: 2,
      unowned: 2,
    });
  });

  it('skips rollouts not written since the launch', async () => {
    const path = await rollout('stale', {
      startedAt: '2026-10-15T09:00:00Z',
      user: 'x',
    });
    const old = new Date(since - 60_000);
    await utimes(path, old, old);
    expect(await activeChatOwnership(root, since, queries)).toEqual({
      active: 0,
      unowned: 0,
    });
  });

  it('reports nothing for a missing sessions root', async () => {
    expect(
      await activeChatOwnership(join(root, 'missing'), since, queries)
    ).toEqual({ active: 0, unowned: 0 });
  });
});
