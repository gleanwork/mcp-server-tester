/**
 * Simulated writes in traces: the dry-run proxy answered some tool calls with
 * a success reply it made up (eval config `simulateWrites`). After each trial,
 * the writes the proxies recorded are matched to the trial's tool calls
 * (same server, tool and arguments), and each match is marked
 * `simulatedWrite: true`, so graders and reports know the write didn't happen.
 * That is in the trace's events and in the client response's own copies
 * (`events`, and `toolCalls`, which may name the tool `<server>.<tool>`).
 */
import { isDeepStrictEqual } from 'node:util';
import type { CaseExecution } from './caseExecution.js';
import type { EvalCase } from './datasetTypes.js';
import type { TraceEvent } from './evalFrameworkTypes.js';
import {
  readSimulatedWrites,
  type SimulatedWriteRecord,
} from '../proxy/simulatedWrites.js';

type Executor = (evalCase: EvalCase) => Promise<CaseExecution>;

/**
 * Marks the tool calls in `events` that `records` simulated, each record at
 * most once (`used` holds the ones already matched, across trials).
 * Returns how many it marked.
 */
function markSimulatedWrites(
  events: readonly TraceEvent[],
  records: ReadonlyArray<{ key: string; record: SimulatedWriteRecord }>,
  used: Set<string>
): number {
  let marked = 0;
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.source !== 'mcp') continue;
    const match = records.find(
      ({ key, record }) =>
        !used.has(key) &&
        record.server === event.server &&
        (record.tool === event.name ||
          `${record.server}.${record.tool}` === event.name) &&
        isDeepStrictEqual(record.arguments ?? {}, event.arguments ?? {})
    );
    if (!match) continue;
    used.add(match.key);
    event.simulatedWrite = true;
    marked++;
  }
  return marked;
}

/**
 * `executor`, with each completed trial's simulated writes marked. `files`
 * are the proxies' records (see `ConnectorLaunchContext.simulateWrites`).
 */
export function withSimulatedWriteMarks(
  executor: Executor,
  files: readonly string[]
): Executor {
  const used = new Set<string>();
  return async (evalCase) => {
    const execution = await executor(evalCase);
    if (execution.kind !== 'completed') return execution;
    const records = (
      await Promise.all(
        files.map(async (file) =>
          (await readSimulatedWrites(file)).map((record, index) => ({
            key: `${file}\0${index}`,
            record,
          }))
        )
      )
    ).flat();
    if (records.length === 0) return execution;
    // The trace and the response may hold the same event objects, or copies.
    const { toolCalls } = execution.response as { toolCalls?: unknown };
    const lists = [
      execution.trace?.events,
      execution.response.events,
      toolCalls,
    ].filter((events): events is TraceEvent[] => Array.isArray(events));
    const seen = new Set<string>(used);
    for (const events of lists) {
      const local = new Set(seen);
      markSimulatedWrites(events, records, local);
      for (const key of local) used.add(key);
    }
    return execution;
  };
}
