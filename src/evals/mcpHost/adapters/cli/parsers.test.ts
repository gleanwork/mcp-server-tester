import { describe, it, expect } from 'vitest';
import { parseStreamJson, createJsonParser } from './parsers.js';

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
    expect(result.error).toBe('CLI host reported an error');
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

  it('collects tool_result blocks into conversationHistory', () => {
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
