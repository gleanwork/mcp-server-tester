import readline from 'node:readline';

export const DEFAULT_PLANNED_WRITE_KEY = '_mcp_eval_planned_write';

export interface DryRunProxyOptions {
  name: string;
  upstreamUrl: string;
  token: string;
  headers?: Record<string, string>;
  alwaysWriteTools?: string[];
  readOnlyTools?: string[];
  plannedWriteKey?: string;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: { message?: string };
  [key: string]: unknown;
}

function isReadOnly(tool: Record<string, unknown> | undefined): boolean {
  if (!tool) return false;
  const annotations = tool.annotations;
  if (!annotations || typeof annotations !== 'object') return false;
  const values = annotations as Record<string, unknown>;
  return values.readOnlyHint === true && values.destructiveHint !== true;
}

function plannedWriteResult(
  options: DryRunProxyOptions,
  toolName: string,
  arguments_: unknown
): Record<string, unknown> {
  const key = options.plannedWriteKey ?? DEFAULT_PLANNED_WRITE_KEY;
  const envelope = {
    [key]: {
      server: options.name,
      tool_name: toolName,
      arguments: arguments_,
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function parseResponse(text: string, contentType: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload && payload !== '[DONE]')
        return JSON.parse(payload) as JsonRpcResponse;
    }
    throw new Error('upstream returned an empty SSE body');
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('upstream response is not a JSON object');
  }
  return parsed as JsonRpcResponse;
}

class UpstreamClient {
  private sessionId: string | undefined;

  public constructor(private readonly options: DryRunProxyOptions) {}

  public async rpc(
    method: string,
    params: unknown,
    id: number,
    notification = false
  ): Promise<JsonRpcResponse | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60_000
    );
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(this.options.headers ?? {}),
      };
      if (this.options.token)
        headers.Authorization = `Bearer ${this.options.token}`;
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await fetch(this.options.upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (method === 'initialize') {
        this.sessionId = response.headers.get('mcp-session-id') ?? undefined;
      }
      if (notification) return undefined;
      const text = await response.text();
      return parseResponse(text, response.headers.get('content-type') ?? '');
    } finally {
      clearTimeout(timer);
    }
  }
}

function toolMap(
  result: JsonRpcResponse | undefined
): Map<string, Record<string, unknown>> {
  const inner = result?.result ?? result;
  const tools = inner?.tools;
  const map = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(tools)) return map;
  for (const value of tools as unknown[]) {
    if (!value || typeof value !== 'object') continue;
    const tool = value as Record<string, unknown>;
    const name = tool.name;
    if (typeof name === 'string') map.set(name, tool);
  }
  return map;
}

/** Run the stdio JSON-RPC dry-run proxy used by native MCP servers. */
export async function runDryRunProxy(
  options: DryRunProxyOptions
): Promise<void> {
  if (!options.token)
    throw new Error('dry-run proxy requires a non-empty token');
  const client = new UpstreamClient(options);
  const tools = new Map<string, Record<string, unknown>>();
  const alwaysWrite = new Set(options.alwaysWriteTools ?? []);
  const readOnly = new Set(options.readOnlyTools ?? []);
  const input = readline.createInterface({ input: process.stdin });

  for await (const line of input) {
    if (!line.trim()) continue;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      message = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const method = typeof message.method === 'string' ? message.method : '';
    const id = typeof message.id === 'number' ? message.id : 1;
    const notification =
      message.id === undefined || method.startsWith('notifications/');
    const params = message.params;

    if (!notification && method === 'tools/call') {
      const callParams =
        params && typeof params === 'object'
          ? (params as Record<string, unknown>)
          : {};
      const toolName =
        typeof callParams.name === 'string' ? callParams.name : '';
      let tool = tools.get(toolName);
      if (!tool) {
        const listed = await client.rpc('tools/list', {}, 1);
        for (const [name, value] of toolMap(listed)) tools.set(name, value);
        tool = tools.get(toolName);
      }
      const write =
        alwaysWrite.has(toolName) ||
        (!readOnly.has(toolName) && !isReadOnly(tool));
      if (write) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: plannedWriteResult(options, toolName, callParams.arguments),
          })}\n`
        );
        continue;
      }
    }

    const upstream = await client.rpc(method, params, id, notification);
    if (upstream && method === 'tools/list') {
      for (const [name, value] of toolMap(upstream)) tools.set(name, value);
    }
    if (!notification) {
      process.stdout.write(
        `${JSON.stringify({
          ...(upstream ?? {
            error: { code: -32000, message: 'empty upstream response' },
          }),
          jsonrpc: '2.0',
          id,
        })}\n`
      );
    }
  }
}

/** Probe an upstream server before attaching it to a host configuration. */
export async function preflightMcpServer(
  options: DryRunProxyOptions,
  expectedMinTools = 1
): Promise<void> {
  const client = new UpstreamClient(options);
  const initialized = await client.rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-server-tester-preflight', version: '1.0' },
    },
    1
  );
  if (initialized?.error)
    throw new Error(
      `initialize failed: ${initialized.error.message ?? 'unknown error'}`
    );
  await client.rpc('notifications/initialized', {}, 0, true);
  const listed = await client.rpc('tools/list', {}, 2);
  if (listed?.error)
    throw new Error(
      `tools/list failed: ${listed.error.message ?? 'unknown error'}`
    );
  const tools = listed?.result?.tools;
  if (!Array.isArray(tools) || tools.length < expectedMinTools) {
    throw new Error(
      `tools/list returned ${Array.isArray(tools) ? tools.length : 0} tools; expected at least ${expectedMinTools}`
    );
  }
}
