#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const { nonce } = JSON.parse(
  readFileSync(new URL('./nonce.json', import.meta.url), 'utf8')
);
if (!/^MCP_E2E_NONCE_[a-f0-9]{64}$/.test(nonce)) {
  throw new Error('Build a fresh fixture with examples/cowork/cli.ts prepare');
}
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

  if (!request || typeof request !== 'object' || request.id === undefined)
    return;

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
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (request.method === 'tools/call') {
    const args = request.params?.arguments ?? {};
    if (
      request.params?.name !== 'get_eval_nonce' ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).length !== 0
    ) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32602,
          message: 'Expected get_eval_nonce with no arguments',
        },
      });
      return;
    }
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
