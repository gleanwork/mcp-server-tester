import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claudeCodeManagedSettingsPaths,
  claudeCodeOtelEnv,
  claudeCodeTelemetryClaim,
  claudeDesktopOtlpSettings,
  hostTelemetryOf,
  parseOtlpJson,
  startHostTelemetryReceiver,
  withHostRequestIds,
  type HostTelemetryReceiver,
} from './hostReceiver.js';

const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;

function str(value: string) {
  return { stringValue: value };
}

function logs(
  session: string,
  records: Array<{
    name: string;
    time: string;
    attrs?: Record<string, unknown>;
  }>
) {
  const value = (v: unknown) =>
    typeof v === 'number'
      ? Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v }
      : typeof v === 'boolean'
        ? { boolValue: v }
        : str(String(v));
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: str('claude-code') },
            { key: 'user.email', value: str('someone@example.com') },
          ],
        },
        scopeLogs: [
          {
            logRecords: records.map((record) => ({
              timeUnixNano: nanos(record.time),
              body: str(`claude_code.${record.name}`),
              attributes: [
                { key: 'event.name', value: str(record.name) },
                { key: 'session.id', value: str(session) },
                ...Object.entries(record.attrs ?? {}).map(([key, v]) => ({
                  key,
                  value: value(v),
                })),
              ],
            })),
          },
        ],
      },
    ],
  };
}

