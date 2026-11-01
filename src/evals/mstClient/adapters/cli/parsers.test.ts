import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStreamJson,
  createJsonParser,
  LineClock,
  claudeTranscriptModelCalls,
} from './parsers.js';
import { withFinalUsage } from '../../../claudeCodeEvents.js';

describe('parseStreamJson and large tool results', () => {
  it('reads back a result Claude Code saved in the config directory MST made', () => {
    const config = mkdtempSync(join(tmpdir(), 'mst-claude-'));
    try {
      const dir = join(config, 'projects', 'p', 's', 'tool-results');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'toolu_1.json');
      writeFileSync(file, 'FULL RESULT');
      const placeholder = `<persisted-output>\nOutput too large (60KB). Full output saved to: ${file}\n\nPreview (first 2KB):\nFULL\n...\n</persisted-output>`;
      const stdout = [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'mcp__s__search',
                input: {},
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: placeholder,
              },
            ],
          },
        },
        { type: 'result', result: 'done' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
      const result = parseStreamJson(stdout);
      expect(result.toolCalls?.[0]?.output).toBe('FULL RESULT');
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });
});

describe('parseStreamJson', () => {
  it('parses valid NDJSON with tool_use blocks', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'search',
              id: 'call_1',
              input: { query: 'test' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'Search completed successfully',
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: 'search',
      source: 'builtin',
      rawName: 'search',
      arguments: { query: 'test' },
      id: 'call_1',
    });
  });

  it('parses text blocks', () => {
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.response).toBe('Hello world');
  });

  it('skips non-JSON lines', () => {
    const stdout = [
      'debug: starting up',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'response' }],
        },
      }),
      'another debug line',
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.response).toBe('response');
  });

  it('handles error events', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Something went wrong',
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });

  it('handles error events with non-string result', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toBe('CLI client reported an error');
    // Claude Code didn't say why: the client app failed.
    expect(result.ending).toMatchObject({
      kind: 'infrastructure',
      broke: 'client-app',
    });
  });

  // How an error result ended (ADR 0010). `acted`: the model answered first.
  it.each([
    [{ subtype: 'error_max_turns' }, true, { kind: 'trial' }],
    [{ subtype: 'error_max_budget_usd' }, true, { kind: 'trial' }],
    [{ result: 'Prompt is too long' }, true, { kind: 'trial' }],
    [
      { result: 'Prompt is too long' },
      false,
      { kind: 'infrastructure', broke: 'setup', retryable: false },
    ],
    [
      { result: 'API Error: 429 rate_limit_error' },
      true,
      { kind: 'infrastructure', broke: 'provider', retryable: true },
    ],
    [
      { result: 'API Error: 500 Internal server error' },
      true,
      { kind: 'infrastructure', broke: 'provider', retryable: true },
    ],
    [
      { result: 'Invalid API key · Please run /login' },
      false,
      { kind: 'infrastructure', broke: 'setup', retryable: false },
    ],
    [
      { subtype: 'error_during_execution' },
      true,
      { kind: 'infrastructure', broke: 'client-app', retryable: true },
    ],
  ])('types the error result %j (acted: %s)', (fields, acted, expected) => {
    const lines = [
      ...(acted
        ? [
            {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Looking.' }] },
            },
          ]
        : []),
      { type: 'result', is_error: true, ...fields },
    ];
    const result = parseStreamJson(
      lines.map((line) => JSON.stringify(line)).join('\n')
    );
    expect(result.success).toBe(false);
    expect(result.ending).toMatchObject(expected);
  });

  it('handles missing fields gracefully', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'assistant' }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBeUndefined();
  });

  it('strips mcp__servername__toolname prefix to just toolname', () => {
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__myserver__search',
            input: { q: 'hello' },
          },
        ],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('preserves tool names that do not match the mcp__ prefix', () => {
    const stdout = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'plain_tool', input: {} }],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.toolCalls[0]!.name).toBe('plain_tool');
  });

  it('parses result events as fallback response', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'Final answer from CLI',
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.response).toBe('Final answer from CLI');
  });

  it('does not overwrite text blocks with result event', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'From text block' }],
        },
      }),
      JSON.stringify({ type: 'result', result: 'From result event' }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.response).toBe('From text block');
  });

  it('returns empty result for empty input', () => {
    const result = parseStreamJson('');
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBeUndefined();
  });

  it('extracts usage metrics from result event', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'Hello',
        usage: {
          input_tokens: 150,
          output_tokens: 42,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        total_cost_usd: 0.0035,
        duration_ms: 2500,
        duration_api_ms: 1800,
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 42,
      totalCostUsd: 0.0035,
      durationMs: 2500,
      durationApiMs: 1800,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
    });
  });

  it("reads a result's thinking tokens as its reasoning output tokens", () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'Hello',
      usage: {
        input_tokens: 150,
        output_tokens: 42,
        output_tokens_details: { thinking_tokens: 30 },
      },
      modelUsage: { 'claude-opus-4-8': { thinkingTokens: 30 } },
    });
    expect(parseStreamJson(stdout).usage).toMatchObject({
      outputTokens: 42,
      reasoningOutputTokens: 30,
    });
  });

  it('extracts usage metrics from error result event', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Something went wrong',
      usage: { input_tokens: 50, output_tokens: 0 },
      total_cost_usd: 0.001,
      duration_ms: 500,
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 0,
      totalCostUsd: 0.001,
      durationMs: 500,
      durationApiMs: undefined,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });

  it('returns undefined usage when result event has no usage field', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'No usage info',
    });

    const result = parseStreamJson(stdout);
    expect(result.success).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  it('keeps orphan tool_result inline in conversationHistory (no matching call)', () => {
    const stdout = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'tool output here' }],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.conversationHistory).toHaveLength(1);
    expect(result.conversationHistory![0]).toEqual({
      role: 'tool',
      content: 'tool output here',
    });
  });

  it('stores output on the matching call and references it by id in the transcript', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'search',
              id: 'call_1',
              input: { query: 'abcd' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '{"abc":"xyz"}',
            },
          ],
        },
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    // Payload stored once, on the call.
    expect(result.toolCalls[0]).toEqual({
      name: 'search',
      source: 'builtin',
      rawName: 'search',
      arguments: { query: 'abcd' },
      id: 'call_1',
      output: '{"abc":"xyz"}',
    });
    // Transcript references the call by id, without duplicating the payload.
    expect(result.conversationHistory![0]).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
    });
  });

  it('serializes object tool_result content as JSON onto the call', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'search', id: 'c1', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: { abc: 'xyz' } },
          ],
        },
      }),
    ].join('\n');

    const result = parseStreamJson(stdout);
    expect(result.toolCalls[0]!.output).toBe('{"abc":"xyz"}');
  });

  it('leaves output undefined when tool_result has no matching tool_use_id', () => {
    const stdout = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'orphan output' }],
      },
    });

    const result = parseStreamJson(stdout);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.conversationHistory).toHaveLength(1);
  });
});

