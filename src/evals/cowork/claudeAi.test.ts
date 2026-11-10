import { describe, expect, it } from 'vitest';
import {
  claudeAiDebugPort,
  cloudAuditLines,
  cloudInitialMessage,
  cloudTrialMetadata,
} from './claudeAi.js';

describe('claude.ai session adapter', () => {
  it('validates the local Chrome debug port', () => {
    expect(claudeAiDebugPort({})).toBe(9222);
    expect(claudeAiDebugPort({ MST_CLAUDE_AI_DEBUG_PORT: '9334' })).toBe(9334);
    for (const value of ['0', '-1', '65536', 'abc', '1.5']) {
      expect(() =>
        claudeAiDebugPort({ MST_CLAUDE_AI_DEBUG_PORT: value })
      ).toThrow();
    }
  });

  it('binds only to the initial client prompt, not a tool result or subagent', () => {
    expect(
      cloudInitialMessage([
        {
          source: 'server',
          payload: {
            type: 'user',
            message: { role: 'user', content: 'not the prompt' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            shouldQuery: false,
            message: { role: 'user', content: 'tool response' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            parent_tool_use_id: 'child',
            message: { role: 'user', content: 'child prompt' },
          },
        },
        {
          source: 'client',
          payload: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'exact' },
                { type: 'image' },
                { type: 'text', text: 'prompt' },
              ],
            },
          },
        },
      ])
    ).toBe('exact\nprompt');
    expect(cloudInitialMessage([])).toBeUndefined();
  });

  it('binds a prewarmed session by its first submitted prompt, not VM creation time', () => {
    const session = {
      id: 'cse_draft',
      created_at: '2026-11-09T19:15:15Z',
      last_event_at: '2026-11-09T19:18:43Z',
    };
    const events = [
      {
        source: 'client',
        created_at: '2026-11-09T19:18:36Z',
        payload: {
          type: 'user',
          message: { role: 'user', content: 'smoke prompt' },
        },
      },
    ];
    expect(
      cloudTrialMetadata(session, events, Date.parse('2026-11-09T19:17:43Z'))
    ).toMatchObject({
      sessionId: 'cse_draft',
      cloudCreatedAt: '2026-11-09T19:15:15Z',
      createdAt: '2026-11-09T19:18:36Z',
      initialMessage: 'smoke prompt',
    });
    // An old conversation must not become a new trial because it was updated.
    expect(
      cloudTrialMetadata(session, events, Date.parse('2026-11-09T19:20:00Z'))
    ).toBeUndefined();
    expect(
      cloudTrialMetadata(session, [], Date.parse('2026-11-09T19:17:43Z'))
    ).toBeUndefined();
    expect(
      cloudTrialMetadata(
        session,
        [{ ...events[0], created_at: undefined }],
        Date.parse('2026-11-09T19:17:43Z')
      )
    ).toBeUndefined();
  });

  it('does not treat setup-only results as completion of the submitted prompt', () => {
    const setup = {
      source: 'client',
      payload: {
        type: 'user',
        uuid: 'setup',
        shouldQuery: false,
        message: { role: 'user', content: 'setup context' },
      },
    };
    const prompt = {
      source: 'client',
      payload: {
        type: 'user',
        uuid: 'prompt',
        message: { role: 'user', content: 'smoke prompt' },
      },
    };
    const warmup = {
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        user_message_uuids: ['setup'],
      },
    };
    const completion = {
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'MST_1P_SMOKE_OK',
        user_message_uuids: ['prompt'],
      },
    };
    const results = (events: Parameters<typeof cloudAuditLines>[0]) =>
      cloudAuditLines(events)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === 'result');
    expect(results([setup, prompt, warmup])).toEqual([]);
    expect(results([setup, prompt, warmup, completion])).toEqual([
      completion.payload,
    ]);
    const failure = {
      payload: {
        ...warmup.payload,
        is_error: true,
        subtype: 'error_during_execution',
      },
    };
    expect(results([setup, prompt, failure])).toEqual([failure.payload]);
    const mixed = {
      payload: { ...warmup.payload, user_message_uuids: ['setup', 'prompt'] },
    };
    expect(results([setup, prompt, mixed])).toEqual([mixed.payload]);
    // Do not discard an uncorrelated result merely because it is empty.
    expect(results([warmup])).toEqual([warmup.payload]);
  });

  it('preserves audit payloads and uses the cloud receipt time only as a fallback', () => {
    const rows = cloudAuditLines([
      {
        created_at: '2026-11-09T00:00:00Z',
        payload: {
          type: 'assistant',
          message: { role: 'assistant', content: 'MST_1P_SMOKE_OK' },
        },
      },
      {
        created_at: 'later',
        payload: {
          type: 'result',
          timestamp: 'original',
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { created_at: 'ignored' },
    ])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      timestamp: '2026-11-09T00:00:00Z',
      message: { content: 'MST_1P_SMOKE_OK' },
    });
    expect(rows[1]).toMatchObject({
      timestamp: 'original',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
});
