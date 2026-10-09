/**
 * `mst.shard/v1` (ADR 0004): what a coordinator and a worker exchange. The
 * worker writes one JSON message per line to stdout, the coordinator one per
 * line to its stdin. A shard's work arrives first as a bundle directory.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ClientBatchRequest } from '../evalFrameworkTypes.js';
import type { EvalConfig, EvalVariant } from '../evalConfig.js';

export const SHARD_PROTOCOL = 'mst.shard/v1';

const TrialKeySchema = z.object({
  variant: z.string(),
  caseId: z.string(),
  trial: z.number().int().nonnegative(),
});
/** One trial of a run: a variant's trial of a case. */
export type TrialKey = z.infer<typeof TrialKeySchema>;

const TokenSchema = z.object({
  accessToken: z.string(),
  /** Epoch milliseconds. */
  expiresAt: z.number().optional(),
});

const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.literal(SHARD_PROTOCOL),
    /** The worker's MST version: it must be the coordinator's. */
    mst: z.string(),
    /** The worker image's digest or reference, when the image says. */
    image: z.string().optional(),
    client: z.object({ name: z.string(), version: z.string().optional() }),
  }),
  z.object({
    type: z.literal('need-tokens'),
    servers: z.array(z.string()),
    reason: z.enum(['start', 'expiring']),
  }),
  // Before a trial starts: wait for room under the run's limits. The trial's
  // `trial` message gives it back.
  z.object({ type: z.literal('acquire'), key: TrialKeySchema }),
  z.object({
    type: z.literal('trial'),
    key: TrialKeySchema,
    status: z.enum(['collected', 'infra']),
    /** The result file, relative to the worker's results directory. */
    path: z.string(),
  }),
  z.object({ type: z.literal('heartbeat'), at: z.string() }),
  z.object({
    type: z.literal('done'),
    collected: z.number().int().nonnegative(),
    infra: z.number().int().nonnegative(),
    cancelled: z.boolean(),
    cleanup: z.enum(['ok', 'failed']),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

const CoordinatorMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tokens'),
    /** Access tokens by server label. Refresh grants never leave the coordinator. */
    byServer: z.record(z.string(), TokenSchema),
    /** The run's secrets environment (API keys), kept out of the bundle. */
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal('cancel'), reason: z.string() }),
  z.object({ type: z.literal('granted'), key: TrialKeySchema }),
]);
export type CoordinatorMessage = z.infer<typeof CoordinatorMessageSchema>;
/** What a `tokens` message carries. */
export type ShardTokens = Omit<
  Extract<CoordinatorMessage, { type: 'tokens' }>,
  'type'
>;

/** One message as a line of the protocol. */
export function encodeMessage(
  message: WorkerMessage | CoordinatorMessage
): string {
  return `${JSON.stringify(message)}\n`;
}

function parseLine<T>(schema: z.ZodType<T>, line: string, from: string): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`The ${from} sent a line that isn't JSON: ${line}`);
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      `The ${from} sent a message that isn't ${SHARD_PROTOCOL}: ${line}`
    );
  return result.data;
}

export function parseWorkerMessage(line: string): WorkerMessage {
  return parseLine(WorkerMessageSchema, line, 'worker');
}

export function parseCoordinatorMessage(line: string): CoordinatorMessage {
  return parseLine(CoordinatorMessageSchema, line, 'coordinator');
}

/** Splits chunks of text into lines, holding a partial last line back. */
export async function* lines(
  chunks: AsyncIterable<string | Buffer>
): AsyncGenerator<string> {
  let pending = '';
  for await (const chunk of chunks) {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (pending.trim()) yield pending.trim();
}

/** A shard's requests for one variant, which the worker runs as one batch. */
interface ShardBatch {
  variant: EvalVariant;
  requests: ClientBatchRequest[];
}

const ShardBundleSchema = z.object({
  format: z.literal(SHARD_PROTOCOL),
  kind: z.literal('bundle'),
  runId: z.string(),
  shard: z.object({
    index: z.number().int().nonnegative(),
    count: z.number().int().positive(),
  }),
  /** The coordinator's MST version. */
  mst: z.string(),
  /** Plugin specifiers the worker loads (for its client). */
  plugins: z.array(z.string()),
  evalConfig: z.looseObject({ name: z.string() }),
  /** Servers whose access tokens the worker asks for before it starts. */
  tokenServers: z.array(z.string()),
  batches: z.array(
    z.object({
      variant: z.looseObject({ name: z.string() }),
      requests: z.array(
        z.object({
          caseId: z.string(),
          trial: z.number().int().nonnegative(),
          config: z.looseObject({ type: z.string() }),
          input: z.looseObject({
            prompt: z.string(),
            servers: z.array(z.unknown()),
          }),
        })
      ),
    })
  ),
});

/** A shard's work: everything the worker needs except secrets. */
export interface ShardBundle {
  runId: string;
  shard: { index: number; count: number };
  mst: string;
  plugins: string[];
  evalConfig: EvalConfig;
  tokenServers: string[];
  batches: ShardBatch[];
}

const BUNDLE_FILE = 'bundle.json';

/**
 * Writes a shard's bundle to `dir`. Each request's `input.env` is left out:
 * secrets reach the worker only in a `tokens` message.
 */
export async function writeShardBundle(
  dir: string,
  bundle: ShardBundle
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const batches = bundle.batches.map((batch) => ({
    variant: batch.variant,
    requests: batch.requests.map(({ input, ...request }) => {
      const { env: _secrets, ...rest } = input;
      return { ...request, input: rest };
    }),
  }));
  await fs.writeFile(
    path.join(dir, BUNDLE_FILE),
    `${JSON.stringify({ format: SHARD_PROTOCOL, kind: 'bundle', ...bundle, batches }, null, 2)}\n`
  );
}

/** Reads and checks the bundle in `dir`. */
export async function readShardBundle(dir: string): Promise<ShardBundle> {
  const file = path.join(dir, BUNDLE_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Couldn't read the shard bundle ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const result = ShardBundleSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `${file} isn't a ${SHARD_PROTOCOL} bundle: ${result.error.message}`
    );
  return result.data as unknown as ShardBundle;
}

const ClientResultFileSchema = z.object({
  format: z.literal(SHARD_PROTOCOL),
  kind: z.literal('client-result'),
  key: TrialKeySchema,
  result: z.looseObject({
    finalText: z.string(),
    events: z.array(z.unknown()),
  }),
});
/** A result file a worker writes for one trial. */
export type ClientResultFile = z.infer<typeof ClientResultFileSchema>;

/** Reads a worker's result file, as `mst collect` wrote it. */
export async function readClientResult(
  file: string
): Promise<ClientResultFile> {
  const result = ClientResultFileSchema.safeParse(
    JSON.parse(await fs.readFile(file, 'utf8'))
  );
  if (!result.success)
    throw new Error(`${file} isn't a ${SHARD_PROTOCOL} client result.`);
  return result.data;
}
