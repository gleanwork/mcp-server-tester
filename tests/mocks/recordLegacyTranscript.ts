// Drives MST's client against the scripted raw legacy server and returns the
// normalized list of messages the client put on the wire.
//
// Used by src/mcp/wireCompat.test.ts. Also runnable directly to regenerate the
// golden transcript from a given checkout:
//   node --import tsx tests/mocks/recordLegacyTranscript.ts > golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../src/mcp/clientFactory.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Replace fields that legitimately vary between runs and releases. */
function normalize(message: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const params = clone.params as Record<string, unknown> | undefined;
  const clientInfo = params?.clientInfo as Record<string, unknown> | undefined;
  if (clientInfo && typeof clientInfo.version === 'string') {
    clientInfo.version = '<version>';
  }
  return clone;
}

export async function recordLegacyTranscript(): Promise<
  Array<Record<string, unknown>>
> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-wire-'));
  const logPath = path.join(dir, 'frames.jsonl');
  try {
    const client = await createMCPClientForConfig({
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(here, 'rawLegacyServer.mjs')],
      env: { RAW_SERVER_LOG: logPath },
      capabilities: { roots: { listChanged: true } },
    });
    await client.listTools();
    await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    await client
      .callTool({ name: 'missing', arguments: {} })
      .catch(() => undefined);
    await closeMCPClient(client);
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => normalize(JSON.parse(line) as Record<string, unknown>));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const frames = await recordLegacyTranscript();
  process.stdout.write(`${JSON.stringify(frames, null, 2)}\n`);
}
