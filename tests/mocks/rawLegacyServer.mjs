// Scripted, SDK-free legacy-era (initialize handshake) MCP server over stdio.
//
// It answers a fixed set of methods and appends every message the client sends
// to the file named by RAW_SERVER_LOG (one JSON object per line). Because it
// has no SDK dependency, the recorded client frames depend only on the MCP
// client under test, which makes it suitable for wire-compatibility goldens.
import { appendFileSync } from 'node:fs';
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
  if (message.id === undefined) return; // notification

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'raw-legacy-server', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      respond(message.id, { tools: TOOLS });
      return;
    case 'tools/call':
      if (message.params.name !== 'echo') {
        fail(message.id, -32602, `Unknown tool: ${message.params.name}`);
        return;
      }
      respond(message.id, {
        content: [
          { type: 'text', text: `Echo: ${message.params.arguments.message}` },
        ],
      });
      return;
    default:
      fail(message.id, -32601, `Method not found: ${message.method}`);
  }
});
