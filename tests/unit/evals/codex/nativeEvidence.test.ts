import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCodexNativeToolResults,
  baselineCodexNativeState,
  CODEX_DESKTOP_BUILD,
  collectCodexNativeEvidence,
  type NativeToolResultWitness,
} from '../../../../src/evals/codex/nativeEvidence.js';
import {
  prepareCodexProfile,
  type CodexProfile,
} from '../../../../src/evals/codex/profile.js';
import type { HostEvent } from '../../../../src/evals/evalFrameworkTypes.js';

const workspace = '/private/tmp/codex-owned-workspace';
const prompt = 'Find desktop_records in desktop_decoy.';
const threadId = 'thread-1';
const turnId = 'turn-1';
const promptSha256 = createHash('sha256').update(prompt).digest('hex');
const result = {
  content: [
    { type: 'text', text: 'native answer', fixtureExtension: 'preserved' },
  ],
  isError: false,
};

interface Fixture {
  profile: CodexProfile;
  state: DatabaseSync;
  history: DatabaseSync;
}

const fixtures: Fixture[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.history.close();
    fixture.state.close();
  }
  return Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

describe('Codex native SQLite evidence', () => {
  it('qualifies one exact new desktop thread and normalizes the pinned build newline', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    const collection = await collectCodexNativeEvidence(
      fixture.profile,
      baseline,
      request(fixture.profile.id)
    );
    expect(collection.evidence).toMatchObject({
      qualification: 'qualified',
      appVersion: CODEX_DESKTOP_BUILD,
      sessionId: threadId,
      workspace,
      promptSha256,
      terminal: true,
    });
    expect(collection.evidence.trace).toEqual({
      finalText: 'native answer',
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          server: 'desktop_records',
          name: 'lookup_record',
          arguments: { reference: 'A' },
          output: JSON.stringify(result),
          id: 'mcp-1',
        },
      ],
    });
  });

  it('fails closed for an unsupported app build before native qualification', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    const collection = await collectCodexNativeEvidence(
      fixture.profile,
      baseline,
      {
        ...request(fixture.profile.id),
        appVersion: 'unknown-build',
      }
    );
    expect(collection.evidence.qualification).toBe('unqualified');
    expect(collection.evidence.trace).toBeUndefined();
  });

  it('fails closed for duplicate new workspace threads and unsupported item types', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    insertThreadRow(fixture, 'thread-2');
    expect(
      (
        await collectCodexNativeEvidence(
          fixture.profile,
          baseline,
          request(fixture.profile.id)
        )
      ).evidence.reason
    ).toMatch(/Multiple/);

    const isolated = await createFixture();
    const isolatedBaseline = await baselineCodexNativeState(
      isolated.profile,
      workspace
    );
    insertValidThread(isolated, 'unsupported');
    insertItem(isolated.history, {
      threadId: 'unsupported',
      turnId,
      itemId: 'unsupported-item',
      ordinal: 4,
      itemType: 'unsupportedItem',
      item: { type: 'unsupportedItem' },
    });
    const unsupported = await collectCodexNativeEvidence(
      isolated.profile,
      isolatedBaseline,
      request(isolated.profile.id)
    );
    expect(unsupported.evidence.qualification).toBe('unqualified');
    expect(unsupported.evidence.trace).toBeUndefined();
  });

  it('rejects duplicate item IDs', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    removeThreadItemPrimaryKey(fixture.history);
    insertValidThread(fixture);
    fixture.history
      .prepare(
        `UPDATE thread_items SET rollout_ordinal = 4
          WHERE item_id = ?`
      )
      .run(`${threadId}-assistant`);
    fixture.history
      .prepare(
        `UPDATE thread_turns SET rollout_end_ordinal = 4
          WHERE thread_id = ? AND turn_id = ?`
      )
      .run(threadId, turnId);
    insertItem(fixture.history, {
      threadId,
      turnId,
      itemId: 'mcp-1',
      ordinal: 3,
      itemType: 'reasoning',
      item: { type: 'reasoning' },
    });

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('unqualified');
    expect(evidence.reason).toMatch(/identity/);
  });

  it('rejects duplicate item ordinals and non-strict item row order', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    insertItem(fixture.history, {
      threadId,
      turnId,
      itemId: 'reasoning-1',
      ordinal: 2,
      itemType: 'reasoning',
      item: { type: 'reasoning' },
    });

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('unqualified');
    expect(evidence.reason).toMatch(/identity|order/);
  });

  it('rejects items outside turn bounds', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    fixture.history
      .prepare(`UPDATE thread_items SET rollout_ordinal = 0 WHERE item_id = ?`)
      .run('mcp-1');

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('unqualified');
    expect(evidence.reason).toMatch(/turn bounds/);
  });

  it('rejects MCP calls that do not occur after the user and before the final answer', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    fixture.history
      .prepare(
        `UPDATE thread_items
            SET rollout_ordinal = CASE item_id WHEN ? THEN 2 WHEN 'mcp-1' THEN 1 END
          WHERE item_id IN (?, 'mcp-1')`
      )
      .run(`${threadId}-user`, `${threadId}-user`);

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('unqualified');
    expect(evidence.reason).toMatch(/terminal item provenance/);
  });

  it('allows known nonterminal commentary before tools and rejects unknown assistant phases', async () => {
    for (const [phase, qualification] of [
      ['commentary', 'qualified'],
      ['analysis', 'unqualified'],
    ] as const) {
      const fixture = await createFixture();
      const baseline = await baselineCodexNativeState(
        fixture.profile,
        workspace
      );
      insertValidThread(fixture);
      fixture.history.exec(`
        UPDATE thread_items SET rollout_ordinal = 3 WHERE item_id = 'mcp-1';
        UPDATE thread_items SET rollout_ordinal = 4 WHERE item_id = '${threadId}-assistant';
        UPDATE thread_turns SET rollout_end_ordinal = 5
          WHERE thread_id = '${threadId}' AND turn_id = '${turnId}';
      `);
      insertItem(fixture.history, {
        threadId,
        turnId,
        itemId: `${threadId}-${phase}`,
        ordinal: 2,
        itemType: 'agentMessage',
        item: { type: 'agentMessage', phase, text: 'synthetic commentary' },
      });

      expect((await collectEvidence(fixture, baseline)).qualification).toBe(
        qualification
      );
    }
  });

  it('accepts terminal rollout events after the final persisted item', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    fixture.history
      .prepare(
        `UPDATE thread_turns SET rollout_end_ordinal = 4
          WHERE thread_id = ? AND turn_id = ?`
      )
      .run(threadId, turnId);

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('qualified');
  });

  it('requires selected columns in threads, thread_turns, and thread_items', async () => {
    const missingThreadColumn = await createFixture();
    missingThreadColumn.state.exec(
      'ALTER TABLE threads DROP COLUMN thread_source'
    );
    await expect(
      baselineCodexNativeState(missingThreadColumn.profile, workspace)
    ).rejects.toThrow(/state SQLite schema/);

    for (const [table, column] of [
      ['thread_turns', 'rollout_end_ordinal'],
      ['thread_items', 'item_type'],
    ] as const) {
      const fixture = await createFixture();
      const baseline = await baselineCodexNativeState(
        fixture.profile,
        workspace
      );
      insertValidThread(fixture);
      fixture.history.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      const evidence = await collectEvidence(fixture, baseline);
      expect(evidence.qualification).toBe('unqualified');
      expect(evidence.reason).toMatch(/thread-history SQLite schema/);
    }
  });

  it('allows extra columns in native evidence tables', async () => {
    const fixture = await createFixture();
    fixture.state.exec('ALTER TABLE threads ADD COLUMN extra_state TEXT');
    fixture.history.exec('ALTER TABLE thread_turns ADD COLUMN extra_turn TEXT');
    fixture.history.exec('ALTER TABLE thread_items ADD COLUMN extra_item TEXT');
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('qualified');
  });

  it('keeps NOT_FOUND as a tool output with isError true', async () => {
    const fixture = await createFixture();
    const baseline = await baselineCodexNativeState(fixture.profile, workspace);
    insertValidThread(fixture);
    replaceMcpItem(
      fixture.history,
      {
        content: [{ type: 'text', text: 'NOT_FOUND' }],
      },
      'failed'
    );

    const evidence = await collectEvidence(fixture, baseline);
    expect(evidence.qualification).toBe('qualified');
    if (evidence.qualification !== 'qualified') return;
    expect(evidence.trace.events[0]).toMatchObject({
      output: JSON.stringify({
        content: [{ type: 'text', text: 'NOT_FOUND' }],
        isError: true,
      }),
    });
    expect(evidence.trace.events[0]?.error).toBeUndefined();
  });

  it('requires native call status to match the complete tool result', async () => {
    for (const [status, isError] of [
      ['failed', false],
      ['completed', true],
    ] as const) {
      const fixture = await createFixture();
      const baseline = await baselineCodexNativeState(
        fixture.profile,
        workspace
      );
      insertValidThread(fixture);
      replaceMcpItem(
        fixture.history,
        {
          content: [{ type: 'text', text: 'synthetic' }],
          isError,
        },
        status
      );
      expect((await collectEvidence(fixture, baseline)).qualification).toBe(
        'unqualified'
      );
    }
  });

  it('compares complete native result and error payloads with the independent ledger', () => {
    const events: HostEvent[] = [
      {
        kind: 'tool_call',
        source: 'mcp',
        server: 'desktop_records',
        name: 'lookup_record',
        arguments: { reference: 'A' },
        output: JSON.stringify(result),
        id: 'mcp-1',
      },
    ];
    const witness: NativeToolResultWitness = {
      server: 'desktop_records',
      name: 'lookup_record',
      arguments: { reference: 'A' },
      result,
    };
    expect(() => assertCodexNativeToolResults(events, [witness])).not.toThrow();
    expect(() =>
      assertCodexNativeToolResults(events, [
        {
          ...witness,
          result: {
            content: result.content,
            _meta: null,
          },
        },
      ])
    ).not.toThrow();
    expect(() =>
      assertCodexNativeToolResults(events, [
        { ...witness, result: { ...result, isError: true } },
      ])
    ).toThrow(/result/);
    expect(() =>
      assertCodexNativeToolResults(events, [
        {
          ...witness,
          result: { ...result, _meta: { preserved: true } },
        },
      ])
    ).toThrow(/result/);
    expect(() =>
      assertCodexNativeToolResults(
        [{ ...events[0]!, output: undefined, error: '{"code":"FAILED"}' }],
        [
          {
            server: 'desktop_records',
            name: 'lookup_record',
            arguments: { reference: 'A' },
            error: { code: 'FAILED' },
          },
        ]
      )
    ).not.toThrow();
  });
});

