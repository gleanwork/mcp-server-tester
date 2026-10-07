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
 * Renders a protocol error as `MCP error <code>: <message>`, the format the
 * v1 SDK used for relayed JSON-RPC errors (v2 dropped the prefix), so text
 * assertions can match on the code.
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
function protocolErrorToToolResult(error: ProtocolError): CallToolResult {
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

/** Errors that arrived as a JSON-RPC error response from the server. */
const serverErrors = new WeakSet<object>();
const trackedClients = new WeakSet<Client>();

/**
 * Marks `ProtocolError`s that come out of the client's `request()` (that is,
 * errors the server sent) so they can be told apart from `ProtocolError`s the
 * SDK raises locally. `Client.callTool()` throws local ones before sending (an
 * uncompilable `outputSchema`) and after receiving (structured content that
 * does not match the output schema); those are client-side verdicts, not
 * server errors, and must not be reported as if the server returned them.
 */
function trackServerErrors(client: Client): void {
  if (trackedClients.has(client) || typeof client.request !== 'function') {
    return;
  }
  trackedClients.add(client);
  const request = client.request.bind(client) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const tracked = async (...args: unknown[]): Promise<unknown> => {
    try {
      return await request(...args);
    } catch (error) {
      if (error instanceof ProtocolError) serverErrors.add(error);
      throw error;
    }
  };
  (client as unknown as { request: typeof tracked }).request = tracked;
}

/**
 * True when an error is a protocol error the server returned (as opposed to
 * one raised locally by the SDK).
 */
export function isServerProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError && serverErrors.has(error);
}

/**
 * Calls a tool and normalizes server-sent JSON-RPC protocol errors into an
 * error result.
 *
 * MCP reports tool failures two ways: tool execution errors
 * (`isError: true` in the result) and protocol errors (a JSON-RPC error, e.g.
 * `-32602` for an unknown tool; the 2026-07-28 spec and the v2 SDK server use
 * this). Tests and evals assert on both the same way
 * (`expect(result).toBeToolError()`), so MST folds protocol errors from the
 * server into an error-shaped result. The original error is preserved under
 * {@link PROTOCOL_ERROR_META_KEY} and via {@link getToolProtocolError}.
 *
 * Everything else still throws: local SDK failures (timeouts, closed
 * connections, auth) and the SDK's own output-schema validation errors.
 */
export async function callToolNormalized(
  client: Client,
  params: { name: string; arguments?: Record<string, unknown> },
  options?: RequestOptions
): Promise<CallToolResult> {
  trackServerErrors(client);
  try {
    // Omit `options` when absent so the SDK call (and test doubles) see the
    // same arguments as a plain `client.callTool(params)`.
    const pending =
      options === undefined
        ? client.callTool(params)
        : client.callTool(params, options);
    return await pending;
  } catch (error) {
    if (isServerProtocolError(error)) {
      return protocolErrorToToolResult(error);
    }
    throw error;
  }
}
