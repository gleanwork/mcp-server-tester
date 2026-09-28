import { describe, it, expect, vi } from 'vitest';
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import type { Client } from '@modelcontextprotocol/client';
import {
  callToolNormalized,
  formatProtocolError,
  getToolProtocolError,
  PROTOCOL_ERROR_META_KEY,
} from './callTool.js';

function clientWith(callTool: ReturnType<typeof vi.fn>): Client {
  return { callTool } as unknown as Client;
}

describe('callToolNormalized', () => {
  it('returns successful results unchanged', async () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const callTool = vi.fn().mockResolvedValue(result);

    await expect(
      callToolNormalized(clientWith(callTool), { name: 'echo', arguments: {} })
    ).resolves.toBe(result);
  });

  it('passes request options through to the SDK', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const signal = new AbortController().signal;

    await callToolNormalized(
      clientWith(callTool),
      { name: 'echo', arguments: { a: 1 } },
      { signal }
    );

    expect(callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { a: 1 } },
      { signal }
    );
  });

  it('folds a server protocol error into an error-shaped result', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValue(
        new ProtocolError(-32602, 'Tool nope not found', { tool: 'nope' })
      );

    const result = await callToolNormalized(clientWith(callTool), {
      name: 'nope',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'MCP error -32602: Tool nope not found' },
    ]);
    expect(result._meta?.[PROTOCOL_ERROR_META_KEY]).toEqual({
      code: -32602,
      message: 'Tool nope not found',
      data: { tool: 'nope' },
    });
    expect(getToolProtocolError(result)).toEqual({
      code: -32602,
      message: 'Tool nope not found',
      data: { tool: 'nope' },
    });
  });

  it('rethrows local SDK errors such as timeouts', async () => {
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, 'timed out');
    const callTool = vi.fn().mockRejectedValue(timeout);

    await expect(
      callToolNormalized(clientWith(callTool), { name: 'slow', arguments: {} })
    ).rejects.toBe(timeout);
  });

  it('rethrows non-MCP errors', async () => {
    const boom = new Error('socket closed');
    const callTool = vi.fn().mockRejectedValue(boom);

    await expect(
      callToolNormalized(clientWith(callTool), { name: 'x', arguments: {} })
    ).rejects.toBe(boom);
  });
});

describe('getToolProtocolError', () => {
  it('returns null for ordinary tool results', () => {
    expect(
      getToolProtocolError({ content: [], isError: true, _meta: {} })
    ).toBeNull();
    expect(getToolProtocolError({ content: [] })).toBeNull();
  });
});

describe('formatProtocolError', () => {
  it('renders the MCP error prefix and code', () => {
    expect(formatProtocolError({ code: -32601, message: 'nope' })).toBe(
      'MCP error -32601: nope'
    );
  });
});
