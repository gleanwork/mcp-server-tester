import { ProtocolError } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  Client,
  RequestOptions,
} from '@modelcontextprotocol/client';

/**
 * `_meta` key under which MST records a JSON-RPC protocol error that was
 * normalized into an error-shaped {@link CallToolResult}.
 */
export const PROTOCOL_ERROR_META_KEY =
  'io.gleanwork.mcp-server-tester/protocolError';

/**
 * A JSON-RPC protocol error returned by the server for a `tools/call` request.
 */
export interface ToolProtocolError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Formats a protocol error the way MST has always rendered it
 * (`MCP error <code>: <message>`), so text assertions keep matching across
 * SDK versions.
 */
export function formatProtocolError(error: ToolProtocolError): string {
  return `MCP error ${error.code}: ${error.message}`;
}

/**
 * Returns the protocol error MST recorded on a normalized tool result, if any.
 */
export function getToolProtocolError(
  result: CallToolResult
): ToolProtocolError | null {
  const recorded = result._meta?.[PROTOCOL_ERROR_META_KEY];
  if (
    recorded &&
    typeof recorded === 'object' &&
    typeof (recorded as ToolProtocolError).code === 'number' &&
    typeof (recorded as ToolProtocolError).message === 'string'
  ) {
    return recorded as ToolProtocolError;
  }
  return null;
}

/**
 * Converts a {@link ProtocolError} into an error-shaped tool result.
 */
export function protocolErrorToToolResult(
  error: ProtocolError
): CallToolResult {
  const protocolError: ToolProtocolError = {
    code: error.code,
    message: error.message,
    ...(error.data !== undefined ? { data: error.data } : {}),
  };
  return {
    content: [{ type: 'text', text: formatProtocolError(protocolError) }],
    isError: true,
    _meta: { [PROTOCOL_ERROR_META_KEY]: protocolError },
  };
}

/**
 * Calls a tool and normalizes JSON-RPC protocol errors into an error result.
 *
 * MCP reports tool failures two ways: tool execution errors
 * (`isError: true` in the result) and protocol errors (a JSON-RPC error, e.g.
 * `-32602` for an unknown tool — the 2026-07-28 spec and the v2 SDK server use
 * this). Tests and evals assert on both the same way
 * (`expect(result).toBeToolError()`), so MST folds protocol errors into an
 * error-shaped result. The original error is preserved under
 * {@link PROTOCOL_ERROR_META_KEY} and via {@link getToolProtocolError}.
 *
 * Local SDK failures (timeouts, closed connections, auth) still throw.
 */
export async function callToolNormalized(
  client: Client,
  params: { name: string; arguments?: Record<string, unknown> },
  options?: RequestOptions
): Promise<CallToolResult> {
  try {
    const pending =
      options === undefined
        ? client.callTool(params)
        : client.callTool(params, options);
    return await pending;
  } catch (error) {
    if (error instanceof ProtocolError) {
      return protocolErrorToToolResult(error);
    }
    throw error;
  }
}
