/**
 * The host's own OpenTelemetry, recorded with each trial (`telemetry.host`,
 * docs/telemetry.md). MST runs an OTLP/HTTP receiver beside the client and
 * points the host's exporter at it; each trial then takes the records of its
 * own session (`collect`). What the host reports and MST's record can't see
 * (a request's time to first token and cost, permission decisions, retries,
 * hooks) joins the trial's record, and its trace.
 *
 * The receiver takes OTLP/JSON only: MST asks every host for `http/json`.
 * It listens on a random port, on loopback unless the client asks for more
 * (Cowork's VM reaches it through its host's address), under a random path
 * that only the host's settings name. With `forward`, it also sends what it
 * got, as it got it, on to a collector: where the telemetry went before.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import type { HostTelemetryConfig } from '../evalConfig.js';
import { isHostContentAttribute } from './hostContent.js';
import type {
  HostAttributeValue,
  HostTelemetry,
  ModelCall,
  HostTelemetryEvent,
  HostTelemetryMetric,
  HostTelemetrySpan,
} from '../evalFrameworkTypes.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** The most records of each kind one trial keeps. */
const MAX_RECORDS = 5_000;
/** Records nobody collected are forgotten after this long. */
const UNCLAIMED_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_CHARS = 4_096;
const FORWARD_ATTEMPTS = 3;
const FORWARD_TIMEOUT_MS = 10_000;

/** What OTLP signals the receiver takes, by path. */
type Signal = 'logs' | 'metrics' | 'traces';

/** Who ran the host: not the trial's, and kept out of its record. */
function isIdentity(key: string): boolean {
  return (
    key.startsWith('user.') ||
    key === 'enduser.id' ||
    key === 'organization.id' ||
    key === 'host.name'
  );
}

/** The attributes that name a record's session, in order. */
const SESSION_ATTRIBUTES = [
  'session.id',
  'session_id',
  'gen_ai.conversation.id',
  'conversation.id',
  'conversation_id',
];

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}

interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

