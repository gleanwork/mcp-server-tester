import { describe, expect, it } from 'vitest';
import {
  buildCodexTrace,
  parseCodexRollout,
  type TimedCodexEvent,
} from './codexTrace.js';

const servers = new Map([['glean_eval', 'glean.eval']]);

function at(second: number): string {
  return new Date(Date.UTC(2026, 9, 29, 18, 0, second)).toISOString();
}

/** The events `codex exec --experimental-json` streams for one MCP call. */
const STREAM: TimedCodexEvent[] = [
  { at: at(0), event: { type: 'thread.started', thread_id: 'thread-1' } },
  { at: at(0), event: { type: 'turn.started' } },
  {
    at: at(1),
    event: {
      type: 'error',
      message: 'Reconnecting... 2/5 (unexpected status 405)',
    },
  },
  {
    at: at(2),
    event: {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Searching.' },
    },
  },
  {
    at: at(3),
    event: {
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'mcp_tool_call',
        server: 'glean_eval',
        tool: 'search',
        arguments: { query: 'pto' },
        status: 'in_progress',
      },
    },
  },
  {
    at: at(5),
    event: {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'mcp_tool_call',
        server: 'glean_eval',
        tool: 'search',
        arguments: { query: 'pto' },
        result: {
          content: [
            { type: 'text', text: 'PTO policy' },
            { type: 'text', text: 'doc 2' },
          ],
          structured_content: null,
        },
        error: null,
        status: 'completed',
      },
    },
  },
  {
    at: at(6),
    event: {
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'nope',
        exit_code: 2,
        status: 'failed',
      },
    },
  },
  {
    at: at(8),
    event: {
      type: 'item.completed',
      item: { id: 'item_3', type: 'agent_message', text: 'Unlimited PTO.' },
    },
  },
  {
    at: at(8),
    event: {
      type: 'turn.completed',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 600,
        cache_write_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
      },
    },
  },
];

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

/** The session's rollout, as Codex 0.160 writes it. */
const ROLLOUT = [
  line({
    timestamp: at(0),
    type: 'session_meta',
    payload: { id: 'thread-1', originator: 'codex_sdk_ts' },
  }),
  line({
    timestamp: at(0),
    type: 'turn_context',
    payload: { model: 'gpt-5.5', effort: 'medium' },
  }),
  line({
    timestamp: at(0),
    type: 'event_msg',
    payload: { type: 'task_started' },
  }),
  line({
    timestamp: at(2),
    type: 'response_item',
    payload: {
      type: 'tool_search_call',
      call_id: 'call_search',
      arguments: { query: 'glean search', limit: 5 },
    },
  }),
  line({
    timestamp: at(2),
    type: 'token_usage_record',
    payload: {
      response_id: 'resp_1',
      usage: {
        input_tokens: 400,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 30,
        reasoning_output_tokens: 10,
      },
    },
  }),
  line({
    timestamp: at(2),
    type: 'response_item',
    payload: {
      type: 'tool_search_output',
      call_id: 'call_search',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__glean_eval',
          tools: [{ type: 'function', name: 'search' }],
        },
        { type: 'function', name: 'loose_tool' },
      ],
    },
  }),
  line({
    timestamp: at(3),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'search',
      namespace: 'mcp__glean_eval',
      arguments: '{"query":"pto"}',
      call_id: 'call_search_1',
    },
  }),
  line({
    timestamp: at(3),
    type: 'token_usage_record',
    payload: {
      response_id: 'resp_2',
      usage: {
        input_tokens: 500,
        cached_input_tokens: 500,
        output_tokens: 15,
      },
    },
  }),
  line({
    timestamp: at(5),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_search_1' },
  }),
  // A record Codex rewrote: the same response's usage, counted once.
  line({
    timestamp: at(5),
    type: 'token_usage_record',
    payload: { response_id: 'resp_2', usage: { input_tokens: 500 } },
  }),
  line({
    timestamp: at(7),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Unlimited PTO.' }],
    },
  }),
  line({
    timestamp: at(8),
    type: 'token_usage_record',
    payload: {
      response_id: 'resp_3',
      usage: { input_tokens: 100, cached_input_tokens: 100, output_tokens: 5 },
    },
  }),
  line({
    timestamp: at(8),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      duration_ms: 8000,
      time_to_first_token_ms: 900,
    },
  }),
  '{"timestamp":"unfinished',
].join('\n');

