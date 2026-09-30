// Scripted, SDK-free legacy-era (initialize handshake) MCP server, over stdio
// or Streamable HTTP.
//
//   node tests/mocks/rawLegacyServer.mjs              # stdio
//   node tests/mocks/rawLegacyServer.mjs --http 0     # HTTP on a free port
//
// It answers a fixed set of methods and appends what the client sends to the
// file named by RAW_SERVER_LOG (one JSON object per line): the JSON-RPC
// message on stdio, and the HTTP method, the MCP-relevant headers, and the
// body over HTTP. Because it has no SDK dependency, the recording depends only
// on the MCP client under test, which makes it suitable for wire goldens.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import readline from 'node:readline';

const logPath = process.env.RAW_SERVER_LOG;

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes back the input',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

/** Headers worth comparing across client versions (values normalized). */
const RECORDED_HEADERS = [
  'accept',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'user-agent',
];

function record(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

/** Returns the JSON-RPC response for a message, or null for notifications. */
function handle(message) {
  if (message.id === undefined) return null;
  const respond = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({
    jsonrpc: '2.0',
    id: message.id,
    error: { code, message: text },
  });

  switch (message.method) {
    case 'initialize':
      return respond({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'raw-legacy-server', version: '1.0.0' },
      });
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call':
      if (message.params.name !== 'echo') {
        return fail(-32602, `Unknown tool: ${message.params.name}`);
      }
      return respond({
        content: [
          { type: 'text', text: `Echo: ${message.params.arguments.message}` },
        ],
      });
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

const httpFlag = process.argv.indexOf('--http');

if (httpFlag >= 0) {
  const SESSION = 'raw-session-1';
  const server = createServer((req, res) => {
    const headers = {};
    for (const name of RECORDED_HEADERS) {
      const value = req.headers[name];
      if (value === undefined) continue;
      headers[name] =
        name === 'user-agent'
          ? String(value).replace(/\/[^/\s]+$/, '/<version>')
          : String(value);
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = body ? JSON.parse(body) : undefined;
      record({
        method: req.method,
        headers,
        ...(message ? { body: message } : {}),
      });

      if (req.method === 'GET') {
        // No standalone SSE stream; clients proceed without one.
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      const response = handle(message);
      if (response === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(message.method === 'initialize'
          ? { 'mcp-session-id': SESSION }
          : {}),
      });
      res.end(JSON.stringify(response));
    });
  });
  server.listen(Number(process.argv[httpFlag + 1] ?? '0'), '127.0.0.1', () => {
    const { port } = server.address();
    console.error(`raw legacy server on http://127.0.0.1:${port}/mcp`);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    record(message);
    const response = handle(message);
    if (response !== null)
      process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
