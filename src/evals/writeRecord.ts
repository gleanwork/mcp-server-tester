/**
 * Each trial's write record (ADR 0014). The dry-run proxies append every
 * write they stop, every write their server marks, and every call they can't
 * classify to one file per server (writeRecordLines.ts). A ledger over those
 * files gives each trial the lines written while it ran, and matches them to
 * the trial's transcript:
 *
 * - A recorded write that matches no call in the transcript is an
 *   unreported write.
 * - A call in the transcript to a write tool of a recorded server, with no
 *   recorded line, is an unrecorded write: it never reached the server.
 *
 * When no other trial ran while a trial did, every line written meanwhile is
 * its own (`attribution: 'exclusive'`). When trials overlap, a trial takes
 * only the lines that match its calls (`matched`), and unreported writes
 * can't be told apart.
 *
 * Matching uses arguments redacted the way transcripts are, so a write with a
 * secret in its arguments is still found. A simulated write's matched
 * transcript events are marked `simulatedWrite`, so judges and reports know
 * the reply was made up.
 */
import { isDeepStrictEqual } from 'node:util';
import type { CaseExecution } from './caseExecution.js';
import type { EvalCase } from './datasetTypes.js';
import type { ClientRunResult, TranscriptEvent } from './evalFrameworkTypes.js';
import { redactedClientRun } from './clientSecrets.js';
import {
  readWriteRecordLines,
  writeRecordLength,
  type NumberedWriteRecordLine,
  type WriteRecordUnclassifiedLine,
  type WriteRecordWriteLine,
} from '../proxy/writeRecordLines.js';
import type {
  RecordedWrite,
  UnclassifiedCall,
  UnrecordedWrite,
  WriteRecord,
} from '../types/index.js';

/** One trial's place in the files: where each stood when it started, and ended. */
export interface TrialWindow {
  start: Map<string, number>;
  /** Set when the trial is over. */
  end?: Map<string, number>;
  /** Another trial ran while this one did. */
  overlapped: boolean;
}

type Line = WriteRecordWriteLine | WriteRecordUnclassifiedLine;

/** `value` redacted as a transcript event's arguments are. */
function redacted(value: unknown, secrets: readonly string[]): unknown {
  if (value === undefined || secrets.length === 0) return value;
  const [event] = redactedClientRun(
    { events: [{ arguments: value }] },
    secrets
  ).events;
  return event?.arguments;
}

function namesTool(event: TranscriptEvent, server: string, tool: string) {
  return event.name === tool || event.name === `${server}.${tool}`;
}

function matches(event: TranscriptEvent, line: Line): boolean {
  return (
    event.kind === 'tool_call' &&
    event.source === 'mcp' &&
    event.server === line.server &&
    namesTool(event, line.server, line.tool) &&
    isDeepStrictEqual(line.arguments ?? {}, event.arguments ?? {})
  );
}

/**
 * The write record files of one run (or one worker), shared by its trials.
 * Each line goes to one trial at most.
 */
export class WriteRecordLedger {
  private readonly claimed = new Set<string>();
  private readonly active = new Set<TrialWindow>();

  constructor(private readonly files: readonly string[]) {}

  get recording(): boolean {
    return this.files.length > 0;
  }

  private async lengths(): Promise<Map<string, number>> {
    const lengths = new Map<string, number>();
    for (const file of this.files)
      lengths.set(file, await writeRecordLength(file));
    return lengths;
  }

  /** Marks where a trial starts. Call before the client gets the case. */
  async begin(): Promise<TrialWindow> {
    const window: TrialWindow = {
      start: await this.lengths(),
      overlapped: this.active.size > 0,
    };
    for (const other of this.active) other.overlapped = true;
    this.active.add(window);
    return window;
  }

  /** Marks where a trial ends. Later lines aren't its own. */
  async close(window: TrialWindow): Promise<void> {
    if (window.end) return;
    this.active.delete(window);
    window.end = await this.lengths();
  }

