import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_HOST } from './anthropicApiHost.js';
import { hostTraceToExecution } from './hostTrace.js';
async function run(
  options: HostRunOptions,
  extra: Partial<HostRunContext> = {}
) {
  const trace = await ANTHROPIC_API_HOST.run!(
    {
      scenario: options.cases[0]!.scenario!,
      servers: options.servers,
      env: extra.env,
    },
    options.host,
    { manifest: options.manifest, arm: options.arm, ...extra }
  );
  return hostTraceToExecution(trace, 'structured', options.servers);
}
import type { HostRunOptions, HostRunContext } from './evalFrameworkTypes.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';

vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
const callTool = vi.fn(async () => ({
  content: [{ type: 'text', text: 'tool output' }],
}));
const close = vi.fn(async () => {});
const listTools = vi.fn(async () => ({
  tools: [
    {
      name: 'search',
      description: 'original',
      inputSchema: { type: 'object' },
    },
  ],
}));
const fetchMock = vi.fn<typeof fetch>();
const case_ = {
  id: 'one',
  mode: 'mcp_host' as const,
  scenario: 'Search',
  iterations: 3,
};
function options(maxToolCalls = 10): HostRunOptions {
  return {
    dataset: { name: 'test', cases: [case_] },
    cases: [case_],
    servers: [{ transport: 'http', serverUrl: 'https://example.com' }],
    host: { type: 'anthropic-api', maxToolCalls },
    manifest: { name: 'test', datasets: [] },
  };
}
function response(content: unknown[], stop_reason = 'end_turn'): Response {
  return new Response(
    JSON.stringify({
      content,
      stop_reason,
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
    { status: 200 }
  );
}
function calls(count: number): Response {
  return response(
    Array.from({ length: count }, (_, index) => ({
      type: 'tool_use',
      id: `call-${index}`,
      name: 'search',
      input: { query: 'test' },
    })),
    'tool_use'
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'dummy-key');
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(createMCPClientForConfig).mockResolvedValue({
    callTool,
    listTools,
    close,
  } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Anthropic trace execution', () => {
  it.each([0, 1])(
    'enforces a budget of %s before every tool call',
    async (budget) => {
      fetchMock.mockResolvedValueOnce(calls(3));
      const result = await run(options(budget));
      expect(callTool).toHaveBeenCalledTimes(budget);
      expect(result.error).toContain('budget exhausted');
      expect(result).not.toHaveProperty('passed');
      expect(closeMCPClient).toHaveBeenCalledTimes(1);
    }
  );
  it('returns text and argument evidence without scoring or owning iterations', async () => {
    fetchMock
      .mockResolvedValueOnce(calls(1))
      .mockResolvedValueOnce(response([{ type: 'text', text: 'WRONG' }]));
    const result = await run(options());
    expect(result.error).toBeUndefined();
    expect(result.response).toMatchObject({
      response: 'WRONG',
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.hostUsage?.inputTokens).toBe(4);
  });
  it('times out a never-settling fetch, aborts the request and closes the client', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const input = options();
    input.host.timeout = 10;
    const pending = run(input);
    await vi.advanceTimersByTimeAsync(11);
    const result = await pending;
    expect(result.error).toContain('timed out');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(closeMCPClient).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds session teardown and force-closes the transport when termination stalls', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response([{ type: 'text', text: 'OK' }]));
    vi.mocked(closeMCPClient).mockImplementationOnce(
      () => new Promise(() => {})
    );
    const input = options();
    input.host.timeout = 10;
    const pending = run(input);
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).error).toContain('timed out');
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors legacy case host settings before execution', async () => {
    fetchMock.mockResolvedValueOnce(calls(1));
    const input = options(10);
    input.host.model = 'suite-model';
    const result = await run(input, {
      mcpHostConfig: { model: 'case-model', maxToolCalls: 0 },
    });
    expect(result.error).toContain('budget exhausted');
    expect(callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      'case-model'
    );
  });

  it('applies server-qualified overrides consistently across labeled servers', async () => {
    fetchMock.mockResolvedValueOnce(response([{ type: 'text', text: 'OK' }]));
    const input = options();
    input.servers = [
      { transport: 'http', serverUrl: 'https://a.example', label: 'a' },
      { transport: 'http', serverUrl: 'https://b.example', label: 'b' },
    ];
    input.manifest.toolOverrides = {
      id: 'qualified',
      tools: { 'a.search': { description: 'only-a' } },
    };
    await run(input);
    const body = JSON.stringify(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain('only-a');
    expect(body).toContain('b__search');
  });

  it('applies description overrides and supports a no-server assistant', async () => {
    fetchMock.mockResolvedValueOnce(response([{ type: 'text', text: 'OK' }]));
    const input = options();
    input.manifest.toolOverrides = {
      id: 'variant',
      tools: { search: { description: 'changed' } },
    };
    await run(input);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('changed');
    fetchMock.mockResolvedValueOnce(response([{ type: 'text', text: 'OK' }]));
    await run({ ...options(), servers: [] });
    expect(createMCPClientForConfig).toHaveBeenCalledTimes(1);
  });
});
