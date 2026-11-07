import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWriteRecordLines, writeRecordLength } from './writeRecordLines.js';
import { WRITE_RECORD_FORMAT } from './writeRecordFormat.js';
import { appendWriteRecordLine } from './writeRecordWriter.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-write-record-'));
  file = join(dir, 'slack.jsonl');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const time = '2026-10-08T12:00:00.000Z';

describe('the write record file', () => {
  it('has no lines before the proxy writes one', async () => {
    expect(await readWriteRecordLines(file)).toEqual([]);
    expect(await writeRecordLength(file)).toBe(0);
  });

  it('reads back each kind of line, in order, with its position', async () => {
    await appendWriteRecordLine(file, {
      kind: 'tools',
      time,
      server: 'slack',
      writeTools: ['send_message'],
    });
    await appendWriteRecordLine(file, {
      kind: 'write',
      time,
      server: 'slack',
      tool: 'send_message',
      arguments: { text: 'hi' },
      reply: { ok: true },
      mode: 'simulated',
    });
    await appendWriteRecordLine(file, {
      kind: 'unclassified',
      time,
      server: 'slack',
      tool: 'run_action',
      arguments: { action: 'post' },
      target: 'post',
      reason: 'dispatch',
    });
    const lines = await readWriteRecordLines(file);
    expect(lines.map(({ line, record }) => [line, record.kind])).toEqual([
      [0, 'tools'],
      [1, 'write'],
      [2, 'unclassified'],
    ]);
    expect(lines[1]!.record).toEqual({
      format: WRITE_RECORD_FORMAT,
      kind: 'write',
      time,
      server: 'slack',
      tool: 'send_message',
      arguments: { text: 'hi' },
      reply: { ok: true },
      mode: 'simulated',
    });
    expect(await writeRecordLength(file)).toBe(3);
  });

  it('keeps positions stable past a malformed line and ignores a cut-off last line', async () => {
    await fs.writeFile(file, 'not json\n');
    await appendWriteRecordLine(file, {
      kind: 'write',
      time,
      server: 'slack',
      tool: 'send_message',
      arguments: {},
      reply: {},
      mode: 'planned',
    });
    await fs.appendFile(file, `{"format":"${WRITE_RECORD_FORMAT}","ki`);
    const lines = await readWriteRecordLines(file);
    expect(lines.map(({ line }) => line)).toEqual([1]);
    // The cut-off line isn't counted: the next trial starts after line 1.
    expect(await writeRecordLength(file)).toBe(2);
  });

  it('is readable only by its owner', async () => {
    await appendWriteRecordLine(file, {
      kind: 'tools',
      time,
      server: 'slack',
      writeTools: [],
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