function request(profileId: string) {
  return {
    profileId,
    appVersion: CODEX_DESKTOP_BUILD,
    workspace,
    promptSha256,
    servers: ['desktop_records', 'desktop_decoy'],
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-test-'));
  roots.push(root);
  const profile = await prepareCodexProfile(join(root, 'profile'));
  await mkdir(join(profile.paths.codex, 'sessions'), { mode: 0o700 });
  const statePath = join(profile.paths.codex, 'state_5.sqlite');
  const historyPath = join(profile.paths.codex, 'thread_history_1.sqlite');
  const state = new DatabaseSync(statePath);
  const history = new DatabaseSync(historyPath);
  state.exec('PRAGMA journal_mode=WAL;');
  history.exec('PRAGMA journal_mode=WAL;');
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL,
      has_user_event INTEGER NOT NULL, thread_source TEXT
    );
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE thread_dynamic_tools (
      thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position)
    );
  `);
  history.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL, first_user_item_id TEXT, final_agent_item_id TEXT,
      rollout_end_ordinal INTEGER, PRIMARY KEY(thread_id, turn_id)
    );
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL,
      PRIMARY KEY(thread_id, turn_id, item_id)
    );
  `);
  const fixture = { profile, state, history };
  fixtures.push(fixture);
  return fixture;
}

