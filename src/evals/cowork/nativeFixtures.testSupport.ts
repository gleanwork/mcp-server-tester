import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { onTestFinished } from 'vitest';
import { createCoworkNativeEvidence } from './nativeEvidence.js';
import type { CoworkEvidenceResult } from './types.js';

export type NativeRecord = Record<string, unknown>;
export function prompt(text: string): NativeRecord {
  return {
    type: 'user',
    uuid: 'user-one',
    message: { role: 'user', content: text },
  };
}
export function tool(
  name = 'Read',
  id: string | undefined = 'call-one',
  input: unknown = {}
): NativeRecord {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  };
}
export function result(text = 'NATIVE_NONCE'): NativeRecord {
  return { type: 'result', result: text, request_id: 'native-request' };
}
export function endTurn(text = 'NATIVE_NONCE'): NativeRecord {
  return {
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  };
}
export async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cowork-test-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function emitSession(
  dataDir: string,
  text: string,
  options: {
    id?: string;
    metadataPrompt?: string;
    audit?: NativeRecord[] | string;
    transcript?: NativeRecord[] | string | null;
  } = {}
): Promise<void> {
  const id = options.id ?? 'local_synthetic';
  const dir = join(dataDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dataDir, `${id}.json`),
    JSON.stringify({
      sessionId: id,
      cliSessionId: 'cli-synthetic',
      createdAt: Date.now(),
      initialMessage: options.metadataPrompt ?? text,
    })
  );
  const defaults = [
    prompt(text),
    tool('mcp__fixture__get_eval_nonce'),
    result(),
  ];
  await writeStream(join(dir, 'audit.jsonl'), options.audit ?? defaults);
  if (options.transcript !== null)
    await writeStream(
      join(dir, 'cli-synthetic.jsonl'),
      options.transcript ?? defaults
    );
}
async function writeStream(
  path: string,
  events: NativeRecord[] | string
): Promise<void> {
  await writeFile(path, serializeStream(events));
}
function serializeStream(events: NativeRecord[] | string): string {
  return typeof events === 'string'
    ? events
    : events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}
export async function nativeFixture() {
  const dataDir = await temporaryDirectory();
  const evidence = createCoworkNativeEvidence({
    mcpServerPrefixes: { mcp__fixture__: 'fixture' },
  });
  const snapshot = await evidence.snapshot(dataDir);
  const marker = `synthetic_${randomUUID()}`;
  const expectedPrompt = `Return the exact nonce.\n\n${marker}`;
  const startedAtMs = Date.now();
  return {
    dataDir,
    marker,
    expectedPrompt,
    async emit(options?: Parameters<typeof emitSession>[2]) {
      await emitSession(dataDir, expectedPrompt, options);
    },
    async append(
      stream: 'audit' | 'transcript',
      events: NativeRecord[] | string
    ) {
      await appendFile(
        join(
          dataDir,
          'local_synthetic',
          stream === 'audit' ? 'audit.jsonl' : 'cli-synthetic.jsonl'
        ),
        serializeStream(events)
      );
    },
    async collect(timeoutMs = 3000): Promise<CoworkEvidenceResult> {
      return evidence.collect({
        dataDir,
        snapshot,
        marker,
        startedAtMs,
        timeoutMs,
        expectedPrompt,
      });
    },
  };
}
