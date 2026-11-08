import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendWriteRecordLine } from '../proxy/writeRecordWriter.js';
import { validateWrites } from '../assertions/validators/writes.js';
import type { CaseExecution } from './caseExecution.js';
import type { EvalCase } from './datasetTypes.js';
import type { TranscriptEvent } from './evalFrameworkTypes.js';
import {
  BatchWriteRecords,
  WriteRecordLedger,
  withWriteRecords,
} from './writeRecord.js';

let dir: string;
let slack: string;
let notes: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-write-ledger-'));
  slack = join(dir, 'slack.jsonl');
  notes = join(dir, 'notes.jsonl');
  // Each proxy lists its write tools when it starts.
  for (const [file, server] of [
    [slack, 'slack'],
    [notes, 'notes'],
  ] as const)
    await appendWriteRecordLine(file, {
      kind: 'tools',
      time,
      server,
      writeTools: ['send_message'],
    });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const time = '2026-11-08T12:00:00.000Z';
const evalCase: EvalCase = { id: 'post', input: 'Post hi' };

async function stopWrite(file: string, server: string, text: string) {
  await appendWriteRecordLine(file, {
    kind: 'write',
    time,
    server,
    tool: 'send_message',
    arguments: { text },
    reply: { content: [{ type: 'text', text: 'Not sent (dry run).' }] },
    mode: 'planned',
  });
}

function call(server: string, text: string): TranscriptEvent {
  return {
    kind: 'tool_call',
    source: 'mcp',
    server,
    name: 'send_message',
    arguments: { text },
  };
}

function completed(events: TranscriptEvent[]): CaseExecution {
  return {
    kind: 'completed',
    response: { success: true, response: 'Done.', events },
    transcript: { events, finalText: 'Done.', evidence: 'full' },
  } as unknown as CaseExecution;
}

describe('withWriteRecords', () => {
  it('keeps the record of a client that wrote and then threw', async () => {
    const ledger = new WriteRecordLedger([slack]);
    const execute = withWriteRecords(async () => {
      await stopWrite(slack, 'slack', 'hi');
      throw new Error('client crashed');
    }, ledger);

    const execution = await execute(evalCase);

    expect(execution).toMatchObject({
      kind: 'failed',
      error: 'client crashed',
      writeRecord: {
        writes: [{ server: 'slack', tool: 'send_message', mode: 'planned' }],
        // No transcript: nothing reports the write.
        unreported: 1,
        attribution: 'exclusive',
      },
    });
  });

  it('keeps the record of a client that wrote and then failed', async () => {
    const ledger = new WriteRecordLedger([slack]);
    const execute = withWriteRecords(async () => {
      await stopWrite(slack, 'slack', 'hi');
      return {
        kind: 'failed',
        response: undefined,
        error: 'turn failed',
        // A record the client set itself never counts.
        writeRecord: {
          writes: [],
          unreported: 0,
          unrecorded: [],
          unclassified: [],
          attribution: 'exclusive',
        },
      };
    }, ledger);

    const execution = await execute(evalCase);

    expect(execution.kind).toBe('failed');
    expect(execution.writeRecord).toMatchObject({
      writes: [{ server: 'slack', arguments: { text: 'hi' } }],
      unreported: 1,
    });
  });

  it("keeps a batch trial's record when its client threw (a worker, a desktop batch)", async () => {
    const batch = new BatchWriteRecords(new WriteRecordLedger([slack]));
    await batch.begin('0:0');
    await stopWrite(slack, 'slack', 'hi');
    // As a one-shot session gives a client that threw.
    const result = await batch.attach('0:0', {
      finalText: '',
      events: [],
      error: 'client crashed',
    });
    expect(result.writeRecord).toMatchObject({
      writes: [{ server: 'slack', tool: 'send_message' }],
      unreported: 1,
    });
  });

  it('gives a write two overlapping trials both report to only one of them', async () => {
    const ledger = new WriteRecordLedger([slack, notes]);
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const execute = withWriteRecords(async () => {
      if (++started === 2) {
        await stopWrite(slack, 'slack', 'hi');
        release();
      }
      await bothStarted;
      return completed([call('slack', 'hi')]);
    }, ledger);

    const [first, second] = await Promise.all([
      execute(evalCase),
      execute(evalCase),
    ]);

    const records = [first.writeRecord!, second.writeRecord!];
    expect(records.map((record) => record.attribution)).toEqual([
      'matched',
      'matched',
    ]);
    expect(records.map((record) => record.writes.length).sort()).toEqual([
      0, 1,
    ]);
    const verdicts = records.map(
      (record) =>
        validateWrites(record, {
          calls: [{ server: 'slack', tool: 'send_message' }],
        }).pass
    );
    expect(verdicts.sort()).toEqual([false, true]);
  });
});