function insertValidThread(fixture: Fixture, id = threadId): void {
  insertThreadRow(fixture, id);
  fixture.history
    .prepare(
      `INSERT INTO thread_turns
       (thread_id, turn_id, rollout_ordinal, status, first_user_item_id,
        final_agent_item_id, rollout_end_ordinal)
       VALUES (?, ?, 1, 'completed', ?, ?, 3)`
    )
    .run(id, turnId, `${id}-user`, `${id}-assistant`);
  insertItem(fixture.history, {
    threadId: id,
    turnId,
    itemId: `${id}-user`,
    ordinal: 1,
    itemType: 'userMessage',
    item: {
      type: 'userMessage',
      content: [
        {
          type: 'text',
          text: prompt.replaceAll('_', `${String.fromCharCode(92)}_`) + '\n',
          text_elements: [],
        },
      ],
    },
  });
  insertItem(fixture.history, {
    threadId: id,
    turnId,
    itemId: 'mcp-1',
    ordinal: 2,
    itemType: 'mcpToolCall',
    item: {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'desktop_records',
      tool: 'lookup_record',
      status: 'completed',
      arguments: { reference: 'A' },
      result: { content: result.content, _meta: null },
      error: null,
    },
  });
  insertItem(fixture.history, {
    threadId: id,
    turnId,
    itemId: `${id}-assistant`,
    ordinal: 3,
    itemType: 'agentMessage',
    item: {
      type: 'agentMessage',
      id: `${id}-assistant`,
      text: 'native answer',
      phase: 'final_answer',
    },
  });
}

