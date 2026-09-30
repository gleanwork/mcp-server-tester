// Drives MST's client against the scripted raw legacy server and returns the
// normalized recording of what the client put on the wire.
//
// Used by src/mcp/wireCompat.test.ts. Also runnable directly to regenerate the
// golden transcripts from a given checkout:
//   node --import tsx tests/mocks/recordLegacyTranscript.ts stdio > stdio.json
//   node --import tsx tests/mocks/recordLegacyTranscript.ts http > http.json
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../src/mcp/clientFactory.js';
import type { MCPConfig } from '../../src/config/mcpConfig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, 'rawLegacyServer.mjs');

type Frame = Record<string, unknown>;

/** Replace fields that legitimately vary between runs and releases. */
function normalize(entry: Frame): Frame {
  const clone = JSON.parse(JSON.stringify(entry)) as Frame;
  const message = (clone.body ?? clone) as Frame;
  const params = message.params as Frame | undefined;
  const clientInfo = params?.clientInfo as Frame | undefined;
  if (clientInfo && typeof clientInfo.version === 'string') {
    clientInfo.version = '<version>';
  }
  return clone;
}

/** Runs the standard legacy session: list, call, call an unknown tool. */
async function exercise(config: MCPConfig): Promise<void> {
  const client = await createMCPClientForConfig(config);
  await client.listTools();
  await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
  await client
    .callTool({ name: 'missing', arguments: {} })
    .catch((error: unknown) => {
      // The scripted server answers -32602; anything else is a real failure.
      // (Checked by shape: the recorder also runs on v1, whose class differs.)
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== -32602) throw error;
    });
  await closeMCPClient(client);
}

function readLog(logPath: string): Frame[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => normalize(JSON.parse(line) as Frame));
}

export async function recordLegacyTranscript(): Promise<Frame[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-wire-'));
  const logPath = path.join(dir, 'frames.jsonl');
  try {
    await exercise({
      transport: 'stdio',
      command: process.execPath,
      args: [serverScript],
      env: { RAW_SERVER_LOG: logPath },
      capabilities: { roots: { listChanged: true } },
    });
    return readLog(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function recordLegacyHttpTranscript(): Promise<Frame[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-wire-http-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const child = spawn(process.execPath, [serverScript, '--http', '0'], {
    env: { ...process.env, RAW_SERVER_LOG: logPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const serverUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('raw legacy server did not start')),
        10_000
      );
      child.stderr.on('data', (chunk: Buffer) => {
        const url = /raw legacy server on (\S+)/.exec(chunk.toString())?.[1];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
    });
    await exercise({
      transport: 'http',
      serverUrl,
      capabilities: { roots: { listChanged: true } },
    });
    return readLog(logPath);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const frames =
    process.argv[2] === 'http'
      ? await recordLegacyHttpTranscript()
      : await recordLegacyTranscript();
  process.stdout.write(`${JSON.stringify(frames, null, 2)}\n`);
}