  /**
   * The trial's write record, from the lines written while `window` was
   * open, matched to `events` (its transcript, redacted with `secrets`).
   * Closes the window if it is still open. Undefined when no proxy records
   * writes.
   */
  async record(
    window: TrialWindow,
    events: readonly TranscriptEvent[],
    secrets: readonly string[] = []
  ): Promise<WriteRecord | undefined> {
    await this.close(window);
    if (!this.recording) return undefined;
    const candidates: Array<{ key: string; line: Line }> = [];
    // The latest write-tool list of each recorded server.
    const writeTools = new Map<string, Set<string>>();
    for (const file of this.files) {
      const numbered: NumberedWriteRecordLine[] =
        await readWriteRecordLines(file);
      const from = window.start.get(file) ?? 0;
      const to = window.end?.get(file) ?? Number.POSITIVE_INFINITY;
      for (const { line, record } of numbered) {
        if (record.kind === 'tools') {
          if (line < to)
            writeTools.set(record.server, new Set(record.writeTools));
          continue;
        }
        const key = `${file}\0${line}`;
        if (line < from || line >= to || this.claimed.has(key)) continue;
        candidates.push({
          key,
          line: {
            ...record,
            arguments: redacted(record.arguments, secrets),
            ...(record.kind === 'write'
              ? { reply: redacted(record.reply, secrets) }
              : {}),
          },
        });
      }
    }
    if (writeTools.size === 0 && candidates.length === 0) return undefined;

    // Each call takes the first unclaimed line it matches.
    const matchedBy = new Map<string, TranscriptEvent>();
    const unrecorded: UnrecordedWrite[] = [];
    for (const event of events) {
      if (event.kind !== 'tool_call' || event.source !== 'mcp') continue;
      const match = candidates.find(
        ({ key, line }) => !matchedBy.has(key) && matches(event, line)
      );
      if (match) {
        matchedBy.set(match.key, event);
        continue;
      }
      const server = event.server;
      const tools = server === undefined ? undefined : writeTools.get(server);
      if (!server || !tools) continue;
      const tool = event.name.startsWith(`${server}.`)
        ? event.name.slice(server.length + 1)
        : event.name;
      if (tools.has(tool))
        unrecorded.push({
          server,
          tool,
          ...(event.id !== undefined ? { eventId: event.id } : {}),
        });
    }

    const exclusive = !window.overlapped;
    const taken = candidates.filter(
      ({ key }) => exclusive || matchedBy.has(key)
    );
    for (const { key } of taken) this.claimed.add(key);
    const writes: RecordedWrite[] = [];
    const unclassified: UnclassifiedCall[] = [];
    let unreported = 0;
    for (const { key, line } of taken) {
      const event = matchedBy.get(key);
      if (line.kind === 'unclassified') {
        unclassified.push({
          server: line.server,
          tool: line.tool,
          arguments: line.arguments ?? {},
          reason: line.reason,
          ...(line.target !== undefined ? { target: line.target } : {}),
        });
        continue;
      }
      if (!event) unreported++;
      writes.push({
        server: line.server,
        tool: line.tool,
        arguments: line.arguments ?? {},
        ...(line.reply !== undefined ? { reply: line.reply } : {}),
        mode: line.mode,
        ...(line.target !== undefined ? { target: line.target } : {}),
        ...(event?.id !== undefined ? { eventId: event.id } : {}),
      });
    }
    return {
      writes,
      unreported,
      unrecorded,
      unclassified,
      attribution: exclusive ? 'exclusive' : 'matched',
    };
  }
}

/**
 * Marks the events in each list that a simulated write in `writes` answered,
 * each write at most once per list. The transcript and the response may hold
 * the same event objects, or copies; `toolCalls` may name a tool
 * `<server>.<tool>`.
 */
