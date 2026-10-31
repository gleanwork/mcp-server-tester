/**
 * The trace as a judge reads it (ADR 0009): the user's request, each event
 * the client recorded in order (a tool call with its arguments and result,
 * a skill load, a command), and the final answer.
 *
 * Every value is the run's data, not instructions, so each sits in its own
 * tag and the system prompt says to ignore instructions inside tags. A tag
 * name inside a value is escaped so a tool result can't close its tag
 * early and write outside it.
 */
import type { JudgeInput } from './judgeContract.js';
import type { TraceEvent } from '../evals/evalFrameworkTypes.js';

/** How much of each tool result a judge reads when no size is set (bytes). */
export const DEFAULT_TRACE_OUTPUT_BYTES = 20_000;

export interface JudgeTraceOptions {
  /** Each tool result is cut to this many bytes. @default 20000 */
  maxToolOutputSize?: number;
  /** Show the case's reference answer, when it has one. @default false */
  reference?: boolean;
}

/** The tags the trace uses; a value can't contain one, opening or closing. */
const TAGS = [
  'request',
  'reference_answer',
  'trace',
  'event',
  'arguments',
  'result',
  'final_answer',
];
const TAG_PATTERN = new RegExp(`<(/?)(${TAGS.join('|')})\\b`, 'gi');

/** A value as text, with the trace's own tags escaped. */
function text(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  return raw.replace(TAG_PATTERN, '&lt;$1$2');
}

/** The first `max` bytes of `value`, on a character boundary, and whether it was cut. */
function cut(value: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return { text: value, cut: false };
  // A cut inside a multi-byte character decodes to U+FFFD: drop it.
  const head = bytes
    .subarray(0, max)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return { text: head, cut: true };
}

function attribute(name: string, value: string | undefined): string {
  return value === undefined
    ? ''
    : ` ${name}="${value.replace(/"/g, '&quot;')}"`;
}

function eventView(event: TraceEvent, index: number, max: number): string {
  const name = event.server ? `${event.server}/${event.name}` : event.name;
  const head =
    `<event n="${index + 1}" kind="${event.kind}"` +
    attribute('name', name) +
    (event.isError === true ? ' error="true"' : '') +
    (event.simulatedWrite === true ? ' simulated="true"' : '') +
    '>';
  const lines = [head];
  if (event.arguments !== undefined && Object.keys(event.arguments).length)
    lines.push(`<arguments>\n${text(event.arguments)}\n</arguments>`);
  if (event.results !== undefined)
    lines.push(
      `<result>\n${text(event.results.map((r) => (r.server ? `${r.server}/${r.name}` : r.name)).join('\n'))}\n</result>`
    );
  else if (event.output !== undefined) {
    const escaped = text(event.output);
    const output = cut(escaped, max);
    const total = Buffer.byteLength(escaped, 'utf8');
    lines.push(
      `<result${output.cut ? ` cut="first ${max} of ${total} bytes"` : ''}>\n${output.text}\n</result>`
    );
  } else if (event.kind === 'tool_call')
    lines.push('<result observed="false"/>');
  lines.push('</event>');
  return lines.join('\n');
}

/**
 * The trial as the judge reads it. A trace the client didn't record says so
 * (`observed="false"`), so the judge can answer unknown rather than guess.
 */
export function renderJudgeTrace(
  input: JudgeInput,
  options: JudgeTraceOptions = {}
): string {
  const max = options.maxToolOutputSize ?? DEFAULT_TRACE_OUTPUT_BYTES;
  const { trial } = input;
  const parts = [
    `<request>\n${text(input.case.input.prompt ?? '')}\n</request>`,
  ];
  const reference = input.case.expected.answer;
  if (options.reference && reference !== undefined && reference !== null)
    parts.push(`<reference_answer>\n${text(reference)}\n</reference_answer>`);
  if (trial.evidence === 'none')
    parts.push(
      '<trace observed="false">\nThe client did not report its tool calls.\n</trace>'
    );
  else if (trial.events.length === 0)
    parts.push('<trace>\nThe client made no tool calls.\n</trace>');
  else
    parts.push(
      `<trace>\n${trial.events.map((event, i) => eventView(event, i, max)).join('\n')}\n</trace>`
    );
  parts.push(`<final_answer>\n${text(trial.text)}\n</final_answer>`);
  return parts.join('\n\n');
}
