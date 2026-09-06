#!/usr/bin/env node

import readline from 'node:readline';

const nonce = 'MCP_E2E_NONCE_7F3A9';
const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (request.id === undefined) return;

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-tester-e2e', version: '1.0.0' },
      },
    });
    return;
  }

  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'get_eval_nonce',
            description:
              'Returns an opaque deterministic nonce for E2E verification.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (
    request.method === 'tools/call' &&
    request.params?.name === 'get_eval_nonce'
  ) {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: nonce }],
        structuredContent: { nonce },
      },
    });
    return;
  }

  if (request.method === 'ping') {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  });
});