const context = { servers, startedAt: at(0), endedAt: at(9) };

describe('buildCodexTrace', () => {
  it('traces calls, answer and usage from the events alone', () => {
    const trace = buildCodexTrace(STREAM, undefined, context);
    expect(trace.finalText).toBe('Unlimited PTO.');
    expect(trace.error).toBeUndefined();
    expect(trace.threadId).toBe('thread-1');
    expect(trace.events).toEqual([
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        server: 'glean.eval',
        rawName: 'mcp__glean_eval__search',
        arguments: { query: 'pto' },
        output: 'PTO policy\ndoc 2',
        isError: false,
        id: 'item_1',
        startedAt: at(3),
        completedAt: at(5),
        durationMs: 2000,
      },
      {
        kind: 'tool_call',
        source: 'builtin',
        name: 'shell',
        rawName: 'command_execution',
        arguments: { command: 'ls' },
        output: 'nope',
        isError: true,
        id: 'item_2',
        completedAt: at(6),
      },
    ]);
    // Input is MST's uncached count; cached input is apart.
    expect(trace.usage).toEqual({
      inputTokens: 400,
      outputTokens: 50,
      durationMs: 9000,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 10,
    });
    expect(trace.modelCalls).toBeUndefined();
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 1,
      builtinToolCallCount: 1,
      transientErrorCount: 1,
      traceSource: 'codex-events',
    });
  });

  it('adds model calls, tool searches and native call IDs from the rollout', () => {
    const trace = buildCodexTrace(STREAM, ROLLOUT, context);
    expect(trace.events.map((event) => [event.kind, event.id])).toEqual([
      ['tool_search', 'call_search'],
      ['tool_call', 'call_search_1'],
      ['tool_call', 'item_2'],
    ]);
    expect(trace.events[0]).toMatchObject({
      source: 'builtin',
      name: 'tool_search',
      arguments: { query: 'glean search', limit: 5 },
      results: [
        { name: 'search', server: 'glean.eval' },
        { name: 'loose_tool' },
      ],
    });
    expect(trace.modelCalls).toEqual([
      {
        id: 'resp_1',
        model: 'gpt-5.5',
        startedAt: at(0),
        completedAt: at(2),
        durationMs: 2000,
        inputTokens: 400,
        outputTokens: 30,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 10,
        toolCallIds: ['call_search'],
      },
      {
        id: 'resp_2',
        model: 'gpt-5.5',
        startedAt: at(2),
        completedAt: at(3),
        durationMs: 1000,
        inputTokens: 0,
        outputTokens: 15,
        cacheReadInputTokens: 500,
        toolCallIds: ['call_search_1'],
      },
      {
        id: 'resp_3',
        model: 'gpt-5.5',
        // From the tool's output to the response.
        startedAt: at(5),
        completedAt: at(8),
        durationMs: 3000,
        inputTokens: 0,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        text: 'Unlimited PTO.',
      },
    ]);
    expect(trace.usage?.durationMs).toBe(8000);
    expect(trace.telemetry).toMatchObject({
      models: ['gpt-5.5'],
      reasoningEffort: 'medium',
      apiCallCount: 3,
      timeToFirstTokenMs: 900,
      toolSearchCount: 1,
      traceSource: 'codex-events+rollout',
    });
  });

  it('reports a failed turn, and a turn that never completed', () => {
    const failed = buildCodexTrace(
      [
        ...STREAM.slice(0, 2),
        {
          at: at(1),
          event: { type: 'turn.failed', error: { message: 'quota exceeded' } },
        },
      ],
      undefined,
      context
    );
    expect(failed.error).toBe('quota exceeded');
    expect(failed.usage).toBeUndefined();
    const cut = buildCodexTrace(
      [
        ...STREAM.slice(0, 3),
        { at: at(2), event: { type: 'error', message: 'stream closed' } },
      ],
      undefined,
      context
    );
    expect(cut.error).toBe('stream closed');
    expect(buildCodexTrace(STREAM.slice(0, 2), undefined, context).error).toBe(
      'Codex ended without completing its turn.'
    );
  });

  it('keeps MCP errors, non-text results, web searches and file changes', () => {
    const trace = buildCodexTrace(
      [
        {
          at: at(1),
          event: {
            type: 'item.completed',
            item: {
              id: 'a',
              type: 'mcp_tool_call',
              server: 'other',
              tool: 'write',
              arguments: '{"x":1}',
              error: { message: 'denied' },
              status: 'failed',
            },
          },
        },
        {
          at: at(2),
          event: {
            type: 'item.completed',
            item: {
              id: 'b',
              type: 'mcp_tool_call',
              server: 'glean_eval',
              tool: 'read',
              arguments: 'not json',
              result: {
                content: [{ type: 'image', data: 'x' }],
                isError: true,
              },
              status: 'completed',
            },
          },
        },
        {
          at: at(3),
          event: {
            type: 'item.completed',
            item: {
              id: 'c',
              type: 'mcp_tool_call',
              server: 'glean_eval',
              tool: 'structured',
              arguments: {},
              result: { content: [], structured_content: { ok: true } },
              status: 'completed',
            },
          },
        },
        {
          at: at(4),
          event: {
            type: 'item.completed',
            item: { id: 'd', type: 'web_search', query: 'weather' },
          },
        },
        {
          at: at(5),
          event: {
            type: 'item.completed',
            item: {
              id: 'e',
              type: 'file_change',
              changes: [{ path: 'a', kind: 'add' }],
              status: 'completed',
            },
          },
        },
        {
          at: at(6),
          event: {
            type: 'item.completed',
            item: { id: 'f', type: 'todo_list', items: [] },
          },
        },
        { at: at(6), event: { type: 'turn.completed', usage: {} } },
      ],
      undefined,
      context
    );
    expect(
      trace.events.map(
        ({ name, server, arguments: args, output, isError }) => ({
          name,
          server,
          args,
          output,
          isError,
        })
      )
    ).toEqual([
      {
        name: 'write',
        server: 'other',
        args: { x: 1 },
        output: 'denied',
        isError: true,
      },
      {
        name: 'read',
        server: 'glean.eval',
        args: { input: 'not json' },
        output: '[{"type":"image","data":"x"}]',
        isError: true,
      },
      {
        name: 'structured',
        server: 'glean.eval',
        args: {},
        output: '{"ok":true}',
        isError: false,
      },
      {
        name: 'web_search',
        server: undefined,
        args: { query: 'weather' },
        output: undefined,
        isError: undefined,
      },
      {
        name: 'apply_patch',
        server: undefined,
        args: { changes: [{ path: 'a', kind: 'add' }] },
        output: undefined,
        isError: false,
      },
    ]);
    // A turn without token counts has no usage.
    expect(trace.usage).toBeUndefined();
    expect(trace.finalText).toBe('');
  });
});

describe('parseCodexRollout', () => {
  it('skips lines that do not parse', () => {
    const facts = parseCodexRollout(`not json\n${ROLLOUT}`, servers);
    expect(facts.modelCalls).toHaveLength(3);
    expect(facts.mcpCallIds.get('mcp__glean_eval__search')).toEqual([
      'call_search_1',
    ]);
  });
});
