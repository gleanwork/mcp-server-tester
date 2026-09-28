// Scripted, SDK-free 2026-07-28 (modern-only) MCP server over Streamable HTTP,
// with switchable spec violations for conformance-check tests.
//
//   node tests/mocks/rawModernServer.mjs <port>   (0 = any free port)
//
// FAULTS (comma-separated) turns on violations:
//   no-ttl, no-result-type, no-server-info, accept-bad-version,
//   accept-missing-meta, ignore-header-mismatch, unknown-method-200,
//   mint-session, not-found-32002, empty-not-found, unknown-tool-iserror,
//   reserved-code, shuffle-tools
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? '3950');
const faults = new Set(
  (process.env.FAULTS ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
);
const VERSION = '2026-07-28';
const SERVER_INFO = { name: 'raw-modern-server', version: '1.0.0' };
const TOOLS = ['alpha', 'beta', 'gamma'].map((name) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}));
let calls = 0;

function complete(result, { cacheable = false } = {}) {
  const out = { ...result };
  if (!faults.has('no-result-type')) out.resultType = 'complete';
  if (cacheable && !faults.has('no-ttl')) {
    out.ttlMs = 0;
    out.cacheScope = 'private';
  }
  if (!faults.has('no-server-info')) {
    out._meta = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };
  }
  return out;
}

function handle(message, headers) {
  const meta = message.params?._meta;
  const requested = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headerVersion = headers['mcp-protocol-version'];

  if (!faults.has('ignore-header-mismatch')) {
    if (headers['mcp-method'] !== message.method) {
      return {
        status: 400,
        error: { code: -32020, message: 'Header mismatch: Mcp-Method' },
      };
    }
    const name = message.params?.name ?? message.params?.uri;
    if (
      name !== undefined &&
      headers['mcp-name'] !== undefined &&
      headers['mcp-name'] !== name
    ) {
      return {
        status: 400,
        error: { code: -32020, message: 'Header mismatch: Mcp-Name' },
      };
    }
  }
  if (
    !meta ||
    !requested ||
    !meta['io.modelcontextprotocol/clientCapabilities']
  ) {
    if (!faults.has('accept-missing-meta')) {
      return {
        status: 400,
        error: { code: -32602, message: 'Missing required _meta' },
      };
    }
  } else if (
    requested !== VERSION ||
    (headerVersion && headerVersion !== requested)
  ) {
    if (
      headerVersion &&
      headerVersion !== requested &&
      !faults.has('ignore-header-mismatch')
    ) {
      return {
        status: 400,
        error: {
          code: -32020,
          message: 'Header mismatch: MCP-Protocol-Version',
        },
      };
    }
    if (!faults.has('accept-bad-version')) {
      return {
        status: 400,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: [VERSION], requested },
        },
      };
    }
  }

  switch (message.method) {
    case 'server/discover':
      return {
        result: complete(
          {
            supportedVersions: [VERSION],
            capabilities: { tools: {}, resources: {} },
          },
          { cacheable: true }
        ),
      };
    case 'tools/list': {
      calls += 1;
      const tools =
        faults.has('shuffle-tools') && calls % 2 === 0
          ? [...TOOLS].reverse()
          : TOOLS;
      return { result: complete({ tools }, { cacheable: true }) };
    }
    case 'tools/call': {
      const name = message.params?.name;
      if (!TOOLS.some((tool) => tool.name === name)) {
        if (faults.has('unknown-tool-iserror')) {
          return {
            result: complete({
              content: [{ type: 'text', text: 'no such tool' }],
              isError: true,
            }),
          };
        }
        return {
          error: {
            code: faults.has('reserved-code') ? -32050 : -32602,
            message: `Unknown tool: ${name}`,
          },
        };
      }
      return {
        result: complete({
          content: [{ type: 'text', text: `called ${name}` }],
        }),
      };
    }
    case 'resources/list':
      return {
        result: complete(
          {
            resources: [
              { uri: 'mem://readme', name: 'readme', mimeType: 'text/plain' },
            ],
          },
          { cacheable: true }
        ),
      };
    case 'resources/read': {
      const uri = message.params?.uri;
      if (uri === 'mem://readme') {
        return {
          result: complete(
            { contents: [{ uri, mimeType: 'text/plain', text: 'hello' }] },
            { cacheable: true }
          ),
        };
      }
      if (faults.has('empty-not-found')) {
        return { result: complete({ contents: [] }, { cacheable: true }) };
      }
      return {
        error: {
          code: faults.has('not-found-32002') ? -32002 : -32602,
          message: `Resource not found: ${uri}`,
          data: { uri },
        },
      };
    }
    default:
      if (faults.has('unknown-method-200')) {
        return { result: complete({}) };
      }
      return {
        status: 404,
        error: { code: -32601, message: 'Method not found' },
      };
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
      );
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const outcome = handle(message, req.headers);
    const headers = { 'content-type': 'application/json' };
    if (faults.has('mint-session')) headers['mcp-session-id'] = 'session-123';
    res.writeHead(outcome.status ?? 200, headers);
    res.end(
      JSON.stringify(
        outcome.error
          ? { jsonrpc: '2.0', id: message.id, error: outcome.error }
          : { jsonrpc: '2.0', id: message.id, result: outcome.result }
      )
    );
  });
});

// Port 0 picks a free port; the actual URL is printed for the caller.
server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address();
  console.error(
    `raw modern server on http://127.0.0.1:${bound}/mcp faults=${[...faults].join(',')}`
  );
});
