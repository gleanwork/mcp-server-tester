#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import readline from 'node:readline';

const runtimePath = process.argv[2];
if (!runtimePath || !isAbsolute(runtimePath)) {
  throw new Error('Expected one absolute desktop fixture runtime path.');
}
const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
validateRuntime(runtime);
const { seed, ledgerPath } = runtime;
const sessionId = randomUUID();
let sequence = 0;
const input = readline.createInterface({ input: process.stdin });

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(request) || request.jsonrpc !== '2.0') return;
  record('request', request);
  if (request.id === undefined) return;

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: seed.serverName, version: '1.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: [lookupTool(), searchTool()] },
    });
    return;
  }
  if (request.method === 'tools/call') {
    send(toolCallResponse(request));
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

function toolCallResponse(request) {
  const name = request.params?.name;
  const args = request.params?.arguments;
  if (!isRecord(args) || args.namespace !== 'releases') {
    return toolResult(
      request.id,
      {
        serverLabel: seed.serverLabel,
        code: 'INVALID_ARGUMENT',
        message: 'Expected namespace "releases" and valid tool arguments.',
      },
      true
    );
  }
  if (name === 'lookup_record' && nonempty(args.reference)) {
    const found = seed.records.find(
      (item) => item.reference === args.reference
    );
    return toolResult(
      request.id,
      found
        ? { serverLabel: seed.serverLabel, record: found }
        : {
            serverLabel: seed.serverLabel,
            code: 'NOT_FOUND',
            reference: args.reference,
            recovery:
              'Search releases by title, then look up a returned reference.',
          },
      !found
    );
  }
  if (name === 'search_records' && nonempty(args.query)) {
    return toolResult(request.id, {
      serverLabel: seed.serverLabel,
      matches: seed.records
        .filter((item) => item.title.toLowerCase() === args.query.toLowerCase())
        .map(({ reference, title }) => ({ reference, title })),
    });
  }
  return toolResult(
    request.id,
    {
      serverLabel: seed.serverLabel,
      code: 'INVALID_ARGUMENT',
      message: 'Unknown tool or invalid tool arguments.',
    },
    true
  );
}

function toolResult(id, structuredContent, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError,
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  };
}

function lookupTool() {
  return {
    name: 'lookup_record',
    description: 'Read a synthetic release record by its exact reference.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { const: 'releases' },
        reference: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['namespace', 'reference'],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations(),
  };
}

function searchTool() {
  return {
    name: 'search_records',
    description:
      'Find synthetic releases by title. Returns references, not record contents; use lookup_record to read a match.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { const: 'releases' },
        query: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['namespace', 'query'],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations(),
  };
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  record('response', message);
}

function record(direction, message) {
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      version: 1,
      runId: seed.runId,
      serverLabel: seed.serverLabel,
      serverName: seed.serverName,
      sessionId,
      sequence: ++sequence,
      direction,
      message,
    })}\n`,
    { mode: 0o600 }
  );
}

function validateRuntime(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isAbsolute(value.ledgerPath) ||
    !isRecord(value.seed) ||
    !nonempty(value.seed.runId) ||
    !nonempty(value.seed.serverLabel) ||
    !nonempty(value.seed.serverName) ||
    !Array.isArray(value.seed.records) ||
    value.seed.records.some(
      (record) =>
        !isRecord(record) ||
        !nonempty(record.reference) ||
        !nonempty(record.title) ||
        !nonempty(record.verificationCode)
    )
  ) {
    throw new Error('Invalid desktop fixture runtime.');
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}