describe('createJsonParser', () => {
  it('parses valid JSON with tool calls', () => {
    const parser = createJsonParser({
      toolCalls: 'toolCalls',
      response: 'response',
      success: 'success',
    });

    const stdout = JSON.stringify({
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
      response: 'Found results',
    });

    const result = parser(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
    expect(result.response).toBe('Found results');
  });

  it('handles missing fields gracefully', () => {
    const parser = createJsonParser({
      toolCalls: 'data.calls',
      response: 'data.text',
    });

    const stdout = JSON.stringify({ data: {} });

    const result = parser(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.response).toBeUndefined();
  });

  it('defaults success to true when no success path is provided', () => {
    const parser = createJsonParser({
      toolCalls: 'toolCalls',
      response: 'response',
    });

    const stdout = JSON.stringify({
      toolCalls: [],
      response: 'hello',
    });

    const result = parser(stdout);
    expect(result.success).toBe(true);
  });

  it('supports custom nested paths', () => {
    const parser = createJsonParser({
      toolCalls: 'output.actions',
      response: 'output.message',
      success: 'output.ok',
    });

    const stdout = JSON.stringify({
      output: {
        ok: true,
        actions: [{ name: 'fetch', args: { url: 'http://example.com' } }],
        message: 'Done',
      },
    });

    const result = parser(stdout);
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('fetch');
    expect(result.response).toBe('Done');
  });

  it('uses args as fallback for arguments', () => {
    const parser = createJsonParser({
      toolCalls: 'toolCalls',
      response: 'response',
    });

    const stdout = JSON.stringify({
      toolCalls: [{ name: 'tool1', args: { key: 'value' } }],
      response: 'ok',
    });

    const result = parser(stdout);
    expect(result.toolCalls[0]!.arguments).toEqual({ key: 'value' });
  });
});

describe('parseStreamJson with line times', () => {
  // Claude Code writes one assistant event per content block of a message,
  // each with the message's ID and its usage so far.
  const lines = [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-x',
        usage: { input_tokens: 10, output_tokens: 1 },
        content: [{ type: 'text', text: 'Adding. ' }],
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-x',
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          cache_read_input_tokens: 90,
        },
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp__math__add',
            input: { a: 1, b: 2 },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '3' },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_2',
        model: 'claude-x',
        usage: { input_tokens: 12, output_tokens: 2 },
        content: [{ type: 'text', text: '3' }],
      },
    },
    { type: 'result', subtype: 'success', result: '3' },
  ];
  const stdout = lines.map((line) => JSON.stringify(line)).join('\n');
  const at = (seconds: number) => Date.UTC(2026, 9, 22, 12, 0, seconds);
  const iso = (seconds: number) => new Date(at(seconds)).toISOString();

  it('times tool calls and model requests from when each line arrived', () => {
    const result = parseStreamJson(stdout, [0, 2, 3, 5, 6, 6].map(at));
    expect(result.toolCalls[0]).toMatchObject({
      id: 'toolu_1',
      startedAt: iso(3),
      completedAt: iso(5),
      durationMs: 2_000,
    });
    expect(result.modelCalls).toEqual([
      {
        id: 'msg_1',
        model: 'claude-x',
        startedAt: iso(0),
        completedAt: iso(3),
        durationMs: 3_000,
        inputTokens: 10,
        outputTokens: 7,
        cacheReadInputTokens: 90,
        finishReason: 'tool_use',
        text: 'Adding. ',
        toolCallIds: ['toolu_1'],
      },
      {
        id: 'msg_2',
        model: 'claude-x',
        startedAt: iso(5),
        completedAt: iso(6),
        durationMs: 1_000,
        inputTokens: 12,
        outputTokens: 2,
        text: '3',
      },
    ]);
  });

  it('reports model requests without times when it has none, or the wrong number', () => {
    for (const times of [undefined, [at(0)]]) {
      const result = parseStreamJson(stdout, times);
      expect(result.toolCalls[0]!.startedAt).toBeUndefined();
      expect(result.modelCalls?.map((call) => call.id)).toEqual([
        'msg_1',
        'msg_2',
      ]);
      expect(result.modelCalls?.[0]!.startedAt).toBeUndefined();
    }
  });
});