async function collectEvidence(
  fixture: Fixture,
  baseline: Awaited<ReturnType<typeof baselineCodexNativeState>>
) {
  return (
    await collectCodexNativeEvidence(
      fixture.profile,
      baseline,
      request(fixture.profile.id)
    )
  ).evidence;
}

function removeThreadItemPrimaryKey(history: DatabaseSync): void {
  history.exec(`
    ALTER TABLE thread_items RENAME TO original_thread_items;
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL
    );
    DROP TABLE original_thread_items;
  `);
}

function replaceMcpItem(
  history: DatabaseSync,
  toolResult: Record<string, unknown>,
  status: 'completed' | 'failed' = 'completed'
): void {
  history
    .prepare(
      `UPDATE thread_items SET item_json = ?
        WHERE thread_id = ? AND turn_id = ? AND item_id = 'mcp-1'`
    )
    .run(
      JSON.stringify({
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'desktop_records',
        tool: 'lookup_record',
        status,
        arguments: { reference: 'A' },
        result: toolResult,
        error: null,
      }),
      threadId,
      turnId
    );
}

function insertThreadRow(fixture: Fixture, id: string): void {
  fixture.state
    .prepare(
      `INSERT INTO threads
       (id, rollout_path, created_at_ms, updated_at_ms, source, cwd, has_user_event)
       VALUES (?, ?, 1, 2, 'vscode', ?, 1)`
    )
    .run(
      id,
      `${fixture.profile.paths.codex}/sessions/2026/rollout-${id}.jsonl`,
      workspace
    );
}

function insertItem(
  history: DatabaseSync,
  value: {
    threadId: string;
    turnId: string;
    itemId: string;
    ordinal: number;
    itemType: string;
    item: Record<string, unknown>;
  }
): void {
  history
    .prepare(
      `INSERT INTO thread_items
       (thread_id, turn_id, item_id, rollout_ordinal, item_json, item_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      value.threadId,
      value.turnId,
      value.itemId,
      value.ordinal,
      JSON.stringify(value.item),
      value.itemType
    );
}