describe('parseOtlpJson', () => {
  it("reads a host's events, without content or who ran it", () => {
    const [record] = parseOtlpJson(
      'logs',
      logs('s1', [
        {
          name: 'api_request',
          time: '2026-10-22T12:00:03.000Z',
          attrs: {
            request_id: 'req_1',
            ttft_ms: 700,
            cost_usd: 0.25,
            success: true,
            prompt: 'secret',
          },
        },
      ])
    );
    expect(record).toMatchObject({
      kind: 'event',
      session: 's1',
      resource: { 'service.name': 'claude-code' },
      event: {
        name: 'api_request',
        time: '2026-10-22T12:00:03.000Z',
        attributes: {
          request_id: 'req_1',
          ttft_ms: 700,
          cost_usd: 0.25,
          success: true,
        },
      },
    });
    expect(record!.resource['user.email']).toBeUndefined();
    expect(
      record!.kind === 'event' && record!.event.attributes.prompt
    ).toBeFalsy();
    const [withContent] = parseOtlpJson(
      'logs',
      logs('s1', [
        {
          name: 'user_prompt',
          time: '2026-10-22T12:00:00.000Z',
          attrs: { prompt: 'x'.repeat(50) },
        },
      ]),
      { content: true, maxChars: 10 }
    );
    expect(
      withContent!.kind === 'event' && withContent!.event.attributes.prompt
    ).toBe('xxxxxxxxxx…[40 more characters]');
  });

  it('reads spans, with base64 IDs, and metrics', () => {
    const traceId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const spans = parseOtlpJson('traces', {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.llm_request',
                  traceId: traceId.toString('base64'),
                  spanId: 'aaaaaaaaaaaaaaaa',
                  startTimeUnixNano: nanos('2026-10-22T12:00:01.000Z'),
                  endTimeUnixNano: nanos('2026-10-22T12:00:02.000Z'),
                  attributes: [{ key: 'session.id', value: str('s1') }],
                  status: { code: 2, message: 'overloaded' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(spans[0]).toMatchObject({
      kind: 'span',
      session: 's1',
      span: {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: 'aaaaaaaaaaaaaaaa',
        endTime: '2026-10-22T12:00:02.000Z',
        status: { code: 2, message: 'overloaded' },
      },
    });
    const metrics = parseOtlpJson('metrics', {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  unit: 'USD',
                  sum: {
                    dataPoints: [
                      {
                        timeUnixNano: nanos('2026-10-22T12:00:05.000Z'),
                        asDouble: 0.5,
                        attributes: [
                          { key: 'session.id', value: str('s1') },
                          { key: 'model', value: str('m') },
                        ],
                      },
                      {
                        timeUnixNano: nanos('2026-10-22T12:00:09.000Z'),
                        asDouble: 0.75,
                        attributes: [
                          { key: 'session.id', value: str('s1') },
                          { key: 'model', value: str('m') },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    // A series' latest point is the trial's.
    expect(hostTelemetryOf(metrics).metrics).toEqual([
      {
        name: 'claude_code.cost.usage',
        unit: 'USD',
        time: '2026-10-22T12:00:09.000Z',
        value: 0.75,
        attributes: { 'session.id': 's1', model: 'm' },
      },
    ]);
  });
});

describe('startHostTelemetryReceiver', () => {
  const open: Array<HostTelemetryReceiver | Server> = [];
  afterEach(async () => {
    for (const item of open.splice(0))
      await new Promise<void>((resolve) =>
        'collect' in item
          ? void item.close().then(resolve)
          : item.close(() => resolve())
      );
    vi.restoreAllMocks();
  });

  async function start(config = {}) {
    const receiver = await startHostTelemetryReceiver(config);
    open.push(receiver);
    return receiver;
  }

  const post = (
    url: string,
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' }
  ) =>
    fetch(url, {
      method: 'POST',
      headers,
      body:
        typeof body === 'string' || body instanceof Uint8Array
          ? body
          : JSON.stringify(body),
    });

  it("gives each trial its own session's records, once the host has sent them", async () => {
    const receiver = await start();
    expect(receiver.endpoint).toMatch(/^http:\/\/localhost:\d+\/[0-9a-f]{32}$/);
    const response = await post(
      `${receiver.endpoint}/v1/logs`,
      logs('s1', [{ name: 'user_prompt', time: '2026-10-22T12:00:00.000Z' }])
    );
    expect(response.status).toBe(200);
    await post(
      `${receiver.endpoint}/v1/logs`,
      logs('s2', [{ name: 'user_prompt', time: '2026-10-22T12:00:00.000Z' }])
    );
    // A late record still joins its trial.
    setTimeout(
      () =>
        void post(
          `${receiver.endpoint}/v1/logs`,
          logs('s1', [
            { name: 'api_request', time: '2026-10-22T12:00:02.000Z' },
          ])
        ),
      100
    );
    const first = await receiver.collect(['s1'], { settleMs: 300 });
    expect(first?.events.map((event) => event.name)).toEqual([
      'user_prompt',
      'api_request',
    ]);
    expect(first?.resource).toEqual({ 'service.name': 'claude-code' });
    const second = await receiver.collect(['s2'], { settleMs: 50 });
    expect(second?.events).toHaveLength(1);
    // Taken once.
    expect(await receiver.collect(['s1'], { maxWaitMs: 50 })).toBeUndefined();
  });

  it('takes gzip, and only OTLP/JSON under its own path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiver = await start();
    const zipped = await post(
      `${receiver.endpoint}/v1/logs`,
      new Uint8Array(
        gzipSync(
          JSON.stringify(
            logs('s1', [
              { name: 'user_prompt', time: '2026-10-22T12:00:00.000Z' },
            ])
          )
        )
      ),
      { 'content-type': 'application/json', 'content-encoding': 'gzip' }
    );
    expect(zipped.status).toBe(200);
    const base = receiver.endpoint.replace(/\/[0-9a-f]{32}$/, '');
    expect((await post(`${base}/v1/logs`, {})).status).toBe(404);
    expect(
      (
        await post(`${receiver.endpoint}/v1/logs`, 'x', {
          'content-type': 'application/x-protobuf',
        })
      ).status
    ).toBe(415);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OTLP/JSON only')
    );
    expect(
      (await receiver.collect(['s1'], { settleMs: 20 }))?.events
    ).toHaveLength(1);
  });

  it('says once when the host sends nothing, and stops waiting long', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiver = await start();
    expect(await receiver.collect(['s1'], { maxWaitMs: 50 })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const started = Date.now();
    expect(
      await receiver.collect(['s2'], { maxWaitMs: 10_000 })
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('forwards what it got, as it got it, with the collector token', async () => {
    const got: Array<{ url?: string; auth?: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        got.push({
          url: request.url,
          auth: request.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(200).end('{}');
      });
    });
    open.push(upstream);
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve)
    );
    const port = (upstream.address() as AddressInfo).port;
    const receiver = await startHostTelemetryReceiver(
      {
        forward: {
          endpoint: `http://localhost:${port}/`,
          bearerTokenEnv: 'COLLECTOR_TOKEN',
        },
      },
      { env: { COLLECTOR_TOKEN: 'tok' } }
    );
    open.push(receiver);
    const payload = logs('s1', [
      {
        name: 'user_prompt',
        time: '2026-10-22T12:00:00.000Z',
        attrs: { prompt: 'hi' },
      },
    ]);
    await post(`${receiver.endpoint}/v1/logs`, payload);
    await receiver.collect(['s1'], { settleMs: 20 });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({
      url: '/v1/logs',
      auth: 'Bearer tok',
      body: JSON.stringify(payload),
    });
  });
});

describe('host settings', () => {
  const receiver = {
    endpoint: 'http://localhost:4318/abc',
    content: false,
    traces: false,
  };

  it("points Claude Code's exporter at the receiver, per signal, without content", () => {
    const env = claudeCodeOtelEnv(receiver, { 'mst.run_id': 'run 1' });
    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/abc/v1/logs',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        'http://localhost:4318/abc/v1/metrics',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_LOG_USER_PROMPTS: '0',
      OTEL_LOG_TOOL_DETAILS: '0',
      OTEL_RESOURCE_ATTRIBUTES: 'mst.run_id=run%201',
    });
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
    const traced = claudeCodeOtelEnv({
      ...receiver,
      content: true,
      traces: true,
    });
    expect(traced).toMatchObject({
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/abc/v1/traces',
    });
  });

  it("writes Claude Desktop's otlp settings", () => {
    expect(claudeDesktopOtlpSettings(receiver, { 'mst.eval': 'e' })).toEqual({
      otlpEndpoint: 'http://localhost:4318/abc',
      otlpProtocol: 'http/json',
      otlpResourceAttributes: { 'mst.eval': 'e' },
    });
    expect(
      claudeDesktopOtlpSettings({ ...receiver, content: true, traces: true })
    ).toMatchObject({
      otlpContentCapture: expect.arrayContaining(['userPrompts']),
      otlpTracesEnabled: true,
    });
  });

  it("finds managed settings that keep Claude Code's telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), 'mst-managed-'));
    try {
      const plain = join(dir, 'a.json');
      const claimed = join(dir, 'b.json');
      writeFileSync(plain, JSON.stringify({ env: {} }));
      writeFileSync(claimed, JSON.stringify({ otelHeadersHelper: '/bin/h' }));
      expect(
        claudeCodeTelemetryClaim([plain, join(dir, 'none.json')])
      ).toBeUndefined();
      expect(claudeCodeTelemetryClaim([plain, claimed])).toBe(claimed);
      mkdirSync(join(dir, 'x'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(claudeCodeManagedSettingsPaths('linux')[0]).toBe(
      '/etc/claude-code/managed-settings.json'
    );
    expect(claudeCodeManagedSettingsPaths('darwin')[0]).toBe(
      '/Library/Application Support/ClaudeCode/managed-settings.json'
    );
  });

  it("gives model calls the request IDs the host's events name them by", () => {
    expect(
      withHostRequestIds(
        [
          { id: 'msg_1', entryIds: ['u1', 'u2'] },
          { id: 'msg_2', requestId: 'req_own' },
        ],
        {
          events: [
            {
              name: 'assistant_response',
              time: '2026-10-22T12:00:00.000Z',
              attributes: { message_uuid: 'u2', request_id: 'req_1' },
            },
          ],
        }
      )
    ).toEqual([
      { id: 'msg_1', entryIds: ['u1', 'u2'], requestId: 'req_1' },
      { id: 'msg_2', requestId: 'req_own' },
    ]);
  });
});
