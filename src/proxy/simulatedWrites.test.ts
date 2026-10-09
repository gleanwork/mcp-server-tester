import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  minimalValue,
  readSimulatedWrites,
  recordSimulatedWrite,
  renderReplyTemplate,
  simulatedReply,
} from './simulatedWrites.js';

const now = new Date('2026-10-08T12:00:00.123Z');
const context = { id: 'abc123', now, arguments: { channel: 'C1', n: 3 } };

describe('renderReplyTemplate', () => {
  it('fills placeholders, keeping an argument value whole when it is the whole string', () => {
    expect(
      renderReplyTemplate(
        {
          channel: '{{arguments.channel}}',
          count: '{{arguments.n}}',
          link: 'https://slack.example/{{arguments.channel}}/p{{id}}',
          ts: '{{unixTime}}',
          at: '{{now}}',
          list: ['{{id}}'],
          unknown: '{{nope}}',
          missing: '{{arguments.absent}}',
        },
        context
      )
    ).toEqual({
      channel: 'C1',
      count: 3,
      link: 'https://slack.example/C1/pabc123',
      ts: '1791460800.123000',
      at: '2026-10-08T12:00:00.123Z',
      list: ['abc123'],
      unknown: '{{nope}}',
      missing: '{{arguments.absent}}',
    });
  });
});

describe('minimalValue', () => {
  it('builds the required fields with values of their types', () => {
    expect(
      minimalValue(
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            state: { enum: ['open', 'closed'] },
            count: { type: 'integer', minimum: 1 },
            labels: { type: 'array' },
            owner: {
              type: 'object',
              properties: { login: { type: 'string' } },
              required: ['login'],
            },
            optional: { type: 'string' },
          },
          required: ['id', 'created', 'state', 'count', 'labels', 'owner'],
        },
        context
      )
    ).toEqual({
      id: 'abc123',
      created: '2026-10-08T12:00:00.123Z',
      state: 'open',
      count: 1,
      labels: [],
      owner: { login: 'abc123' },
    });
  });
});

describe('simulatedReply', () => {
  const tool = (outputSchema?: Record<string, unknown>) =>
    ({
      name: 't',
      inputSchema: { type: 'object' },
      ...(outputSchema ? { outputSchema } : {}),
    }) as never;

  it('prefers the template, then the outputSchema, then a generic reply', () => {
    const fixed = { id: 'x1', now };
    const schema = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    expect(
      simulatedReply(tool(schema), 't', { a: 1 }, { t: { done: true } }, fixed)
    ).toEqual({
      content: [{ type: 'text', text: '{"done":true}' }],
      structuredContent: { done: true },
    });
    expect(simulatedReply(tool(schema), 't', { a: 1 }, {}, fixed)).toEqual({
      content: [{ type: 'text', text: '{"id":"x1"}' }],
      structuredContent: { id: 'x1' },
    });
    // Without an outputSchema, a tool answers in text only.
    expect(simulatedReply(tool(), 't', { a: 1 }, {}, fixed)).toEqual({
      content: [
        { type: 'text', text: '{"ok":true,"id":"x1","result":{"a":1}}' },
      ],
    });
    expect(
      simulatedReply(undefined, 't', {}, { t: 'Message sent.' }, fixed)
    ).toEqual({ content: [{ type: 'text', text: 'Message sent.' }] });
  });
});

describe('simulated-writes file', () => {
  it('appends records and reads them back, skipping a cut-off line', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-writes-'));
    try {
      const file = join(dir, 'slack.jsonl');
      expect(await readSimulatedWrites(file)).toEqual([]);
      const record = {
        time: now.toISOString(),
        server: 'slack',
        tool: 'send',
        arguments: { text: 'hi' },
        reply: { ok: true },
      };
      await recordSimulatedWrite(file, record);
      await fs.appendFile(file, '{"format":"mst.simulated-write/v1","ti');
      expect(await readSimulatedWrites(file)).toEqual([
        { format: 'mst.simulated-write/v1', ...record },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
