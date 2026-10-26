/**
 * MST's own telemetry: each trial as an OpenTelemetry trace, sent over OTLP
 * (HTTP, JSON) from the record MST keeps of it, so every client, local or in
 * an environment, is traced the same way (docs/telemetry.md).
 *
 * A trial's trace is a root span for the agent's run, with a span for each
 * model request and tool call the client reported; grading adds a span for
 * each verdict. Attributes follow OpenTelemetry's generative AI conventions
 * (`gen_ai.*`), plus `mst.*` for the eval. Its IDs are derived from the run,
 * variant, case and trial, so a regrade's verdicts join the trial's trace.
 *
 * With `telemetry.host`, the host's own telemetry joins the trace: its events
 * become span events on the model request or tool call they name (by request
 * or tool call ID; the rest on the root), with each event's first attributes
 * as `mst.host.<event>.<key>`; its spans join under the root; its metrics are
 * the root's events.
 */
import { createHash } from 'node:crypto';
import packageJson from '../../../package.json' with { type: 'json' };
import type { OtlpTelemetryConfig } from '../evalConfig.js';
import type { EvalCaseResult, TrialResult } from '../../types/reporter.js';
import type { GraderScore } from '../../types/index.js';
import type {
  HostAttributeValue,
  HostTelemetry,
  HostTelemetryEvent,
  ModelCall,
  Trace,
  TraceEvent,
} from '../evalFrameworkTypes.js';
import { isHostContentAttribute } from './hostContent.js';
import type { PairwiseComparisonResult } from '../pairwiseComparison.js';

export const DEFAULT_MAX_ATTRIBUTE_CHARS = 16_384;
const SEND_TIMEOUT_MS = 10_000;
const SEND_ATTEMPTS = 3;
const SEND_CONCURRENCY = 4;

/** OTLP span kinds. */
const INTERNAL = 1;
const CLIENT = 3;
/** OTLP status codes. */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code: number; message?: string };
  events?: OtlpSpanEvent[];
}

interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

/** An OTLP/JSON `ExportTraceServiceRequest`. */
export interface OtlpTraceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

/** What identifies a trial's trace. */
export interface TrialIdentity {
  /** The run that collected the trial (a regrade's `gradedFrom`). */
  runId: string;
  variant: string;
  caseId: string;
  trial: number;
}

/** What every trace of a run says about it. */
export interface RunAttributes {
  eval: string;
  runId: string;
  /** The client type: `cowork`, `claude-code`, `mst`, ... */
  client?: string;
}

export interface SpanOptions {
  content: boolean;
  maxChars: number;
}

function hex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

/** The trial's trace ID: the same for its collection and every grading. */
export function trialTraceId(identity: TrialIdentity): string {
  return hex(
    [
      'mst',
      identity.runId,
      identity.variant,
      identity.caseId,
      String(identity.trial),
    ].join('\u0000'),
    32
  );
}

function spanId(traceId: string, path: string): string {
  return hex(`${traceId}/${path}`, 16);
}

