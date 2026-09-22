/** Classify failures without copying untrusted response bodies, URLs, or headers. */
export function classifyMCPConnectionFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'connection_failed';
  const details = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const status = details.response?.status ?? details.status ?? details.code;
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  ) {
    return `http_${status}`;
  }
  const message = error instanceof Error ? error.message : '';
  const httpStatus =
    /\b(?:HTTP|status(?: code)?|code:)\s*[:=(]?\s*([45]\d{2})\b/i.exec(
      message
    )?.[1];
  if (httpStatus) return `http_${httpStatus}`;
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']) {
    if (details.code === code || message.toUpperCase().includes(code)) {
      return code.toLowerCase();
    }
  }
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/network|socket hang up|fetch failed/i.test(message))
    return 'network_error';
  return 'connection_failed';
}

/** Safe diagnostics only: never retain raw errors that may contain credentials. */
export class MCPHttpConnectionError extends Error {
  readonly streamableHttpFailure: string;
  readonly sseFailure: string;

  constructor(
    streamableError: unknown,
    sseError: unknown,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null
  ) {
    const streamableHttpFailure = classifyMCPConnectionFailure(streamableError);
    const sseFailure = classifyMCPConnectionFailure(sseError);
    super(
      `MCP connection failed: streamableHttp=${streamableHttpFailure}; sse=${sseFailure}`
    );
    this.name = 'MCPHttpConnectionError';
    this.streamableHttpFailure = streamableHttpFailure;
    this.sseFailure = sseFailure;
  }
}

/** Format only allowlisted classifications, including both HTTP attempts. */
export function formatMCPConnectionFailure(error: unknown): string {
  if (error instanceof MCPHttpConnectionError) {
    return `MCP connection failed: streamableHttp=${error.streamableHttpFailure}; sse=${error.sseFailure}`;
  }
  return classifyMCPConnectionFailure(error);
}
