// An SDK-free MCP server for tests that need a server MST's readiness check
// can reach, over stdio or Streamable HTTP. It starts in a few milliseconds.
//
//   node tests/mocks/readinessServer.mjs     # stdio
//
// Over stdio it reads its settings from the environment:
//
//   READINESS_TOOLS        how many tools it lists (default 1)
//   READINESS_FAIL_TIMES   the first N launches exit before answering...
//   READINESS_FAIL_FILE    ...counted in this file (one line per launch)
//   READINESS_LOG          appends `initialize` and `tools/list` here, one
//                          line per request, and `closed` when stdin ends
//   READINESS_STALL_LIST   when `1`, never answers `tools/list`
//
// Over HTTP, `startReadinessHttpServer` takes the same settings as options.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

function toolList(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index + 1}`,
    description: `Test tool ${index + 1}`,
    inputSchema: { type: 'object', properties: {} },
  }));
}

/**
 * The JSON-RPC response for a message, or null for a notification (and for
 * `tools/list` when `stallList` is set).
 */
function respond(message, { tools, log, stallList }) {
  if (
    log &&
    (message.method === 'initialize' || message.method === 'tools/list')
  )
    appendFileSync(log, `${message.method}\n`);
  if (message.id === undefined) return null;
  if (stallList && message.method === 'tools/list') return null;
  const result = (value) => ({ jsonrpc: '2.0', id: message.id, result: value });
  switch (message.method) {
    case 'initialize':
      return result({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'readiness-server', version: '1.0.0' },
      });
    case 'tools/list':
      return result({ tools: toolList(tools) });
    case 'tools/call':
      return result({ content: [{ type: 'text', text: 'ok' }] });
    default:
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

/**
 * Serves over HTTP on a free local port. `failTimes` answers the first N
 * `initialize` requests with a 503. `stallList` never answers `tools/list`
 * or a session DELETE, and logs `closed` when the client drops a stalled
 * request. Resolves to its URL and `close`.
 */
export function startReadinessHttpServer({
  tools = 1,
  failTimes = 0,
  log,
  stallList = false,
} = {}) {
  let failures = 0;
  const stall = (res) =>
    res.on('close', () => {
      if (log && !res.writableEnded) appendFileSync(log, 'closed\n');
    });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'GET') return res.writeHead(405).end();
      if (req.method === 'DELETE')
        return stallList ? stall(res) : res.writeHead(200).end();
      const message = JSON.parse(body);
      if (message.method === 'initialize' && failures < failTimes) {
        failures++;
        return res.writeHead(503).end();
      }
      if (stallList && message.method === 'tools/list') {
        respond(message, { tools, log });
        return stall(res);
      }
      const response = respond(message, { tools, log });
      if (response === null) return res.writeHead(202).end();
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(message.method === 'initialize'
          ? { 'mcp-session-id': 'readiness-session' }
          : {}),
      });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function serveStdio() {
  const failFile = process.env.READINESS_FAIL_FILE;
  const failTimes = Number(process.env.READINESS_FAIL_TIMES ?? 0);
  if (failFile && failTimes > 0) {
    let launches = 0;
    try {
      launches = readFileSync(failFile, 'utf8')
        .split('\n')
        .filter(Boolean).length;
    } catch {
      // No launch yet.
    }
    appendFileSync(failFile, 'launch\n');
    if (launches < failTimes) process.exit(1);
  }
  const settings = {
    tools: Number(process.env.READINESS_TOOLS ?? 1),
    log: process.env.READINESS_LOG,
    stallList: process.env.READINESS_STALL_LIST === '1',
  };
  process.stdin.on('end', () => {
    if (settings.log) appendFileSync(settings.log, 'closed\n');
  });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const response = respond(JSON.parse(line), settings);
    if (response !== null)
      process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  serveStdio();
