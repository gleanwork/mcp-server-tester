import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult } from '../../types/reporter.js';
import type { PairwiseComparisonResult } from '../pairwiseComparison.js';
import {
  createTraceExporter,
  gradingSpans,
  pairwiseSpans,
  trialSpans,
  trialTraceId,
  tracesUrl,
  type OtlpSpan,
  type OtlpTraceRequest,
} from './otlp.js';

const run = { eval: 'smoke', runId: 'run-1', client: 'claude-code' };
const identity = {
  runId: 'run-1',
  variant: 'glean',
  caseId: 'case-a',
  trial: 0,
};
const t = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 22, 12, 0, seconds)).toISOString();
const ms = (seconds: number) => Date.UTC(2026, 9, 22, 12, 0, seconds);

function trial(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: 'case-a',
    datasetName: 'set',
    pass: true,
    durationMs: 9_000,
    request: { input: 'What is 17 + 25?', model: 'claude-x' },
    trace: {
      finalText: 'It is 42.',
      startedAt: t(0),
      completedAt: t(9),
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 100,
        durationMs: 9_000,
      },
      modelCalls: [
        {
          id: 'req-1',
          model: 'claude-x',
          startedAt: t(1),
          completedAt: t(3),
          inputTokens: 4,
          outputTokens: 5,
          cacheReadInputTokens: 50,
          finishReason: 'tool_use',
          toolCallIds: ['call-1'],
        },
        {
          id: 'req-2',
          model: 'claude-x',
          startedAt: t(5),
          completedAt: t(8),
          reasoningText: 'Add them.',
          text: 'It is 42.',
          finishReason: 'end_turn',
        },
      ],
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          name: 'calculate',
          server: 'math',
          id: 'call-1',
          arguments: { a: 17, b: 25 },
          output: '42',
        },
      ],
    },
    ...overrides,
  } as EvalCaseResult;
}

function attrs(span: OtlpSpan): Record<string, unknown> {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      value.stringValue ??
        (value.intValue !== undefined ? Number(value.intValue) : undefined) ??
        value.doubleValue ??
        value.boolValue ??
        value.arrayValue?.values.map((item) => item.stringValue),
    ])
  );
}

const nanos = (seconds: number) => `${BigInt(ms(seconds)) * 1_000_000n}`;

