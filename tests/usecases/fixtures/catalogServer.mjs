// A stdio MCP server that serves the tools in a JSON catalog.
//
//   node catalogServer.mjs <catalog.json>
//
// The catalog is { name, tools: [{ name, description, response }] }. A tool
// call returns its `response` text, with `{query}` replaced by the call's
// `query` argument. Each line on stdin is one JSON-RPC message (MCP stdio);
// it speaks the initialize-handshake protocol revisions.
import fs from 'node:fs';
import readline from 'node:readline';

const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function tool(entry) {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, id: { type: 'string' } },
    },
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`
  );
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no reply
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      respond(id, {
        protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: catalog.name, version: '1.0.0' },
      });
      return;
    }
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: catalog.tools.map(tool) });
      return;
    case 'tools/call': {
      const entry = catalog.tools.find((t) => t.name === params?.name);
      if (!entry) {
        fail(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      const query = String(params?.arguments?.query ?? '');
      respond(id, {
        content: [
          { type: 'text', text: entry.response.replaceAll('{query}', query) },
        ],
      });
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  handle(message);
});