function nanos(ms: number): string {
  return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function anyValue(value: AttributeValue): OtlpAnyValue {
  if (Array.isArray(value))
    return { arrayValue: { values: value.map((item) => anyValue(item)) } };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  return { stringValue: value };
}

function attributes(
  values: Record<string, AttributeValue | undefined>
): OtlpKeyValue[] {
  return Object.entries(values)
    .filter((entry): entry is [string, AttributeValue] => {
      const value = entry[1];
      return (
        value !== undefined &&
        !(typeof value === 'number' && !Number.isFinite(value)) &&
        !(Array.isArray(value) && value.length === 0)
      );
    })
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}…[${text.length - max} more characters]`;
}

/** Content, JSON-encoded where it isn't text, only when content is sent. */
function content(options: SpanOptions, value: unknown): string | undefined {
  if (!options.content || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? undefined : clip(text, options.maxChars);
}

function usageAttributes(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}): Record<string, number | undefined> {
  return {
    // MST counts input uncached; OpenTelemetry's input count includes the
    // cache, which it reports again apart.
    'gen_ai.usage.input_tokens':
      usage.inputTokens === undefined
        ? undefined
        : usage.inputTokens +
          (usage.cacheReadInputTokens ?? 0) +
          (usage.cacheCreationInputTokens ?? 0),
    'gen_ai.usage.output_tokens': usage.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
    'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationInputTokens,
    'mst.usage.uncached_input_tokens': usage.inputTokens,
    'mst.usage.reasoning_output_tokens': usage.reasoningOutputTokens,
  };
}

function trialAttributes(
  run: RunAttributes,
  identity: TrialIdentity
): Record<string, AttributeValue | undefined> {
  return {
    'mst.eval': run.eval,
    'mst.run_id': identity.runId,
    'mst.variant': identity.variant,
    'mst.case_id': identity.caseId,
    'mst.trial': identity.trial,
  };
}

/** A span's times: its own, or a point at `fallback` marked untimed. */
function spanTimes(
  startedAt: string | undefined,
  completedAt: string | undefined,
  durationMs: number | undefined,
  fallback: number
): { start: number; end: number; timed: boolean } {
  let start = epochMs(startedAt);
  let end = epochMs(completedAt);
  if (start === undefined && end !== undefined && durationMs !== undefined)
    start = end - durationMs;
  if (end === undefined && start !== undefined && durationMs !== undefined)
    end = start + durationMs;
  if (start === undefined && end === undefined)
    return { start: fallback, end: fallback, timed: false };
  start ??= end!;
  end ??= start;
  return { start, end: Math.max(start, end), timed: true };
}

function modelCallSpan(
  call: ModelCall,
  index: number,
  traceId: string,
  parent: string,
  fallback: number,
  toolNames: Map<string, string>,
  options: SpanOptions,
  host: readonly HostTelemetryEvent[] = []
): OtlpSpan {
  const own = call.startedAt !== undefined || call.completedAt !== undefined;
  const hostTimes = own ? undefined : hostEventTimes(host);
  const times = spanTimes(
    call.startedAt ?? hostTimes?.startedAt,
    call.completedAt ?? hostTimes?.completedAt,
    call.durationMs,
    fallback
  );
  const parts = [
    ...(call.text ? [{ type: 'text', content: call.text }] : []),
    ...(call.toolCallIds ?? []).map((id) => ({
      type: 'tool_call',
      id,
      ...(toolNames.has(id) ? { name: toolNames.get(id) } : {}),
    })),
  ];
  return {
    traceId,
    spanId: spanId(traceId, `model/${index}`),
    parentSpanId: parent,
    name: `chat${call.model ? ` ${call.model}` : ''}`,
    kind: CLIENT,
    startTimeUnixNano: nanos(times.start),
    endTimeUnixNano: nanos(times.end),
    attributes: attributes({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': call.model,
      'gen_ai.response.model': call.model,
      'gen_ai.response.id': call.id,
      'mst.request_id': call.requestId,
      'gen_ai.response.finish_reasons': call.finishReason
        ? [call.finishReason]
        : undefined,
      ...usageAttributes(call),
      'mst.untimed': times.timed ? undefined : true,
      'gen_ai.output.messages':
        parts.length > 0
          ? content(options, [
              {
                role: 'assistant',
                parts,
                ...(call.finishReason
                  ? { finish_reason: call.finishReason }
                  : {}),
              },
            ])
          : undefined,
      'mst.timing': hostTimes && times.timed ? 'host' : undefined,
      ...promotedHostAttributes(host, options),
    }),
    ...hostSpanEvents(host, options),
  };
}

/**
 * When tool calls the client didn't time ran, from the model calls around
 * them: a call asked for by one model call ran after it ended, and before the
 * next one started.
 */
function inferredToolTimes(
  modelCalls: readonly ModelCall[]
): Map<string, { startedAt?: string; completedAt?: string }> {
  const times = new Map<string, { startedAt?: string; completedAt?: string }>();
  modelCalls.forEach((call, index) => {
    const next = modelCalls[index + 1];
    for (const id of call.toolCallIds ?? [])
      times.set(id, {
        startedAt: call.completedAt,
        completedAt: next?.startedAt,
      });
  });
  return times;
}

function toolSpan(
  event: TraceEvent,
  index: number,
  traceId: string,
  parent: string,
  fallback: number,
  inferred: ReturnType<typeof inferredToolTimes>,
  options: SpanOptions,
  host: readonly HostTelemetryEvent[] = []
): OtlpSpan {
  const own = event.startedAt !== undefined || event.completedAt !== undefined;
  // The host's own measure of the call, when the client's record has none.
  const hostTimes = own ? undefined : hostEventTimes(host);
  const around =
    !own && !hostTimes && event.id ? inferred.get(event.id) : undefined;
  const times = spanTimes(
    own ? event.startedAt : (hostTimes?.startedAt ?? around?.startedAt),
    own ? event.completedAt : (hostTimes?.completedAt ?? around?.completedAt),
    own || (!around && !hostTimes) ? event.durationMs : undefined,
    fallback
  );
  const isMcpTool = event.source === 'mcp' && event.kind === 'tool_call';
  return {
    traceId,
    spanId: spanId(traceId, `tool/${index}`),
    parentSpanId: parent,
    name: `execute_tool ${event.name}`,
    kind: INTERNAL,
    startTimeUnixNano: nanos(times.start),
    endTimeUnixNano: nanos(times.end),
    attributes: attributes({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': event.name,
      'gen_ai.tool.call.id': event.id,
      'gen_ai.tool.type': event.source === 'mcp' ? 'extension' : 'function',
      'mcp.method.name': isMcpTool ? 'tools/call' : undefined,
      'mst.tool.kind': event.kind,
      'mst.tool.source': event.source,
      'mst.tool.server': event.server,
      'mst.tool.raw_name': event.rawName,
      'mst.tool.simulated_write': event.simulatedWrite || undefined,
      'error.type': event.isError ? 'tool_error' : undefined,
      'mst.untimed': times.timed ? undefined : true,
      'mst.timing':
        times.timed && !own
          ? hostTimes
            ? 'host'
            : around
              ? 'inferred'
              : undefined
          : undefined,
      'gen_ai.tool.call.arguments': content(options, event.arguments),
      'gen_ai.tool.call.result': content(options, event.output),
      ...promotedHostAttributes(host, options),
    }),
    ...(event.isError ? { status: { code: STATUS_ERROR } } : {}),
    ...hostSpanEvents(host, options),
  };
}

/** The attributes that name the model request a host's event is about. */
const HOST_REQUEST_KEYS = [
  'request_id',
  'request.id',
  'gen_ai.response.id',
  'response_id',
];
/** The attributes that name the message record a host's event is about. */
const HOST_MESSAGE_KEYS = ['message_uuid', 'message.uuid'];
/** The attributes that name the tool call a host's event is about. */
const HOST_TOOL_CALL_KEYS = [
  'tool_use_id',
  'tool_call_id',
  'gen_ai.tool.call.id',
  'call_id',
];

function hostKey(
  event: HostTelemetryEvent,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = event.attributes[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** A host attribute as a span's: content only when content is sent. */
function hostAttributes(
  values: Record<string, HostAttributeValue>,
  options: SpanOptions,
  prefix = ''
): Record<string, AttributeValue | undefined> {
  const out: Record<string, AttributeValue | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!options.content && isHostContentAttribute(key)) continue;
    out[`${prefix}${key}`] =
      typeof value === 'string' ? clip(value, options.maxChars) : value;
  }
  return out;
}

/**
 * The first event of each name as the span's attributes, so a query can
 * filter on them: `mst.host.api_request.ttft_ms`.
 */
function promotedHostAttributes(
  host: readonly HostTelemetryEvent[],
  options: SpanOptions
): Record<string, AttributeValue | undefined> {
  const seen = new Set<string>();
  let out: Record<string, AttributeValue | undefined> = {};
  for (const event of host) {
    if (seen.has(event.name)) continue;
    seen.add(event.name);
    const {
      'event.name': _n,
      'event.timestamp': _t,
      ...rest
    } = event.attributes;
    out = {
      ...out,
      ...hostAttributes(rest, options, `mst.host.${event.name}.`),
    };
  }
  return out;
}

function hostSpanEvents(
  host: readonly HostTelemetryEvent[],
  options: SpanOptions
): { events?: OtlpSpanEvent[] } {
  if (!host.length) return {};
  return {
    events: host.map((event) => ({
      timeUnixNano: nanos(epochMs(event.time) ?? Date.now()),
      name: event.name,
      attributes: attributes(hostAttributes(event.attributes, options)),
    })),
  };
}

/**
 * A request or tool call's times by the host: an event logged as it ended,
 * with its `duration_ms`.
 */
function hostEventTimes(
  host: readonly HostTelemetryEvent[]
): { startedAt: string; completedAt: string } | undefined {
  for (const event of host) {
    const duration = Number(event.attributes.duration_ms);
    const end = epochMs(event.time);
    if (end !== undefined && Number.isFinite(duration) && duration >= 0)
      return {
        startedAt: new Date(end - duration).toISOString(),
        completedAt: event.time,
      };
  }
  return undefined;
}

/** The host's events, by the model request or tool call each names. */
function hostEventIndex(
  telemetry: HostTelemetry | undefined,
  modelCalls: readonly ModelCall[],
  events: readonly TraceEvent[]
): {
  byModelCall: Map<number, HostTelemetryEvent[]>;
  byTool: Map<number, HostTelemetryEvent[]>;
  requests: HostTelemetryEvent[];
  rest: HostTelemetryEvent[];
} {
  const byModelCall = new Map<number, HostTelemetryEvent[]>();
  const byTool = new Map<number, HostTelemetryEvent[]>();
  const requests: HostTelemetryEvent[] = [];
  const rest: HostTelemetryEvent[] = [];
  const callIndex = new Map<string, number>();
  const entryIndex = new Map<string, number>();
  modelCalls.forEach((call, index) => {
    if (call.requestId) callIndex.set(call.requestId, index);
    if (call.id && !callIndex.has(call.id)) callIndex.set(call.id, index);
    for (const entry of call.entryIds ?? []) entryIndex.set(entry, index);
  });
  // An event that names both a request and a message entry (Claude's
  // `assistant_response`) says which request a model call was: then every
  // event of that request joins it.
  for (const event of telemetry?.events ?? []) {
    const request = hostKey(event, HOST_REQUEST_KEYS);
    const entry = hostKey(event, HOST_MESSAGE_KEYS);
    if (request && entry && entryIndex.has(entry) && !callIndex.has(request))
      callIndex.set(request, entryIndex.get(entry)!);
  }
  const toolIndex = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.id) toolIndex.set(event.id, index);
  });
  const add = (
    map: Map<number, HostTelemetryEvent[]>,
    index: number,
    event: HostTelemetryEvent
  ) => map.set(index, [...(map.get(index) ?? []), event]);
  for (const event of telemetry?.events ?? []) {
    const request = hostKey(event, HOST_REQUEST_KEYS);
    const tool = hostKey(event, HOST_TOOL_CALL_KEYS);
    if (tool !== undefined && toolIndex.has(tool))
      add(byTool, toolIndex.get(tool)!, event);
    else if (request !== undefined && callIndex.has(request))
      add(byModelCall, callIndex.get(request)!, event);
    else if (
      request !== undefined &&
      tool === undefined &&
      typeof event.attributes.model === 'string'
    )
      // A request the client's record doesn't have: a subagent's, a
      // summary's. It gets a span of its own.
      requests.push(event);
    else rest.push(event);
  }
  return { byModelCall, byTool, requests, rest };
}

/** A model request only the host reported, as its span. */
function hostRequestSpan(
  event: HostTelemetryEvent,
  index: number,
  traceId: string,
  parent: string,
  fallback: number,
  options: SpanOptions
): OtlpSpan {
  const times = hostEventTimes([event]);
  const span = spanTimes(
    times?.startedAt,
    times?.completedAt ?? event.time,
    undefined,
    fallback
  );
  const model = String(event.attributes.model);
  const number = (key: string) => {
    const value = Number(event.attributes[key]);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    traceId,
    spanId: spanId(traceId, `host-request/${index}`),
    parentSpanId: parent,
    name: `chat ${model}`,
    kind: CLIENT,
    startTimeUnixNano: nanos(span.start),
    endTimeUnixNano: nanos(span.end),
    attributes: attributes({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': number('input_tokens'),
      'gen_ai.usage.output_tokens': number('output_tokens'),
      'gen_ai.usage.cache_read.input_tokens': number('cache_read_tokens'),
      'gen_ai.usage.cache_creation.input_tokens': number(
        'cache_creation_tokens'
      ),
      'mst.request_id': hostKey(event, HOST_REQUEST_KEYS),
      'mst.model_call.source': 'host',
      ...promotedHostAttributes([event], options),
    }),
    ...hostSpanEvents([event], options),
  };
}

/** The host's own spans, in the trial's trace: its roots under the trial's. */
function hostSpans(
  telemetry: HostTelemetry | undefined,
  traceId: string,
  root: string,
  options: SpanOptions
): OtlpSpan[] {
  const spans = telemetry?.spans ?? [];
  const ids = new Set(spans.map((span) => span.spanId));
  return spans.map((span) => ({
    traceId,
    spanId: span.spanId,
    parentSpanId:
      span.parentSpanId && ids.has(span.parentSpanId)
        ? span.parentSpanId
        : root,
    name: span.name,
    kind: span.kind ?? INTERNAL,
    startTimeUnixNano: nanos(epochMs(span.startTime) ?? Date.now()),
    endTimeUnixNano: nanos(epochMs(span.endTime) ?? Date.now()),
    attributes: attributes({
      ...hostAttributes(span.attributes, options),
      'mst.span.source': 'host',
      'mst.host.trace_id': span.traceId,
    }),
    ...(span.status ? { status: span.status } : {}),
    ...(span.events?.length
      ? {
          events: span.events.map((event) => ({
            timeUnixNano: nanos(epochMs(event.time) ?? Date.now()),
            name: event.name,
            attributes: attributes(hostAttributes(event.attributes, options)),
          })),
        }
      : {}),
  }));
}

/**
 * A trial's trace: the agent's run, its model requests and its tool calls.
 * `now` is when the trial was saved, for a trial with no times of its own.
 */
export function trialSpans(
  result: EvalCaseResult | TrialResult,
  identity: TrialIdentity,
  run: RunAttributes,
  options: SpanOptions & { input?: string; model?: string; now?: number }
): OtlpSpan[] {
  const trace: Trace | undefined = result.trace;
  const traceId = trialTraceId(identity);
  const root = spanId(traceId, 'root');
  const events = trace?.events ?? [];
  const modelCalls = trace?.modelCalls ?? [];
  const childTimes = [
    ...events.flatMap((event) => [
      epochMs(event.startedAt),
      epochMs(event.completedAt),
    ]),
    ...modelCalls.flatMap((call) => [
      epochMs(call.startedAt),
      epochMs(call.completedAt),
    ]),
  ].filter((value): value is number => value !== undefined);
  const now = options.now ?? Date.now();
  let start = epochMs(trace?.startedAt);
  let end = epochMs(trace?.completedAt);
  start ??= childTimes.length ? Math.min(...childTimes) : undefined;
  end ??= childTimes.length ? Math.max(...childTimes) : undefined;
  if (end === undefined)
    end = start !== undefined ? start + result.durationMs : now;
  if (start === undefined) start = end - result.durationMs;
  if (end < start) end = start;
  const models = [
    ...new Set(
      modelCalls
        .map((call) => call.model)
        .filter((model): model is string => !!model)
    ),
  ];
  const request = 'request' in result ? result.request : undefined;
  const input = options.input ?? request?.input;
  const model = options.model ?? request?.model;
  const usage = trace?.usage ?? result.clientUsage;
  const error = trace?.error ?? result.error;
  const infrastructure =
    'isInfrastructureError' in result
      ? result.isInfrastructureError === true
      : ((result as EvalCaseResult).infrastructureErrorCount ?? 0) > 0;
  const inferred = inferredToolTimes(modelCalls);
  const host = hostEventIndex(trace?.hostTelemetry, modelCalls, events);
  const toolNames = new Map(
    events
      .filter((event) => event.id)
      .map((event) => [event.id!, event.name] as const)
  );
  const rootSpan: OtlpSpan = {
    traceId,
    spanId: root,
    name: `invoke_agent${run.client ? ` ${run.client}` : ''}`,
    kind: INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: attributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': run.client,
      'gen_ai.request.model': model,
      'gen_ai.response.model': models.length === 1 ? models[0] : undefined,
      ...(usage ? usageAttributes(usage) : {}),
      ...trialAttributes(run, identity),
      'mst.dataset': 'datasetName' in result ? result.datasetName : undefined,
      'mst.tags': 'tags' in result ? result.tags : undefined,
      'mst.client': run.client,
      'mst.models': models.length > 1 ? models : undefined,
      'mst.duration_ms': result.durationMs,
      'mst.cost_usd': usage?.totalCostUsd ?? usage?.estimatedCostUsd,
      'mst.tool_call_count': events.length,
      'mst.model_call_count': trace?.modelCalls ? modelCalls.length : undefined,
      'mst.evidence': trace?.evidence,
      'mst.host.event_count': trace?.hostTelemetry?.events.length,
      ...(trace?.hostTelemetry?.resource
        ? hostAttributes(trace.hostTelemetry.resource, options, 'mst.host.')
        : {}),
      'mst.infrastructure_error': infrastructure || undefined,
      'error.type': error
        ? infrastructure
          ? 'infrastructure'
          : 'client'
        : undefined,
      'gen_ai.input.messages':
        input !== undefined
          ? content(options, [
              { role: 'user', parts: [{ type: 'text', content: input }] },
            ])
          : undefined,
      'gen_ai.output.messages': trace?.finalText
        ? content(options, [
            {
              role: 'assistant',
              parts: [{ type: 'text', content: trace.finalText }],
            },
          ])
        : undefined,
    }),
    ...(error
      ? { status: { code: STATUS_ERROR, message: clip(error, 1_024) } }
      : {}),
  };
  // The host's events no request or tool call names, and its metrics.
  const rootEvents = [
    ...(hostSpanEvents(host.rest, options).events ?? []),
    ...(trace?.hostTelemetry?.metrics ?? []).map((metric) => ({
      timeUnixNano: nanos(epochMs(metric.time) ?? end),
      name: `metric ${metric.name}`,
      attributes: attributes({
        ...hostAttributes(metric.attributes, options),
        'mst.metric.value': metric.value,
        'mst.metric.unit': metric.unit,
      }),
    })),
  ];
  if (rootEvents.length) rootSpan.events = rootEvents;
  return [
    rootSpan,
    ...modelCalls.map((call, index) =>
      modelCallSpan(
        call,
        index,
        traceId,
        root,
        start,
        toolNames,
        options,
        host.byModelCall.get(index)
      )
    ),
    ...events.map((event, index) =>
      toolSpan(
        event,
        index,
        traceId,
        root,
        start,
        inferred,
        options,
        host.byTool.get(index)
      )
    ),
    ...host.requests.map((event, index) =>
      hostRequestSpan(event, index, traceId, root, start, options)
    ),
    ...hostSpans(trace?.hostTelemetry, traceId, root, options),
  ];
}

/** The trials of a graded case, by trial index. */
export function caseTrials(
  result: EvalCaseResult
): Array<{ trial: number; result: EvalCaseResult | TrialResult }> {
  return result.trialResults?.length
    ? result.trialResults.map((trial, index) => ({
        trial: index,
        result: trial,
      }))
    : [{ trial: 0, result }];
}

/**
 * A graded trial's verdicts, in its trace: one span for the trial, and one
 * for each score. `gradingRunId` is the run that graded it.
 */
export function gradingSpans(
  result: EvalCaseResult | TrialResult,
  identity: TrialIdentity,
  run: RunAttributes,
  options: SpanOptions & { gradingRunId: string; now?: number }
): OtlpSpan[] {
  const traceId = trialTraceId(identity);
  const now = nanos(options.now ?? Date.now());
  const verdict = (
    name: string,
    path: string,
    values: Record<string, AttributeValue | undefined>,
    failed: boolean
  ): OtlpSpan => ({
    traceId,
    spanId: spanId(traceId, `grade/${options.gradingRunId}/${path}`),
    parentSpanId: spanId(traceId, 'root'),
    name: `evaluate ${name}`,
    kind: INTERNAL,
    startTimeUnixNano: now,
    endTimeUnixNano: now,
    attributes: attributes({
      'gen_ai.evaluation.name': name,
      ...values,
      ...trialAttributes(run, identity),
      'mst.grading_run_id': options.gradingRunId,
    }),
    status: { code: failed ? STATUS_ERROR : STATUS_OK },
  });
  const scores = Object.entries(result.scores ?? {}).filter(
    (entry): entry is [string, GraderScore] => entry[1] !== undefined
  );
  return [
    verdict(
      'mst.trial',
      'trial',
      {
        'gen_ai.evaluation.score.label': result.pass ? 'pass' : 'fail',
        'gen_ai.evaluation.score.value': result.pass ? 1 : 0,
        'error.type': result.gradingError ? 'grading' : undefined,
        'gen_ai.evaluation.explanation': content(options, result.gradingError),
      },
      !result.pass
    ),
    ...scores.map(([key, score]) =>
      verdict(
        score.judgeName ?? key,
        `score/${key}`,
        {
          'gen_ai.evaluation.score.label': score.pass ? 'pass' : 'fail',
          'gen_ai.evaluation.score.value': score.score,
          'mst.grader': key,
          'gen_ai.evaluation.explanation': content(
            options,
            score.reasoning ?? score.details
          ),
        },
        !score.pass
      )
    ),
  ];
}

/**
 * Pairwise verdicts, in the trace of the candidate's first trial of each
 * case: one span per judge.
 */
export function pairwiseSpans(
  comparison: PairwiseComparisonResult,
  runId: string,
  run: RunAttributes,
  options: SpanOptions & { gradingRunId: string; now?: number }
): OtlpSpan[] {
  const now = nanos(options.now ?? Date.now());
  return comparison.cases.flatMap((comparedCase) => {
    const identity: TrialIdentity = {
      runId,
      variant: comparison.candidate,
      caseId: comparedCase.id,
      trial: 0,
    };
    const traceId = trialTraceId(identity);
    return comparedCase.preferences.map((preference) => ({
      traceId,
      spanId: spanId(
        traceId,
        `pairwise/${options.gradingRunId}/${comparison.baseline}/${preference.judge}`
      ),
      parentSpanId: spanId(traceId, 'root'),
      name: `evaluate ${preference.judge}`,
      kind: INTERNAL,
      startTimeUnixNano: now,
      endTimeUnixNano: now,
      attributes: attributes({
        'gen_ai.evaluation.name': preference.judge,
        'gen_ai.evaluation.score.label': preference.skipped
          ? 'skipped'
          : preference.preference,
        'gen_ai.evaluation.score.value': preference.strength,
        'mst.pairwise.baseline': comparison.baseline,
        'mst.pairwise.consistent': preference.consistent,
        'error.type': preference.error ? 'grading' : undefined,
        'gen_ai.evaluation.explanation': content(
          options,
          preference.reasoning ?? preference.error
        ),
        ...trialAttributes(run, identity),
        'mst.grading_run_id': options.gradingRunId,
      }),
      ...(preference.error ? { status: { code: STATUS_ERROR } } : {}),
    }));
  });
}

export function traceRequest(
  spans: OtlpSpan[],
  run: RunAttributes,
  resource: Record<string, string>
): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            'service.name': 'mcp-server-tester',
            'service.version': packageJson.version,
            ...resource,
            'mst.eval': run.eval,
          }),
        },
        scopeSpans: [
          {
            scope: { name: 'mcp-server-tester', version: packageJson.version },
            spans,
          },
        ],
      },
    ],
  };
}

/** Where traces go: the collector's traces URL. */
export function tracesUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (!url.pathname.endsWith('/v1/traces'))
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/traces`;
  return url.toString();
}