describe('trialSpans', () => {
  const options = { content: false, maxChars: 100 };

  it('traces the agent, its model requests and its tool calls under one root', () => {
    const spans = trialSpans(trial(), identity, run, options);
    expect(spans.map((span) => span.name)).toEqual([
      'invoke_agent claude-code',
      'chat claude-x',
      'chat claude-x',
      'execute_tool calculate',
    ]);
    const [root, first, , tool] = spans;
    expect(new Set(spans.map((span) => span.traceId))).toEqual(
      new Set([trialTraceId(identity)])
    );
    expect(
      spans.slice(1).every((span) => span.parentSpanId === root!.spanId)
    ).toBe(true);
    expect(root!.startTimeUnixNano).toBe(nanos(0));
    expect(root!.endTimeUnixNano).toBe(nanos(9));
    expect(attrs(root!)).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'claude-code',
      'gen_ai.request.model': 'claude-x',
      'gen_ai.response.model': 'claude-x',
      // OpenTelemetry counts cached input in the input total.
      'gen_ai.usage.input_tokens': 110,
      'gen_ai.usage.cache_read.input_tokens': 100,
      'mst.usage.uncached_input_tokens': 10,
      'mst.eval': 'smoke',
      'mst.run_id': 'run-1',
      'mst.variant': 'glean',
      'mst.case_id': 'case-a',
      'mst.trial': 0,
      'mst.dataset': 'set',
      'mst.model_call_count': 2,
      'mst.tool_call_count': 1,
    });
    expect(attrs(first!)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.response.id': 'req-1',
      'gen_ai.response.finish_reasons': ['tool_use'],
      'gen_ai.usage.input_tokens': 54,
    });
    expect(first!.kind).toBe(3);
    expect(attrs(tool!)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'calculate',
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.type': 'extension',
      'mcp.method.name': 'tools/call',
      'mst.tool.server': 'math',
    });
  });

  it('times a tool call the client did not, from the model requests around it', () => {
    const tool = trialSpans(trial(), identity, run, options).at(-1)!;
    expect(tool.startTimeUnixNano).toBe(nanos(3));
    expect(tool.endTimeUnixNano).toBe(nanos(5));
    expect(attrs(tool)['mst.timing']).toBe('inferred');
  });

  it("keeps a tool call's own times", () => {
    const result = trial();
    Object.assign(result.trace!.events[0]!, {
      startedAt: t(3.5),
      completedAt: t(4),
    });
    const tool = trialSpans(result, identity, run, options).at(-1)!;
    expect(tool.startTimeUnixNano).toBe(nanos(3.5));
    expect(attrs(tool)['mst.timing']).toBeUndefined();
  });

  it('sends no content unless asked', () => {
    const spans = trialSpans(trial(), identity, run, options);
    const keys = spans.flatMap((span) => span.attributes.map(({ key }) => key));
    expect(keys).not.toContain('gen_ai.input.messages');
    expect(keys).not.toContain('gen_ai.output.messages');
    expect(keys).not.toContain('gen_ai.tool.call.arguments');
    expect(keys).not.toContain('gen_ai.tool.call.result');
  });

  it('sends content, clipped, when asked', () => {
    const spans = trialSpans(
      trial({ request: { input: 'x'.repeat(500) } }),
      identity,
      run,
      { content: true, maxChars: 200 }
    );
    const [root, , second, tool] = spans.map(attrs);
    expect(root!['gen_ai.input.messages']).toMatch(
      /^\[\{"role":"user","parts":\[\{"type":"text",.*…\[\d+ more characters\]$/
    );
    expect(second!['gen_ai.output.messages']).toContain(
      '{"type":"reasoning","content":"Add them."},{"type":"text","content":"It is 42."}'
    );
    expect(tool).toMatchObject({
      'gen_ai.tool.call.arguments': '{"a":17,"b":25}',
      'gen_ai.tool.call.result': '42',
    });
  });

  it('places what has no times at the start, marked untimed, and fails an errored trial', () => {
    const result = trial({
      error: 'Native task timed out.',
      trace: {
        events: [{ kind: 'tool_call', source: 'builtin', name: 'Bash' }],
        modelCalls: [{ id: 'r' }],
      },
      durationMs: 2_000,
    });
    const [root, model, tool] = trialSpans(result, identity, run, {
      ...options,
      now: ms(10),
    });
    expect(root!.startTimeUnixNano).toBe(nanos(8));
    expect(root!.endTimeUnixNano).toBe(nanos(10));
    expect(root!.status).toEqual({
      code: 2,
      message: 'Native task timed out.',
    });
    expect(attrs(root!)['error.type']).toBe('client');
    for (const span of [model!, tool!]) {
      expect(span.startTimeUnixNano).toBe(nanos(8));
      expect(attrs(span)['mst.untimed']).toBe(true);
    }
    expect(attrs(tool!)['gen_ai.tool.type']).toBe('function');
  });

  it('has the same IDs for the same trial, and others for another', () => {
    const a = trialSpans(trial(), identity, run, options);
    const b = trialSpans(trial(), identity, run, options);
    const other = trialSpans(trial(), { ...identity, trial: 1 }, run, options);
    expect(b.map((span) => span.spanId)).toEqual(a.map((span) => span.spanId));
    expect(other[0]!.traceId).not.toBe(a[0]!.traceId);
    expect(a[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  describe("with the host's own telemetry", () => {
    function hosted(): EvalCaseResult {
      const base = trial();
      base.trace!.modelCalls![0]!.entryIds = ['entry-1'];
      base.trace!.modelCalls![1]!.requestId = 'req_b';
      base.trace!.hostTelemetry = {
        resource: { 'service.name': 'claude-code', 'service.version': '2.1' },
        events: [
          {
            name: 'user_prompt',
            time: t(0),
            attributes: { 'session.id': 's1', prompt_length: 17 },
          },
          {
            name: 'assistant_response',
            time: t(3),
            attributes: { request_id: 'req_a', message_uuid: 'entry-1' },
          },
          {
            name: 'api_request',
            time: t(3),
            attributes: {
              request_id: 'req_a',
              model: 'claude-x',
              duration_ms: 2_000,
              ttft_ms: 700,
              cost_usd: 0.01,
            },
          },
          {
            name: 'tool_decision',
            time: t(3),
            attributes: {
              tool_use_id: 'call-1',
              decision: 'accept',
              tool_parameters: '{"secret":1}',
            },
          },
          {
            name: 'tool_result',
            time: t(4),
            attributes: {
              tool_use_id: 'call-1',
              duration_ms: 500,
              success: true,
            },
          },
          {
            name: 'api_request',
            time: t(8),
            attributes: {
              request_id: 'req_b',
              model: 'claude-x',
              ttft_ms: 300,
            },
          },
          {
            name: 'api_request',
            time: t(6),
            attributes: {
              request_id: 'req_side',
              model: 'claude-haiku',
              duration_ms: 1_000,
              output_tokens: 3,
            },
          },
        ],
        spans: [
          {
            name: 'claude_code.interaction',
            traceId: 'f'.repeat(32),
            spanId: 'a'.repeat(16),
            startTime: t(0),
            endTime: t(9),
            attributes: { 'session.id': 's1' },
          },
          {
            name: 'claude_code.llm_request',
            traceId: 'f'.repeat(32),
            spanId: 'b'.repeat(16),
            parentSpanId: 'a'.repeat(16),
            startTime: t(1),
            endTime: t(3),
            attributes: { prompt: 'secret prompt' },
          },
        ],
        metrics: [
          {
            name: 'claude_code.active_time.total',
            unit: 's',
            time: t(9),
            value: 4.5,
            attributes: { type: 'cli' },
          },
        ],
      };
      return base;
    }

    it('puts each event on the request or tool call it names, and the rest on the root', () => {
      const spans = trialSpans(hosted(), identity, run, options);
      const [root, first, second, tool] = spans;
      expect(first!.events!.map((event) => event.name)).toEqual([
        'assistant_response',
        'api_request',
      ]);
      expect(attrs(first!)).toMatchObject({
        'mst.host.api_request.ttft_ms': 700,
        'mst.host.api_request.cost_usd': 0.01,
        'mst.host.api_request.duration_ms': 2_000,
      });
      expect(attrs(second!)).toMatchObject({
        'mst.request_id': 'req_b',
        'mst.host.api_request.ttft_ms': 300,
      });
      expect(tool!.events!.map((event) => event.name)).toEqual([
        'tool_decision',
        'tool_result',
      ]);
      expect(attrs(tool!)).toMatchObject({
        'mst.host.tool_decision.decision': 'accept',
        'mst.host.tool_result.duration_ms': 500,
        'mst.timing': 'host',
      });
      // The host timed the tool call: it ended at 4 s, after 500 ms.
      expect(tool!.startTimeUnixNano).toBe(
        `${BigInt(ms(4) - 500) * 1_000_000n}`
      );
      expect(root!.events!.map((event) => event.name)).toEqual([
        'user_prompt',
        'metric claude_code.active_time.total',
      ]);
      expect(attrs(root!)).toMatchObject({
        'mst.host.service.name': 'claude-code',
        'mst.host.event_count': 7,
      });
    });

    it("gives a request only the host saw a span, and joins the host's spans under the root", () => {
      const spans = trialSpans(hosted(), identity, run, options);
      const root = spans[0]!;
      const side = spans.find((span) => span.name === 'chat claude-haiku')!;
      expect(attrs(side)).toMatchObject({
        'mst.model_call.source': 'host',
        'mst.request_id': 'req_side',
        'gen_ai.usage.output_tokens': 3,
      });
      expect(side.startTimeUnixNano).toBe(nanos(5));
      const interaction = spans.find(
        (span) => span.name === 'claude_code.interaction'
      )!;
      const request = spans.find(
        (span) => span.name === 'claude_code.llm_request'
      )!;
      expect(interaction.traceId).toBe(root.traceId);
      expect(interaction.parentSpanId).toBe(root.spanId);
      expect(request.parentSpanId).toBe('a'.repeat(16));
      expect(attrs(request)['mst.host.trace_id']).toBe('f'.repeat(32));
    });

    it("keeps the host's content out unless content is sent", () => {
      const without = trialSpans(hosted(), identity, run, options);
      const tool = without[3]!;
      expect(
        attrs(tool)['mst.host.tool_decision.tool_parameters']
      ).toBeUndefined();
      const request = without.find(
        (span) => span.name === 'claude_code.llm_request'
      )!;
      expect(attrs(request).prompt).toBeUndefined();
      const withContent = trialSpans(hosted(), identity, run, {
        ...options,
        content: true,
      });
      expect(
        attrs(
          withContent.find((span) => span.name === 'claude_code.llm_request')!
        ).prompt
      ).toBe('secret prompt');
    });
  });
});

describe('gradingSpans', () => {
  it("adds the trial's verdict and each score to its trace", () => {
    const result = trial({
      pass: false,
      scores: {
        textContains: { pass: true, score: 1 },
        precision: {
          pass: false,
          score: 0.25,
          judgeName: 'citation-precision',
          reasoning: 'One claim of four is cited.',
        },
      },
    } as Partial<EvalCaseResult>);
    const spans = gradingSpans(result, identity, run, {
      content: true,
      maxChars: 100,
      gradingRunId: 'run-1.g2',
      now: ms(30),
    });
    const root = trialSpans(trial(), identity, run, {
      content: false,
      maxChars: 1,
    })[0]!;
    expect(spans.map((span) => span.name)).toEqual([
      'evaluate mst.trial',
      'evaluate textContains',
      'evaluate citation-precision',
    ]);
    expect(spans.every((span) => span.traceId === root.traceId)).toBe(true);
    expect(spans.every((span) => span.parentSpanId === root.spanId)).toBe(true);
    expect(attrs(spans[0]!)).toMatchObject({
      'gen_ai.evaluation.score.label': 'fail',
      'mst.grading_run_id': 'run-1.g2',
    });
    expect(spans[0]!.status).toEqual({ code: 2 });
    expect(attrs(spans[2]!)).toMatchObject({
      'gen_ai.evaluation.name': 'citation-precision',
      'gen_ai.evaluation.score.value': 0.25,
      'gen_ai.evaluation.score.label': 'fail',
      'gen_ai.evaluation.explanation': 'One claim of four is cited.',
      'mst.grader': 'precision',
    });
  });
});

describe('pairwiseSpans', () => {
  it("adds each judge's preference to the candidate's first trial", () => {
    const comparison = {
      candidate: 'glean',
      baseline: 'official',
      cases: [
        {
          id: 'case-a',
          preferences: [
            {
              judge: 'pairwise',
              preference: 'candidate',
              strength: 0.75,
              consistent: true,
              reasoning: 'More complete.',
            },
          ],
        },
      ],
    } as unknown as PairwiseComparisonResult;
    const [span] = pairwiseSpans(comparison, 'run-1', run, {
      content: false,
      maxChars: 100,
      gradingRunId: 'run-1',
    });
    expect(span!.traceId).toBe(trialTraceId(identity));
    expect(attrs(span!)).toMatchObject({
      'gen_ai.evaluation.name': 'pairwise',
      'gen_ai.evaluation.score.label': 'candidate',
      'gen_ai.evaluation.score.value': 0.75,
      'mst.pairwise.baseline': 'official',
      'mst.pairwise.consistent': true,
    });
    expect(attrs(span!)['gen_ai.evaluation.explanation']).toBeUndefined();
  });
});

describe('tracesUrl', () => {
  it("adds OTLP's traces path to a base URL, and keeps a traces URL", () => {
    expect(tracesUrl('https://collector.example.com')).toBe(
      'https://collector.example.com/v1/traces'
    );
    expect(tracesUrl('https://collector.example.com/otlp/')).toBe(
      'https://collector.example.com/otlp/v1/traces'
    );
    expect(tracesUrl('http://localhost:4318/v1/traces')).toBe(
      'http://localhost:4318/v1/traces'
    );
  });
});

describe('createTraceExporter', () => {
  afterEach(() => vi.restoreAllMocks());

  const config = {
    endpoint: 'https://collector.example.com',
    headers: { 'x-tenant': 'evals' },
    bearerTokenEnv: 'COLLECTOR_TOKEN',
    resourceAttributes: { 'deployment.environment.name': 'test' },
  };

  it("posts each trial's trace as OTLP/JSON, with the token and headers", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const exporter = createTraceExporter(
      config,
      run,
      { COLLECTOR_TOKEN: 'secret' },
      fetch
    );
    exporter.trial({ ...trial(), variant: 'glean' }, 0);
    await exporter.flush();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://collector.example.com/v1/traces');
    expect(init.headers).toEqual({
      'x-tenant': 'evals',
      'content-type': 'application/json',
      authorization: 'Bearer secret',
    });
    const body = JSON.parse(init.body as string) as OtlpTraceRequest;
    const [resourceSpans] = body.resourceSpans;
    expect(
      Object.fromEntries(
        resourceSpans!.resource.attributes.map(({ key, value }) => [
          key,
          value.stringValue,
        ])
      )
    ).toMatchObject({
      'service.name': 'mcp-server-tester',
      'deployment.environment.name': 'test',
      'mst.eval': 'smoke',
    });
    const spans = resourceSpans!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(4);
    expect(spans[0]!.traceId).toBe(trialTraceId(identity));
    // Content is off by default.
    expect(init.body).not.toContain('17 + 25');
  });

  it('sends a trial saved again as it was once, and again when it changed', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const exporter = createTraceExporter(config, run, {}, fetch);
    exporter.trial({ ...trial(), variant: 'glean' }, 0);
    exporter.trial({ ...trial(), variant: 'glean' }, 0);
    await exporter.flush();
    expect(fetch).toHaveBeenCalledOnce();
    exporter.trial(
      { ...trial({ error: 'late failure' }), variant: 'glean' },
      0
    );
    await exporter.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx, gives up on a 4xx, and never throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statuses = [503, 200, 400];
    const fetch = vi.fn(async () => {
      const status = statuses.shift()!;
      return { ok: status < 300, status };
    });
    const exporter = createTraceExporter(config, run, {}, fetch);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("names COLLECTOR_TOKEN, which isn't set")
    );
    exporter.trial(trial(), 0);
    await vi.advanceTimersByTimeAsync(5_000);
    exporter.graded(trial());
    const flushed = exporter.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushed;
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Couldn't send traces to https://collector.example.com/v1/traces (HTTP 400)"
      )
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 of 2 trace requests')
    );
  });

  it('reports a collector it cannot reach, and the run goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const exporter = createTraceExporter(
      { endpoint: 'http://localhost:4318' },
      run,
      {},
      fetch
    );
    exporter.trial(trial(), 0);
    const flushed = exporter.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('(connect ECONNREFUSED)')
    );
  });
});