describe('LineClock', () => {
  it('times each non-blank line when the chunk that ends it arrives', () => {
    let now = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const clock = new LineClock();
      clock.push('{"a":');
      now = 2_000;
      clock.push(Buffer.from('1}\n\n{"b":2}\n{"c"'));
      now = 3_000;
      clock.push(':3}');
      now = 4_000;
      expect(clock.end()).toEqual([2_000, 2_000, 4_000]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Claude Code's final usage", () => {
  it('reads it from the session transcripts in the config directory, and keeps the stream times', () => {
    const config = mkdtempSync(join(tmpdir(), 'mst-claude-'));
    try {
      const project = join(config, 'projects', '-tmp-work');
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, 'session.jsonl'),
        [
          JSON.stringify({ type: 'user', message: { content: 'Hi' } }),
          JSON.stringify({
            type: 'assistant',
            requestId: 'req_1',
            message: {
              id: 'msg_1',
              usage: { input_tokens: 4, output_tokens: 250 },
              content: [{ type: 'text', text: 'Hello' }],
            },
          }),
          '{"type":"assistant","mess',
        ].join('\n')
      );
      const final = claudeTranscriptModelCalls(config);
      expect(final).toEqual([
        {
          id: 'msg_1',
          requestId: 'req_1',
          inputTokens: 4,
          outputTokens: 250,
          text: 'Hello',
        },
      ]);
      const streamed = [
        {
          id: 'msg_1',
          startedAt: '2026-10-22T12:00:00.000Z',
          completedAt: '2026-10-22T12:00:02.000Z',
          inputTokens: 4,
          outputTokens: 1,
          text: 'Hello',
        },
        { id: 'msg_2', outputTokens: 3 },
      ];
      expect(withFinalUsage(streamed, final)).toEqual([
        { ...streamed[0], requestId: 'req_1', outputTokens: 250 },
        streamed[1],
      ]);
      expect(claudeTranscriptModelCalls(join(config, 'missing'))).toEqual([]);
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });
});
