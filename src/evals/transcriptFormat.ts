/**
 * A trial's transcript as `mst.run/v1` stores it. A run's trial records and
 * case results hold one (`runFormat.ts`), and every client's result is
 * checked against it where it enters MST (`checkedClientEvents`), so MST
 * never writes a run it can't read back.
 */
import { z } from 'zod';
import type { TranscriptEvent } from './evalFrameworkTypes.js';

/**
 * One transcript event: a tool call, skill load, command, subagent or tool
 * search. Its `kind` and `source` are values the format names, so they are
 * closed: metrics and graders count events by them.
 */
const TranscriptEventSchema = z.looseObject({
  kind: z.enum(['tool_call', 'skill', 'command', 'subagent', 'tool_search']),
  source: z.enum(['mcp', 'builtin']).optional(),
  /** With `server`, the tool's name exactly as that server lists it. */
  name: z.string(),
  server: z.string().optional(),
  arguments: z.looseObject({}).optional(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
  id: z.string().optional(),
  durationMs: z.number().optional(),
});

/**
 * A trial's transcript, as a run stores it: what the client did. A run that
 * redacts responses drops `finalText` and event outputs.
 */
export const TranscriptSchema = z.looseObject({
  events: z.array(TranscriptEventSchema),
  finalText: z.string().optional(),
  modelCalls: z.array(z.looseObject({})).optional(),
  usage: z.looseObject({}).optional(),
  hostTelemetry: z.looseObject({}).optional(),
  evidence: z.enum(['structured', 'observed', 'none']).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

/**
 * The fields of a stored transcript this MST doesn't know: a newer MST or
 * client recorded them. A regrade keeps them (`storedExecution`).
 */
export function unknownTranscriptFields(
  transcript: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(transcript).filter(
      ([key]) => !Object.hasOwn(TranscriptSchema.shape, key)
    )
  );
}

/**
 * A client's events, checked against the stored shape. A duration that
 * isn't a finite number is dropped (JSON would store `null`); anything else
 * the format can't store fails the trial with what is wrong, rather than
 * writing a run no reader accepts.
 */
export function checkedClientEvents(
  events: TranscriptEvent[]
): TranscriptEvent[] {
  const normalized = events.map((event) => {
    if (event.durationMs === undefined || Number.isFinite(event.durationMs))
      return event;
    const { durationMs: _dropped, ...rest } = event;
    return rest;
  });
  const parsed = z.array(TranscriptEventSchema).safeParse(normalized);
  if (!parsed.success)
    throw new Error(
      `A client returned transcript events MST can't store: ${z.prettifyError(parsed.error)}`
    );
  return normalized;
}