export interface TraceExporter {
  /** A trial the run just collected. */
  trial(result: EvalCaseResult, trial: number, input?: string): void;
  /** A graded case's verdicts. */
  graded(result: EvalCaseResult): void;
  /** A variant's pairwise verdicts. */
  pairwise(comparison: PairwiseComparisonResult): void;
  /** Waits for what's been sent, up to `timeoutMs`; reports failures. */
  flush(timeoutMs?: number): Promise<void>;
}

/**
 * Sends a run's traces as it goes. Sending never blocks or fails the run:
 * each request is queued, retried on a network error, 429 or 5xx, and
 * reported if it still fails. `runId` names the trials' traces (a regrade's
 * `gradedFrom`); `gradingRunId` the run grading them.
 */
export function createTraceExporter(
  config: OtlpTelemetryConfig,
  run: RunAttributes & { gradingRunId?: string },
  env: Record<string, string | undefined>,
  fetchImpl: (
    url: string,
    init: RequestInit
  ) => Promise<{ ok: boolean; status: number }> = fetch
): TraceExporter {
  const url = tracesUrl(config.endpoint);
  // What each trial's trace was when last sent, by trace ID.
  const sentTrials = new Map<string, string>();
  const token = config.bearerTokenEnv ? env[config.bearerTokenEnv] : undefined;
  if (config.bearerTokenEnv && !token)
    console.warn(
      `[mst] telemetry.otlp.bearerTokenEnv names ${config.bearerTokenEnv}, which isn't set; sending traces without a token.`
    );
  const headers: Record<string, string> = {
    ...config.headers,
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const options: SpanOptions = {
    content: config.content === true,
    maxChars: config.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS,
  };
  const resource = config.resourceAttributes ?? {};
  const pending = new Set<Promise<void>>();
  const queue: OtlpSpan[][] = [];
  let active = 0;
  let sent = 0;
  let failed = 0;
  let firstFailure: string | undefined;

  async function send(spans: OtlpSpan[]): Promise<void> {
    const body = JSON.stringify(traceRequest(spans, run, resource));
    let reason = '';
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (response.ok) {
          sent++;
          return;
        }
        reason = `HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) break;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (attempt < SEND_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    failed++;
    if (firstFailure === undefined) {
      firstFailure = reason;
      console.warn(
        `[mst] Couldn't send traces to ${url} (${reason}); the run goes on without them.`
      );
    }
  }

  function pump(): void {
    while (active < SEND_CONCURRENCY && queue.length > 0) {
      const spans = queue.shift()!;
      active++;
      const task = send(spans).finally(() => {
        active--;
        pending.delete(task);
        pump();
      });
      pending.add(task);
    }
  }

  function enqueue(spans: OtlpSpan[]): void {
    if (spans.length === 0) return;
    queue.push(spans);
    pump();
  }

  const gradingRunId = run.gradingRunId ?? run.runId;
  const identity = (result: EvalCaseResult, trial: number): TrialIdentity => ({
    runId: run.runId,
    variant: result.variant ?? 'default',
    caseId: result.id,
    trial,
  });

  return {
    trial(result, trial, input) {
      try {
        const key = identity(result, trial);
        const spans = trialSpans(result, key, run, { ...options, input });
        // A trial saved again as it was (an environment's result, then the
        // case's) is sent once; one that changed is sent again, same IDs.
        const digest = createHash('sha256')
          .update(JSON.stringify(spans))
          .digest('hex');
        const name = trialTraceId(key);
        if (sentTrials.get(name) === digest) return;
        sentTrials.set(name, digest);
        enqueue(spans);
      } catch (error) {
        console.warn(
          `[mst] Couldn't trace trial ${trial} of ${result.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    graded(result) {
      try {
        enqueue(
          caseTrials(result).flatMap(({ trial, result: trialResult }) =>
            gradingSpans(trialResult, identity(result, trial), run, {
              ...options,
              gradingRunId,
            })
          )
        );
      } catch (error) {
        console.warn(
          `[mst] Couldn't trace the grades of ${result.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    pairwise(comparison) {
      try {
        enqueue(
          pairwiseSpans(comparison, run.runId, run, {
            ...options,
            gradingRunId,
          })
        );
      } catch (error) {
        console.warn(
          `[mst] Couldn't trace the pairwise verdicts of ${comparison.candidate}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async flush(timeoutMs = 30_000) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref();
      });
      const drained = (async () => {
        while (pending.size > 0 || queue.length > 0)
          await Promise.allSettled([...pending]);
      })();
      const outcome = await Promise.race([drained, timedOut]);
      clearTimeout(timer);
      if (outcome === 'timeout')
        console.warn(
          `[mst] Stopped waiting for ${pending.size + queue.length} trace requests to ${url}.`
        );
      if (failed > 0)
        console.warn(
          `[mst] ${failed} of ${sent + failed} trace requests to ${url} failed (first: ${firstFailure}).`
        );
    },
  };
}