function markSimulatedWrites(
  lists: ReadonlyArray<readonly TranscriptEvent[]>,
  writes: readonly RecordedWrite[]
): void {
  const simulated = writes.filter((write) => write.mode === 'simulated');
  if (simulated.length === 0) return;
  for (const events of lists) {
    const used = new Set<RecordedWrite>();
    for (const event of events) {
      const write = simulated.find(
        (candidate) =>
          !used.has(candidate) &&
          event.server === candidate.server &&
          (event.source === undefined || event.source === 'mcp') &&
          namesTool(event, candidate.server, candidate.tool) &&
          isDeepStrictEqual(candidate.arguments ?? {}, event.arguments ?? {})
      );
      if (!write) continue;
      used.add(write);
      event.simulatedWrite = true;
    }
  }
}

type Executor = (evalCase: EvalCase) => Promise<CaseExecution>;

/**
 * `executor`, with each completed trial's write record attached
 * (`writeRecord`). `executor` returns redacted transcripts, so each line is
 * redacted with the same `secrets` before it is matched.
 */
export function withWriteRecords(
  executor: Executor,
  ledger: WriteRecordLedger,
  secrets: () => readonly string[] = () => []
): Executor {
  if (!ledger.recording)
    return async (evalCase) => withoutWriteRecord(await executor(evalCase));
  return async (evalCase) => {
    const window = await ledger.begin();
    let execution: CaseExecution;
    try {
      execution = await executor(evalCase);
    } catch (error) {
      await ledger.close(window);
      throw error;
    }
    if (execution.kind !== 'completed') {
      await ledger.close(window);
      return execution;
    }
    const { toolCalls } = execution.response as { toolCalls?: unknown };
    const lists = [
      execution.transcript?.events,
      execution.response.events,
      toolCalls,
    ].filter((events): events is TranscriptEvent[] => Array.isArray(events));
    const events =
      execution.transcript?.events ?? execution.response.events ?? [];
    const record = await ledger.record(window, events, secrets());
    if (record) markSimulatedWrites(lists, record.writes);
    const own = withoutWriteRecord(execution);
    return record ? { ...own, writeRecord: record } : own;
  };
}

/** `execution` without a write record a client set itself: only MST's counts. */
function withoutWriteRecord(execution: CaseExecution): CaseExecution {
  if (execution.kind !== 'completed' || !('writeRecord' in execution))
    return execution;
  const { writeRecord: _own, ...rest } = execution;
  return rest;
}

/**
 * The write records of one batch's trials, which run one at a time: a trial's
 * window opens when it starts (`begin`, from the batch's `acquire`) and
 * closes when the next one starts. `attach` gives a result its trial's
 * record, worked out once however often the result is reported. Used where
 * results are collected before they are graded: a desktop batch, and a
 * shard's worker, whose proxies record writes on its own machine.
 */
export class BatchWriteRecords {
  private readonly windows = new Map<string, TrialWindow>();
  private readonly records = new Map<
    string,
    Promise<WriteRecord | undefined>
  >();

  constructor(
    private readonly ledger: WriteRecordLedger,
    private readonly secrets: () => readonly string[] = () => []
  ) {}

  /** The trial `key` starts: the one before it is over. */
  async begin(key: string): Promise<void> {
    if (!this.ledger.recording || this.windows.has(key)) return;
    for (const window of this.windows.values()) await this.ledger.close(window);
    this.windows.set(key, await this.ledger.begin());
  }

  /**
   * `result` redacted with the batch's secrets, without a record the client
   * set itself, and with its trial's write record and simulated writes
   * marked. A trial that never started (its servers weren't ready) has none.
   */
  async attach(key: string, result: ClientRunResult): Promise<ClientRunResult> {
    const { writeRecord: _own, ...clientResult } = result;
    const secrets = this.secrets();
    const redactedResult = redactedClientRun(clientResult, secrets);
    const window = this.windows.get(key);
    if (!window) return redactedResult;
    let record = this.records.get(key);
    if (!record) {
      record = this.ledger.record(window, redactedResult.events, secrets);
      this.records.set(key, record);
    }
    const recorded = await record;
    if (!recorded) return redactedResult;
    const events = redactedResult.events.map((event) => ({ ...event }));
    markSimulatedWrites([events], recorded.writes);
    return { ...redactedResult, events, writeRecord: recorded };
  }
}