interface Options {
  content: boolean;
  maxChars: number;
}

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}…[${text.length - max} more characters]`;
}

function plain(value: OtlpAnyValue | undefined): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(plain);
  if (value.kvlistValue)
    return Object.fromEntries(
      (value.kvlistValue.values ?? []).map((kv) => [kv.key, plain(kv.value)])
    );
  return undefined;
}

function attributeValue(
  value: OtlpAnyValue | undefined,
  options: Options
): HostAttributeValue | undefined {
  const raw = plain(value);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return clip(raw, options.maxChars);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : String(raw);
  if (typeof raw === 'boolean') return raw;
  if (
    Array.isArray(raw) &&
    raw.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
  )
    return raw as Array<string | number | boolean>;
  return clip(JSON.stringify(raw), options.maxChars);
}

function attributeMap(
  list: OtlpKeyValue[] | undefined,
  options: Options
): Record<string, HostAttributeValue> {
  const out: Record<string, HostAttributeValue> = {};
  for (const { key, value } of Array.isArray(list) ? list : []) {
    if (!key || isIdentity(key)) continue;
    if (!options.content && isHostContentAttribute(key)) continue;
    const converted = attributeValue(value, options);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

function isoFromNanos(...values: Array<string | number | undefined>): string {
  for (const value of values) {
    if (value === undefined || value === '' || value === 0 || value === '0')
      continue;
    try {
      const ms = Number(BigInt(String(value)) / 1_000_000n);
      if (ms > 0) return new Date(ms).toISOString();
    } catch {
      // Not an integer.
    }
  }
  return new Date().toISOString();
}

/** OTLP/JSON IDs are hex; some exporters write base64. */
function hexId(value: unknown, bytes: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value))
    return value.toLowerCase();
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes ? decoded.toString('hex') : undefined;
}

function sessionOf(
  ...maps: Array<Record<string, HostAttributeValue>>
): string | undefined {
  for (const key of SESSION_ATTRIBUTES)
    for (const map of maps) {
      const value = map[key];
      if (typeof value === 'string' && value) return value;
    }
  return undefined;
}

/** A string field of an OTLP record, or `fallback`. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/** One record the receiver got, and the session it's for. */
type Received = {
  session?: string;
  resource: Record<string, HostAttributeValue>;
  at: number;
} & (
  | { kind: 'event'; event: HostTelemetryEvent }
  | { kind: 'span'; span: HostTelemetrySpan }
  | { kind: 'metric'; metric: HostTelemetryMetric }
);

type Records = Record<string, unknown> & {
  resourceLogs?: unknown;
  resourceMetrics?: unknown;
  resourceSpans?: unknown;
};

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object'
      )
    : [];
}

function resourceOf(
  entry: Record<string, unknown>,
  options: Options
): Record<string, HostAttributeValue> {
  const resource = entry.resource as
    | { attributes?: OtlpKeyValue[] }
    | undefined;
  return attributeMap(resource?.attributes, options);
}

/** The records in an OTLP/JSON export request. */
export function parseOtlpJson(
  signal: Signal,
  payload: Records,
  options: Partial<Options> = {},
  now = Date.now()
): Received[] {
  const opts: Options = {
    content: options.content === true,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
  };
  const out: Received[] = [];
  if (signal === 'logs')
    for (const entry of list(payload.resourceLogs)) {
      const resource = resourceOf(entry, opts);
      for (const scope of list(entry.scopeLogs))
        for (const record of list(scope.logRecords)) {
          const attributes = attributeMap(
            record.attributes as OtlpKeyValue[],
            opts
          );
          const bodyText = plain(record.body as OtlpAnyValue);
          const named =
            (typeof record.eventName === 'string' && record.eventName) ||
            (typeof attributes['event.name'] === 'string'
              ? attributes['event.name']
              : undefined) ||
            (typeof bodyText === 'string' ? bodyText : undefined) ||
            'log';
          out.push({
            kind: 'event',
            session: sessionOf(attributes, resource),
            resource,
            at: now,
            event: {
              name: clip(named, 256),
              time: isoFromNanos(
                record.timeUnixNano as string,
                record.observedTimeUnixNano as string
              ),
              attributes,
            },
          });
        }
    }
  if (signal === 'traces')
    for (const entry of list(payload.resourceSpans)) {
      const resource = resourceOf(entry, opts);
      for (const scope of list(entry.scopeSpans))
        for (const span of list(scope.spans)) {
          const traceId = hexId(span.traceId, 16);
          const spanId = hexId(span.spanId, 8);
          if (!traceId || !spanId) continue;
          const attributes = attributeMap(
            span.attributes as OtlpKeyValue[],
            opts
          );
          const status = span.status as
            | { code?: number | string; message?: string }
            | undefined;
          const code =
            typeof status?.code === 'number'
              ? status.code
              : status?.code === 'STATUS_CODE_ERROR'
                ? 2
                : status?.code === 'STATUS_CODE_OK'
                  ? 1
                  : 0;
          const parent = hexId(span.parentSpanId, 8);
          const events = list(span.events).map((event) => ({
            name: clip(text(event.name, 'event'), 256),
            time: isoFromNanos(event.timeUnixNano as string),
            attributes: attributeMap(event.attributes as OtlpKeyValue[], opts),
          }));
          out.push({
            kind: 'span',
            session: sessionOf(attributes, resource),
            resource,
            at: now,
            span: {
              name: clip(text(span.name, 'span'), 256),
              traceId,
              spanId,
              ...(parent ? { parentSpanId: parent } : {}),
              ...(typeof span.kind === 'number' ? { kind: span.kind } : {}),
              startTime: isoFromNanos(span.startTimeUnixNano as string),
              endTime: isoFromNanos(
                span.endTimeUnixNano as string,
                span.startTimeUnixNano as string
              ),
              attributes,
              ...(code
                ? {
                    status: {
                      code,
                      ...(status?.message
                        ? { message: clip(status.message, 1_024) }
                        : {}),
                    },
                  }
                : {}),
              ...(events.length ? { events } : {}),
            },
          });
        }
    }
  if (signal === 'metrics')
    for (const entry of list(payload.resourceMetrics)) {
      const resource = resourceOf(entry, opts);
      for (const scope of list(entry.scopeMetrics))
        for (const metric of list(scope.metrics)) {
          const data = (metric.sum ?? metric.gauge) as
            | { dataPoints?: unknown }
            | undefined;
          for (const point of list(data?.dataPoints)) {
            const value =
              point.asDouble !== undefined
                ? Number(point.asDouble)
                : point.asInt !== undefined
                  ? Number(point.asInt)
                  : undefined;
            if (value === undefined || !Number.isFinite(value)) continue;
            const attributes = attributeMap(
              point.attributes as OtlpKeyValue[],
              opts
            );
            out.push({
              kind: 'metric',
              session: sessionOf(attributes, resource),
              resource,
              at: now,
              metric: {
                name: clip(text(metric.name, 'metric'), 256),
                ...(typeof metric.unit === 'string' && metric.unit
                  ? { unit: metric.unit }
                  : {}),
                time: isoFromNanos(point.timeUnixNano as string),
                value,
                attributes,
              },
            });
          }
        }
    }
  return out;
}

/** A trial's records, as its `HostTelemetry`. */
export function hostTelemetryOf(records: readonly Received[]): HostTelemetry {
  const events: HostTelemetryEvent[] = [];
  const spans: HostTelemetrySpan[] = [];
  const metrics = new Map<string, HostTelemetryMetric>();
  let dropped = 0;
  let resource: Record<string, HostAttributeValue> | undefined;
  for (const record of records) {
    resource ??= Object.keys(record.resource).length
      ? record.resource
      : undefined;
    if (record.kind === 'event') {
      if (events.length < MAX_RECORDS) events.push(record.event);
      else dropped++;
    } else if (record.kind === 'span') {
      if (spans.length < MAX_RECORDS) spans.push(record.span);
      else dropped++;
    } else {
      // A metric's latest point per attribute set: cumulative counters
      // repeat, so the last one is the trial's.
      const key = `${record.metric.name}\u0000${JSON.stringify(
        Object.entries(record.metric.attributes).sort(([a], [b]) =>
          a < b ? -1 : 1
        )
      )}`;
      const previous = metrics.get(key);
      if (previous && previous.time > record.metric.time) continue;
      if (!previous && metrics.size >= MAX_RECORDS) dropped++;
      else metrics.set(key, record.metric);
    }
  }
  const byTime =
    <T>(time: (item: T) => string) =>
    (a: T, b: T) =>
      time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0;
  events.sort(byTime((event) => event.time));
  spans.sort(byTime((span) => span.startTime));
  return {
    ...(resource ? { resource } : {}),
    events,
    ...(spans.length ? { spans } : {}),
    ...(metrics.size ? { metrics: [...metrics.values()] } : {}),
    ...(dropped ? { dropped } : {}),
  };
}

export interface CollectOptions {
  /** Stop once no new record came for this long (default 1500 ms). */
  settleMs?: number;
  /** Stop waiting after this long (default 15 s). */
  maxWaitMs?: number;
}

export interface HostTelemetryReceiver {
  /**
   * The base URL a host exports to: OTLP's `<endpoint>/v1/logs`,
   * `/v1/metrics` and `/v1/traces` are under it. Its path is the
   * receiver's secret.
   */
  readonly endpoint: string;
  /** The port the receiver listens on. */
  readonly port: number;
  /** Whether hosts are asked for content (`telemetry.host.content`). */
  readonly content: boolean;
  /** Whether hosts are asked for spans (`telemetry.host.traces`). */
  readonly traces: boolean;
  /**
   * Takes the records for these sessions, once the host has sent them: it
   * waits until none came for `settleMs`. Undefined when none came.
   */
  collect(
    sessionIds: readonly string[],
    options?: CollectOptions
  ): Promise<HostTelemetry | undefined>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const encoding = String(request.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  if (encoding === 'gzip')
    return gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
  if (encoding && encoding !== 'identity')
    throw new Error(`unsupported content-encoding ${encoding}`);
  return body;
}

/** Sends what the receiver got on to `forward`'s collector. */
function createForwarder(
  forward: NonNullable<HostTelemetryConfig['forward']>,
  env: Readonly<Record<string, string | undefined>>
): { send(signal: Signal, body: Buffer): void; flush(): Promise<void> } {
  const token = forward.bearerTokenEnv
    ? env[forward.bearerTokenEnv]
    : undefined;
  if (forward.bearerTokenEnv && !token)
    console.warn(
      `[mst] telemetry.host.forward.bearerTokenEnv names ${forward.bearerTokenEnv}, which isn't set; forwarding without a token.`
    );
  const base = forward.endpoint.replace(/\/+$/, '');
  const pending = new Set<Promise<void>>();
  let warned = false;
  async function post(signal: Signal, body: Buffer): Promise<void> {
    let reason = '';
    for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${base}/v1/${signal}`, {
          method: 'POST',
          headers: {
            ...forward.headers,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        if (response.ok) return;
        reason = `HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) break;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (attempt < FORWARD_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    if (!warned) {
      warned = true;
      console.warn(
        `[mst] Couldn't forward the host's telemetry to ${base} (${reason}); the run goes on.`
      );
    }
  }
  return {
    send(signal, body) {
      const task = post(signal, body).finally(() => pending.delete(task));
      pending.add(task);
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}

export interface StartReceiverOptions {
  /** The address to listen on (default `127.0.0.1`). */
  host?: string;
  /** Where forwarded telemetry's token comes from. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Starts a receiver for `telemetry.host`. */
export async function startHostTelemetryReceiver(
  config: HostTelemetryConfig,
  options: StartReceiverOptions = {}
): Promise<HostTelemetryReceiver> {
  const secret = randomBytes(16).toString('hex');
  const parseOptions: Partial<Options> = { content: config.content === true };
  const forwarder = config.forward
    ? createForwarder(config.forward, options.env ?? process.env)
    : undefined;
  const records: Received[] = [];
  const waiters = new Set<() => void>();
  let rejected = 0;
  // Whether any host has sent anything, and whether a trial waited in vain.
  let received = false;
  let warnedSilent = false;

  const server: Server = createServer((request, response) => {
    const match = new RegExp(`^/${secret}/v1/(logs|metrics|traces)/?$`).exec(
      (request.url ?? '').split('?')[0]!
    );
    if (request.method !== 'POST' || !match) {
      response.writeHead(404).end();
      return;
    }
    const signal = match[1] as Signal;
    const type = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!type.includes('json')) {
      if (rejected++ === 0)
        console.warn(
          `[mst] The host sent ${type || 'untyped'} telemetry; MST's receiver takes OTLP/JSON only (http/json).`
        );
      response.writeHead(415).end();
      return;
    }
    readBody(request)
      .then((body) => {
        let payload: Records;
        try {
          payload = JSON.parse(body.toString('utf8')) as Records;
        } catch {
          response.writeHead(400).end();
          return;
        }
        forwarder?.send(signal, body);
        received = true;
        const now = Date.now();
        records.push(...parseOtlpJson(signal, payload, parseOptions, now));
        // Forget what no trial claimed in time, such as a warm-up task's.
        while (records.length && records[0]!.at < now - UNCLAIMED_TTL_MS)
          records.shift();
        for (const wake of waiters) wake();
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(413).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host ?? '127.0.0.1', () => resolve());
  });
  // A receiver never keeps the process alive.
  server.unref();
  const { port } = server.address() as AddressInfo;

  function take(sessions: ReadonlySet<string>): Received[] {
    const taken: Received[] = [];
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (record.session && sessions.has(record.session)) {
        taken.unshift(record);
        records.splice(index, 1);
      }
    }
    return taken;
  }

  return {
    endpoint: `http://localhost:${port}/${secret}`,
    port,
    content: config.content === true,
    traces: config.traces === true,
    async collect(sessionIds, collectOptions = {}) {
      const sessions = new Set(sessionIds.filter(Boolean));
      if (!sessions.size) return undefined;
      const settleMs = collectOptions.settleMs ?? 1_500;
      // Once a trial waited in vain and nothing ever came, later trials
      // don't wait long for a host that doesn't send.
      const maxWaitMs =
        warnedSilent && !received
          ? Math.min(3_000, collectOptions.maxWaitMs ?? 3_000)
          : (collectOptions.maxWaitMs ?? 15_000);
      const deadline = Date.now() + maxWaitMs;
      const matching = () =>
        records.reduce(
          (count, record) =>
            count + (record.session && sessions.has(record.session) ? 1 : 0),
          0
        );
      let seen = matching();
      let lastChange = Date.now();
      // Wait for the host to send them: until nothing new came for
      // `settleMs`, having seen some, or until the deadline.
      while (Date.now() < deadline) {
        const quietFor = Date.now() - lastChange;
        if (seen > 0 && quietFor >= settleMs) break;
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(
            wake,
            Math.max(
              10,
              Math.min(
                seen > 0 ? settleMs - quietFor : settleMs,
                deadline - Date.now()
              )
            )
          );
          timer.unref();
          waiters.add(wake);
        });
        const now = matching();
        if (now !== seen) {
          seen = now;
          lastChange = Date.now();
        }
      }
      const taken = take(sessions);
      if (!taken.length && !received && !warnedSilent) {
        warnedSilent = true;
        console.warn(
          `[mst] telemetry.host: the host sent MST's receiver nothing in ${Math.round(maxWaitMs / 1000)} s; its exporter may be off, or sending elsewhere.`
        );
      }
      return taken.length ? hostTelemetryOf(taken) : undefined;
    },
    async close() {
      await forwarder?.flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The model calls with the request IDs the host's telemetry gives them: an
 * event naming both a request and one of a call's records (Claude's
 * `assistant_response`, by `message_uuid`) says which request it was.
 */
export function withHostRequestIds(
  calls: readonly ModelCall[] | undefined,
  telemetry: HostTelemetry | undefined
): ModelCall[] | undefined {
  if (!calls || !telemetry) return calls ? [...calls] : undefined;
  const byEntry = new Map<string, string>();
  for (const event of telemetry.events) {
    const entry = event.attributes.message_uuid;
    const request = event.attributes.request_id;
    if (typeof entry === 'string' && typeof request === 'string')
      byEntry.set(entry, request);
  }
  return calls.map((call) => {
    if (call.requestId) return call;
    const requestId = (call.entryIds ?? [])
      .map((entry) => byEntry.get(entry))
      .find((id) => id !== undefined);
    return requestId ? { ...call, requestId } : call;
  });
}

const shared = new Map<string, Promise<HostTelemetryReceiver>>();

/**
 * The process's receiver for `telemetry.host`, started on first use: every
 * client in the process shares it, and each trial collects its own
 * sessions' records. A plugin client uses it the same way (docs/telemetry.md).
 */
export function hostTelemetryReceiver(
  config: HostTelemetryConfig,
  options: StartReceiverOptions = {}
): Promise<HostTelemetryReceiver> {
  const key = JSON.stringify([options.host ?? '127.0.0.1', config]);
  let receiver = shared.get(key);
  if (!receiver) {
    receiver = startHostTelemetryReceiver(config, options);
    shared.set(key, receiver);
    receiver.catch(() => shared.delete(key));
  }
  return receiver;
}

/** Where Claude Code's managed settings live, on each platform. */
export function claudeCodeManagedSettingsPaths(
  platform: NodeJS.Platform = process.platform
): string[] {
  const directory =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode'
        : '/etc/claude-code';
  const files = [join(directory, 'managed-settings.json')];
  try {
    for (const name of readdirSync(
      join(directory, 'managed-settings.d')
    ).sort())
      if (name.endsWith('.json'))
        files.push(join(directory, 'managed-settings.d', name));
  } catch {
    // No drop-in directory.
  }
  return files;
}

/**
 * The managed settings file that keeps Claude Code's telemetry where it is,
 * if any: one with an `otelHeadersHelper`. Claude Code then drops a lower
 * scope's OTLP endpoints, MST's included, by design, so its telemetry stays
 * with the managed collector.
 */
export function claudeCodeTelemetryClaim(
  paths: readonly string[] = claudeCodeManagedSettingsPaths()
): string | undefined {
  for (const path of paths) {
    try {
      const settings = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (
        settings &&
        typeof settings === 'object' &&
        'otelHeadersHelper' in settings &&
        (settings as { otelHeadersHelper?: unknown }).otelHeadersHelper
      )
        return path;
    } catch {
      // Missing or unreadable: no claim.
    }
  }
  return undefined;
}

/**
 * Claude Code's environment for exporting to `receiver`: OTLP/JSON to the
 * receiver, per signal. The per-signal endpoints win over a general
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, such as one a machine's managed settings
 * set. Content is off unless the receiver keeps it.
 */
export function claudeCodeOtelEnv(
  receiver: Pick<HostTelemetryReceiver, 'endpoint' | 'content' | 'traces'>,
  resourceAttributes: Record<string, string> = {}
): Record<string, string> {
  const content = receiver.content ? '1' : '0';
  const resource = Object.entries(resourceAttributes)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join(',');
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${receiver.endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${receiver.endpoint}/v1/metrics`,
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
    OTEL_LOG_USER_PROMPTS: content,
    OTEL_LOG_ASSISTANT_RESPONSES: content,
    OTEL_LOG_TOOL_DETAILS: content,
    OTEL_LOG_TOOL_CONTENT: content,
    ...(receiver.traces
      ? {
          CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
          OTEL_TRACES_EXPORTER: 'otlp',
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.endpoint}/v1/traces`,
          OTEL_TRACES_EXPORT_INTERVAL: '1000',
        }
      : {}),
    ...(resource ? { OTEL_RESOURCE_ATTRIBUTES: resource } : {}),
  };
}

/**
 * Claude Desktop's managed `otlp*` settings for exporting to `receiver`
 * (Cowork on Linux, in MST's image). Desktop gives a Cowork task in its VM
 * the host's address for `localhost`.
 */
export function claudeDesktopOtlpSettings(
  receiver: Pick<HostTelemetryReceiver, 'endpoint' | 'content' | 'traces'>,
  resourceAttributes: Record<string, string> = {}
): Record<string, unknown> {
  return {
    otlpEndpoint: receiver.endpoint,
    otlpProtocol: 'http/json',
    ...(Object.keys(resourceAttributes).length
      ? { otlpResourceAttributes: resourceAttributes }
      : {}),
    ...(receiver.content
      ? {
          otlpContentCapture: [
            'userPrompts',
            'assistantResponses',
            'toolDetails',
            'toolContent',
          ],
        }
      : {}),
    ...(receiver.traces ? { otlpTracesEnabled: true } : {}),
  };
}
