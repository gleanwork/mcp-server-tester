import { describe, expect, it } from 'vitest';
import {
  classifyMCPConnectionFailure,
  formatMCPConnectionFailure,
  MCPHttpConnectionError,
} from './connectionDiagnostics.js';

describe('safe MCP connection diagnostics', () => {
  it.each([
    [
      new Error('Error POSTing to endpoint (HTTP 403): private body'),
      'http_403',
    ],
    [new Error('SSE error: Non-200 status code (401)'), 'http_401'],
    [Object.assign(new Error('private body'), { code: 401 }), 'http_401'],
    [{ response: { status: 429 } }, 'http_429'],
    [
      Object.assign(new Error('private body'), { code: 'ECONNRESET' }),
      'econnreset',
    ],
    [new Error('connect ECONNREFUSED private-url'), 'econnrefused'],
    [new Error('MCP preflight timed out'), 'timeout'],
    [new Error('fetch failed'), 'network_error'],
    [
      new Error('Authorization: Bearer private-token Cookie: private-cookie'),
      'connection_failed',
    ],
    ['private-token', 'connection_failed'],
    [null, 'connection_failed'],
  ])('classifies failure %# without raw content', (error, expected) => {
    expect(classifyMCPConnectionFailure(error)).toBe(expected);
    expect(formatMCPConnectionFailure(error)).toBe(expected);
  });

  it('formats both transport failures without retaining raw causes', () => {
    const error = new MCPHttpConnectionError(
      new Error('HTTP 403 secret-primary'),
      new Error('SSE error: Non-200 status code (401) secret-fallback'),
      false,
      null
    );
    expect(formatMCPConnectionFailure(error)).toBe(
      'MCP connection failed: streamableHttp=http_403; sse=http_401'
    );
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.stack).not.toContain('secret');
  });
});
