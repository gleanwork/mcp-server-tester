/**
 * Simulated writes: the dry-run proxy's other answer to a write. Instead of a
 * planned-write result, which tells the client the write didn't happen, the
 * client gets a success reply, so it carries on as it would after a real
 * write. The write never reaches the server; the proxy records it in a JSONL
 * file MST reads after each trial.
 *
 * The reply, in order of preference:
 *
 * 1. The connector's template for the tool (`replies`), with placeholders
 *    filled in from the call.
 * 2. A minimal object that satisfies the tool's `outputSchema`, when it has
 *    one.
 * 3. `{ "ok": true, "id": "<id>", "result": <the call's arguments> }`.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';

/** Where to record simulated writes, and the replies to give. */
export interface SimulatedWritesOptions {
  /**
   * The JSONL file each simulated write is appended to (created private).
   * MST passes it to a connector's `launch` as `simulateWrites.file`.
   */
  file: string;
  /**
   * Reply templates by tool name: any JSON. A string that is exactly
   * `{{arguments.<path>}}` becomes that argument's value; inside a longer
   * string, its text. `{{id}}` is a fresh ID for the call, `{{now}}` the
   * time (ISO 8601) and `{{unixTime}}` the time in seconds with
   * microseconds (`1760000000.123456`, Slack's `ts` form).
   */
  replies?: Readonly<Record<string, unknown>>;
}

/** One line of the simulated-writes file. */
const SimulatedWriteRecordSchema = z.object({
  format: z.literal('mst.simulated-write/v1'),
  time: z.string(),
  /** The server's label. */
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  /** What the client was told. */
  reply: z.unknown(),
});
export type SimulatedWriteRecord = z.infer<typeof SimulatedWriteRecordSchema>;

/** A tool call result, as the proxy returns it. */
export interface SimulatedReply {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/** What a template's placeholders are filled from. */
interface ReplyContext {
  arguments: unknown;
  id: string;
  now: Date;
}

const WHOLE_PLACEHOLDER = /^\{\{\s*([\w.]+)\s*\}\}$/;
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function placeholder(name: string, context: ReplyContext): unknown {
  if (name === 'id') return context.id;
  if (name === 'now') return context.now.toISOString();
  if (name === 'unixTime') {
    const ms = context.now.getTime();
    return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
  }
  if (name === 'arguments' || name.startsWith('arguments.')) {
    let value: unknown = context.arguments;
    for (const key of name.split('.').slice(1)) {
      if (typeof value !== 'object' || value === null) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  return undefined;
}

/** `template` with its placeholders filled in. Unknown placeholders stay. */
export function renderReplyTemplate(
  template: unknown,
  context: ReplyContext
): unknown {
  if (typeof template === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(template);
    if (whole) {
      const value = placeholder(whole[1]!, context);
      return value === undefined ? template : value;
    }
    return template.replace(PLACEHOLDER, (match, name: string) => {
      const value = placeholder(name, context);
      if (value === undefined) return match;
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template))
    return template.map((item) => renderReplyTemplate(item, context));
  if (typeof template === 'object' && template !== null)
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        renderReplyTemplate(value, context),
      ])
    );
  return template;
}

/**
 * The smallest value `schema` (JSON Schema) accepts that a client would take
 * for a real one: required properties only, IDs and links from `id`.
 */
export function minimalValue(
  schema: unknown,
  context: ReplyContext,
  depth = 0
): unknown {
  if (typeof schema !== 'object' || schema === null || depth > 8)
    return undefined;
  const s = schema as Record<string, unknown>;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if ('default' in s) return s.default;
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const)
    if (Array.isArray(s[key]) && s[key].length)
      return minimalValue(s[key][0], context, depth + 1);
  const types: unknown[] = Array.isArray(s.type) ? s.type : [s.type];
  const type: unknown = types.find((t) => t !== 'null') ?? types[0];
  switch (type ?? (s.properties ? 'object' : undefined)) {
    case 'object': {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required)
        ? (s.required as string[])
        : [];
      return Object.fromEntries(
        required.map((key) => [
          key,
          minimalValue(properties[key], context, depth + 1) ?? null,
        ])
      );
    }
    case 'array':
      return [];
    case 'string':
      if (s.format === 'date-time') return context.now.toISOString();
      if (s.format === 'date') return context.now.toISOString().slice(0, 10);
      if (s.format === 'uri' || s.format === 'url')
        return `https://example.com/${context.id}`;
      if (s.format === 'email') return `${context.id}@example.com`;
      return context.id;
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return undefined;
  }
}

/** A fresh ID for one simulated call. */
export function simulatedWriteId(): string {
  return randomBytes(8).toString('hex');
}

/** The reply a simulated write gets (see the module comment). */
export function simulatedReply(
  tool: Tool | undefined,
  name: string,
  args: unknown,
  replies: Readonly<Record<string, unknown>> = {},
  context: Omit<ReplyContext, 'arguments'> = {
    id: simulatedWriteId(),
    now: new Date(),
  }
): SimulatedReply {
  const full: ReplyContext = { ...context, arguments: args ?? {} };
  const schema = tool?.outputSchema;
  let value: unknown;
  if (Object.hasOwn(replies, name))
    value = renderReplyTemplate(replies[name], full);
  else if (schema) value = minimalValue(schema, full);
  if (value === undefined)
    value = { ok: true, id: full.id, result: full.arguments };
  const structured =
    schema &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    // A tool with an outputSchema returns structured content; others text.
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Appends one simulated write to `file`, which only its owner can read. */
export async function recordSimulatedWrite(
  file: string,
  record: Omit<SimulatedWriteRecord, 'format'>
): Promise<void> {
  const line: SimulatedWriteRecord = {
    format: 'mst.simulated-write/v1',
    ...record,
  };
  await appendFile(file, `${JSON.stringify(line)}\n`, {
    mode: 0o600,
    flag: 'a',
  });
}

/** The simulated writes in `file`, in order; none when it doesn't exist yet. */
export async function readSimulatedWrites(
  file: string
): Promise<SimulatedWriteRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed = SimulatedWriteRecordSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        // A line cut short by a proxy that was killed mid-write.
        return [];
      }
    });
}
