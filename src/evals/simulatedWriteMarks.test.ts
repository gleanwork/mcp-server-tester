import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withSimulatedWriteMarks } from './simulatedWriteMarks.js';
import { recordSimulatedWrite } from '../proxy/simulatedWrites.js';
import type { CaseExecution } from './caseExecution.js';
import type { TraceEvent } from './evalFrameworkTypes.js';

const call = (
  name: string,
  args: Record<string, unknown>,
  server = 'slack'
): TraceEvent => ({
  kind: 'tool_call',
  source: 'mcp',
  server,
  name,
  arguments: args,
  output: 'ok',
});

const completed = (events: TraceEvent[]): CaseExecution => ({
  kind: 'completed',
  response: { success: true, response: '', toolCalls: [], events } as never,
  trace: { events, finalText: '' } as never,
});

describe('withSimulatedWriteMarks', () => {
  it("marks each trial's simulated writes once, by server, tool and arguments", async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-marks-'));
    try {
      const file = join(dir, 'slack.jsonl');
      const write = (tool: string, args: Record<string, unknown>) =>
        recordSimulatedWrite(file, {
          time: '',
          server: 'slack',
          tool,
          arguments: args,
          reply: '',
        });
      // Both trials' writes are recorded before either is marked, as a batch
      // client runs every case first.
      await write('send', { text: 'one' });
      await write('send', { text: 'two' });

      const trials = [
        [call('search', {}), call('send', { text: 'one' })],
        [
          call('send', { text: 'two' }),
          // Same tool and arguments as trial 1's write, which is used up.
          call('send', { text: 'one' }),
          call('send', { text: 'two' }, 'linear'),
        ],
      ];
      let index = 0;
      const execute = withSimulatedWriteMarks(
        async () => completed(trials[index++]!),
        [file]
      );
      const marks = async () =>
        (
          (await execute({ id: 'c' } as never)) as {
            trace: { events: TraceEvent[] };
          }
        ).trace.events.map((event) => event.simulatedWrite === true);
      expect(await marks()).toEqual([false, true]);
      expect(await marks()).toEqual([true, false, false]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("marks the response's own tool calls, named <server>.<tool>", async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'mst-marks-'));
    try {
      const file = join(dir, 'slack.jsonl');
      await recordSimulatedWrite(file, {
        time: '',
        server: 'slack',
        tool: 'send',
        arguments: { text: 'one' },
        reply: '',
      });
      const events = [call('send', { text: 'one' })];
      const toolCalls = [
        call('slack.search', {}),
        call('slack.send', { text: 'one' }),
      ];
      const execute = withSimulatedWriteMarks(
        async () => ({
          kind: 'completed',
          response: {
            success: true,
            response: '',
            toolCalls,
            events: events.map((event) => ({ ...event })),
          } as never,
          trace: { events, finalText: '' } as never,
        }),
        [file]
      );
      const execution = (await execute({ id: 'c' } as never)) as {
        trace: { events: TraceEvent[] };
        response: { events: TraceEvent[]; toolCalls: TraceEvent[] };
      };
      const marked = (list: TraceEvent[]) =>
        list.map((event) => event.simulatedWrite === true);
      expect(marked(execution.trace.events)).toEqual([true]);
      expect(marked(execution.response.events)).toEqual([true]);
      expect(marked(execution.response.toolCalls)).toEqual([false, true]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a failed trial alone', async () => {
    const failed: CaseExecution = {
      kind: 'failed',
      response: undefined,
      error: 'boom',
    };
    expect(
      await withSimulatedWriteMarks(async () => failed, [])({} as never)
    ).toBe(failed);
  });
});
