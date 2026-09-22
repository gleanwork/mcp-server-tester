import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as OsModule from 'node:os';
import { join } from 'node:path';
import { CHATGPT_HOST } from './chatgptHost.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import { hostTraceToExecution } from './hostTrace.js';
import type { HostBatchRequest } from './evalFrameworkTypes.js';

const home = vi.hoisted(() => ({ value: '' }));
const lifecycle = vi.hoisted(() => ({ prepare: vi.fn(), dispose: vi.fn() }));
vi.mock('./chatgptSetup/macSession.js', () => ({
  ChatgptAppSession: class {
    prepare = lifecycle.prepare;
    dispose = lifecycle.dispose;
    telemetry = { scope: 'batch', id: 'test-batch' };
  },
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof OsModule>()),
  homedir: () => home.value,
}));
vi.mock('./externalHost/runtime.js', () => ({
  runExternalHostScenario: vi.fn(),
}));
const context = { manifest: { name: 'test', datasets: [], concurrency: 1 } };
const config = {
  type: 'chatgpt',
  model: 'test-chatgpt-model',
  reasoningEffort: 'medium',
};
const requests = (): HostBatchRequest[] =>
  ['one', 'two'].map((caseId) => ({
    caseId,
    iteration: 0,
    config,
    input: {
      scenario: `Answer ${caseId}`,
      servers: [
        {
          transport: 'http',
          label: 'glean',
          serverUrl: 'https://example.test/eval',
          auth: { accessToken: 'fixture-secret' },
        },
      ],
    },
  }));
const metadata = {
  driver: {
    provider: 'openai',
    product: 'chatgpt',
    surface: 'agent',
    runtime: 'desktop-app',
    platform: 'macos',
  },
  driverSlug: 'openai.chatgpt.agent.desktop-app.macos',
  displayName: 'ChatGPT',
  hostName: 'ChatGPT',
  hostType: 'desktop' as const,
  capabilitiesUsed: [],
  traceSource: 'host-local-transcript' as const,
  traceConfidence: 'high' as const,
  artifacts: [],
  session: { runMarker: 'marker', id: 'session', turnId: 'turn' },
  correlation: {
    strategy: 'prompt_marker' as const,
    marker: 'marker',
    includedInPrompt: true,
  },
};

beforeEach(async () => {
  home.value = await mkdtemp(join(tmpdir(), 'chatgpt-v2-test-'));
  lifecycle.prepare.mockReset().mockResolvedValue(undefined);
  lifecycle.dispose.mockReset().mockResolvedValue(undefined);
  vi.mocked(runExternalHostScenario)
    .mockReset()
    .mockImplementation(async () => ({
      success: true,
      response: 'answer',
      externalHost: {
        ...metadata,
        session: {
          ...metadata.session,
          id:
            vi.mocked(runExternalHostScenario).mock.calls.length === 1
              ? 'session'
              : `session-${vi.mocked(runExternalHostScenario).mock.calls.length}`,
        },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
        reasoningOutputTokens: 2,
      },
      toolCalls: [
        {
          name: 'search',
          source: 'mcp',
          server: 'glean',
          arguments: { query: 'test' },
          output: 'evidence',
          durationMs: 20,
          isError: false,
        },
      ],
    }));
});
afterEach(async () => {
  await rm(home.value, { recursive: true, force: true });
});

describe('ChatGPT V2 batch host', () => {
  it('defaults to exact-prompt matching and passes the eval query without any suffix', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.input.scenario =
      '  Find snake_case docs — α\nDo not change this.  ';
    await CHATGPT_HOST.runBatch!(batch, context);
    const [prompt, actual] = vi.mocked(runExternalHostScenario).mock.calls[0]!;
    expect(prompt).toBe(batch[0]!.input.scenario);
    expect(prompt).not.toContain('Evaluation MCP routing');
    expect(actual.correlation).toEqual({
      strategy: 'exact_prompt',
      includeInPrompt: false,
    });
  });
  it('exposes prompt markers only as an opt-in correlation mode', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, options: { correlation: 'prompt_marker' } };
    await CHATGPT_HOST.runBatch!(batch, context);
    expect(
      vi.mocked(runExternalHostScenario).mock.calls[0]![1].correlation
    ).toEqual({ strategy: 'prompt_marker', includeInPrompt: true });
  });
  it('prepares once before cases, shares only app state, and disposes once after them', async () => {
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runExternalHostScenario).mock.invocationCallOrder[0]!
    );
    expect(lifecycle.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runExternalHostScenario).mock.invocationCallOrder[1]!
    );
    const calls = vi.mocked(runExternalHostScenario).mock.calls;
    expect(calls[0]![1].options?.managedChatgptSession).toBe(
      calls[1]![1].options?.managedChatgptSession
    );
    expect(traces.map((r) => r.telemetry?.batchCase)).toEqual([
      { index: 0, caseId: 'one', count: 2 },
      { index: 1, caseId: 'two', count: 2 },
    ]);
    expect(traces[0]!.telemetry?.batchLifecycle).toEqual({
      scope: 'batch',
      id: 'test-batch',
    });
  });
  it.each(['servers', 'credentials', 'environment'])(
    'rejects mixed %s before app setup',
    async (difference) => {
      const batch = requests();
      if (difference === 'servers') batch[1]!.input.servers = [];
      else if (difference === 'credentials')
        batch[1]!.input.servers = [
          {
            transport: 'http',
            label: 'glean',
            serverUrl: 'https://example.test/eval',
            auth: { accessToken: 'different' },
          },
        ];
      else batch[1]!.input.env = { ANTHROPIC_API_KEY: 'different' };
      await expect(CHATGPT_HOST.runBatch!(batch, context)).rejects.toThrow(
        'identical MCP'
      );
      expect(lifecycle.prepare).not.toHaveBeenCalled();
    }
  );
  it('rejects duplicate native sessions and does not submit the next query', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
      externalHost: metadata,
    });
    const batch = [...requests(), { ...requests()[0]!, caseId: 'three' }];
    const traces = await CHATGPT_HOST.runBatch!(batch, context);
    expect(traces[1]!.error).toContain('duplicate attribution');
    expect(traces[2]!.error).toContain('No automatic retries');
    expect(runExternalHostScenario).toHaveBeenCalledTimes(2);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  });
  it('retains evidence and a recovery lock when batch cleanup fails', async () => {
    lifecycle.dispose.mockRejectedValueOnce(new Error('restore failed'));
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(traces.every((r) => r.error?.includes('batch cleanup failed'))).toBe(
      true
    );
    expect(traces[0]!.finalText).toBe('answer');
    expect(traces[0]!.telemetry?.externalHost).toBeDefined();
    await expect(
      access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
    ).resolves.toBeUndefined();
    await expect(CHATGPT_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'locked'
    );
  });
  it('cleans up partial setup before releasing the desktop lease', async () => {
    lifecycle.prepare.mockRejectedValueOnce(new Error('launch failed'));
    await expect(CHATGPT_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'launch failed'
    );
    expect(runExternalHostScenario).not.toHaveBeenCalled();
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
    await expect(
      access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
    ).rejects.toThrow();
  });
  it('forwards controller settings independently of the evaluated model', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.config = {
      ...config,
      options: {
        computerUseModel: 'claude-sonnet-4-6',
        computerUseMaxActions: 40,
      },
    };
    await CHATGPT_HOST.runBatch!(batch, {
      ...context,
      env: { ANTHROPIC_API_KEY: 'controller-secret' },
    });
    expect(vi.mocked(runExternalHostScenario).mock.calls[0]![1]).toMatchObject({
      model: 'test-chatgpt-model',
      options: {
        computerUseModel: 'claude-sonnet-4-6',
        computerUseMaxActions: 40,
        computerUseEnvironment: { ANTHROPIC_API_KEY: 'controller-secret' },
      },
    });
    expect(
      vi.mocked(runExternalHostScenario).mock.calls[0]![1].options?.environment
    ).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
  it('rejects deterministic and Linux UI providers for this macOS host', async () => {
    const batch = requests();
    batch[0]!.config = {
      ...config,
      options: { computerUseProvider: 'linux-desktop' },
    };
    await expect(CHATGPT_HOST.runBatch!(batch, context)).rejects.toThrow();
    expect(runExternalHostScenario).not.toHaveBeenCalled();
  });
  it('runs ordered cases and preserves model, evidence, timing and unknown cost', async () => {
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(runExternalHostScenario).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runExternalHostScenario).mock.calls[0]![1]).toMatchObject({
      model: 'test-chatgpt-model',
      reasoningEffort: 'medium',
      codexSetup: {
        servers: [
          {
            transport: 'http',
            label: 'glean',
            bearerTokenEnvVar: 'MST_CHATGPT_MCP_TOKEN_0',
          },
        ],
      },
      options: {
        environment: { MST_CHATGPT_MCP_TOKEN_0: 'fixture-secret' },
        computerUseProvider: 'anthropic-computer-use',
        computerUseMaxActions: 32,
      },
    });
    expect(JSON.stringify(traces)).not.toContain('fixture-secret');
    expect(traces[0]!.usage?.totalCostUsd).toBeUndefined();
    expect(traces[0]!.telemetry?.externalHost).toMatchObject({
      session: { id: 'session', turnId: 'turn' },
    });
    expect(
      hostTraceToExecution(traces[0]!, 'structured').response
    ).toMatchObject({
      toolCalls: [
        {
          name: 'search',
          source: 'mcp',
          server: 'glean',
          durationMs: 20,
          output: 'evidence',
        },
      ],
    });
    await expect(
      CHATGPT_HOST.runBatch!(requests().slice(0, 1), context)
    ).resolves.toHaveLength(1);
  });
  it('subtracts native cache reads from V2 uncached input, retaining native totals', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      toolCalls: [],
      externalHost: {
        ...metadata,
        telemetry: { inputTokens: 10, cacheReadInputTokens: 6 },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 6,
        durationMs: 100,
      },
    });
    const [trace] = await CHATGPT_HOST.runBatch!(
      requests().slice(0, 1),
      context
    );
    expect(trace!.usage).toMatchObject({
      inputTokens: 4,
      cacheReadInputTokens: 6,
    });
    expect(trace!.telemetry?.externalHost).toMatchObject({
      telemetry: { inputTokens: 10 },
    });
  });
  it('fails out-of-selection MCP calls without blocking later completed measurements', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'plausible answer',
      externalHost: metadata,
      toolCalls: [
        {
          name: 'search',
          server: 'other-plugin',
          source: 'mcp',
          arguments: {},
        },
      ],
    });
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(traces[0]!.error).toContain('outside');
    expect(runExternalHostScenario).toHaveBeenCalledTimes(2);
    expect(traces[1]!.error).toBeUndefined();
    expect(traces[0]!.telemetry?.caseExecution).toEqual({
      status: 'completed',
      continuation: 'allowed',
    });
    expect(traces[0]!.telemetry?.mcpSelection).toMatchObject({
      status: 'failed',
      unexpectedServers: ['other-plugin'],
    });
  });
  it('measures three cases despite host-tool-only and wrong-server failures', async () => {
    vi.mocked(runExternalHostScenario)
      .mockResolvedValueOnce({
        success: true,
        response: 'Cannot access the desktop app',
        externalHost: metadata,
        toolCalls: [
          {
            name: 'js',
            rawName: 'cua_repl.js',
            source: 'host',
            server: 'cua_repl',
            arguments: {},
            isError: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        response: 'answer via another plugin',
        externalHost: {
          ...metadata,
          session: { ...metadata.session, id: 'second', turnId: 'second-turn' },
        },
        toolCalls: [
          {
            name: 'search',
            source: 'mcp',
            server: 'other-plugin',
            arguments: {},
          },
        ],
      });
    const batch = [...requests(), { ...requests()[0]!, caseId: 'three' }].map(
      (r) => ({
        ...r,
        config: { ...config, options: { requireMcpCalls: true } },
      })
    );
    const traces = await CHATGPT_HOST.runBatch!(batch, context);
    expect(runExternalHostScenario).toHaveBeenCalledTimes(3);
    expect(traces.map((r) => r.telemetry?.caseExecution)).toEqual(
      Array(3).fill({ status: 'completed', continuation: 'allowed' })
    );
    expect(traces[0]!.error).toContain('without calling');
    expect(traces[0]!.error).not.toContain('outside');
    expect(traces[1]!.error).toContain('outside');
    expect(traces[2]!.error).toBeUndefined();
    expect(traces[0]!.telemetry?.mcpSelection).toMatchObject({
      status: 'failed',
      configuredMcpCallCount: 0,
      externalMcpCallCount: 0,
      hostToolCallCount: 1,
      unexpectedServers: [],
    });
    expect(traces[2]!.telemetry?.mcpSelection).toMatchObject({
      status: 'passed',
      configuredMcpCallCount: 1,
    });
    expect(
      hostTraceToExecution(traces[0]!, 'structured').response
    ).toMatchObject({
      toolCalls: [
        {
          source: 'host',
          name: 'js',
          rawName: 'cua_repl.js',
          server: undefined,
          isError: true,
        },
      ],
    });
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  });
  it('allows built-in tools alongside configured MCP calls without relaxing the MCP requirement', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      externalHost: metadata,
      toolCalls: [
        {
          name: 'js',
          rawName: 'cua_repl.js',
          source: 'host',
          server: 'cua_repl',
          arguments: {},
        },
        { name: 'search', source: 'mcp', server: 'glean', arguments: {} },
      ],
    });
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, options: { requireMcpCalls: true } };
    const [trace] = await CHATGPT_HOST.runBatch!(batch, context);
    expect(trace!.error).toBeUndefined();
    expect(trace!.telemetry?.mcpSelection).toMatchObject({
      status: 'passed',
      configuredMcpCallCount: 1,
      hostToolCallCount: 1,
    });
  });
  it('blocks later submissions when native usage evidence is inconsistent', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      toolCalls: [],
      externalHost: metadata,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 2,
        durationMs: 1,
      },
    });
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(traces[0]!.error).toContain('cached input exceeds');
    expect(traces[0]!.telemetry?.caseExecution).toEqual({
      status: 'failed',
      continuation: 'blocked',
    });
    expect(traces[1]!.telemetry?.caseExecution).toEqual({
      status: 'not-submitted',
      continuation: 'blocked',
    });
    expect(runExternalHostScenario).toHaveBeenCalledTimes(1);
  });
  it('requires native MCP calls when the eval explicitly requests them', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'no tools',
      externalHost: metadata,
      toolCalls: [],
    });
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, options: { requireMcpCalls: true } };
    const [trace] = await CHATGPT_HOST.runBatch!(batch, context);
    expect(trace!.error).toContain('without calling');
  });
  it('does not submit subsequent cases after an ambiguous or failed run', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: false,
      error: 'no matching session',
      toolCalls: [],
      externalHost: metadata,
    });
    const traces = await CHATGPT_HOST.runBatch!(requests(), context);
    expect(runExternalHostScenario).toHaveBeenCalledTimes(1);
    expect(traces[1]!.error).toContain('No automatic retries');
  });
  it('fails before touching the app when a different process holds the desktop', async () => {
    await mkdir(join(home.value, '.mcp-server-tester'));
    await writeFile(
      join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'),
      'another run'
    );
    await expect(CHATGPT_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'locked'
    );
    expect(runExternalHostScenario).not.toHaveBeenCalled();
  });
  it('rejects concurrency and mixed model configurations', async () => {
    await expect(
      CHATGPT_HOST.runBatch!(requests(), {
        manifest: { ...context.manifest, concurrency: 2 },
      })
    ).rejects.toThrow('concurrency 1');
    const mixed = requests();
    mixed[1]!.config = { ...config, model: 'other' };
    await expect(CHATGPT_HOST.runBatch!(mixed, context)).rejects.toThrow(
      'identical'
    );
    expect(runExternalHostScenario).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'primitive failure'])(
    'does not silently accept a non-Error rejection: %s',
    async (reason) => {
      vi.mocked(runExternalHostScenario).mockRejectedValueOnce(reason);
      await expect(
        CHATGPT_HOST.runBatch!(requests(), context)
      ).rejects.toThrow();
      expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
      await expect(
        access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
      ).rejects.toThrow();
    }
  );
  it('releases its lease after unexpected execution errors', async () => {
    vi.mocked(runExternalHostScenario).mockRejectedValueOnce(
      new Error('crash')
    );
    await expect(CHATGPT_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'crash'
    );
    await expect(
      CHATGPT_HOST.runBatch!(requests(), context)
    ).resolves.toHaveLength(2);
  });
});

describe('ChatGPT server translation', () => {
  it('retains explicit MCP provenance when multiple servers are configured', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.input.servers.push({
      transport: 'stdio',
      label: 'second',
      command: 'node',
    });
    const traces = await CHATGPT_HOST.runBatch!(batch, context);
    expect(
      hostTraceToExecution(traces[0]!, 'structured', batch[0]!.input.servers)
        .response
    ).toMatchObject({
      toolCalls: [
        {
          name: 'glean.search',
          source: 'mcp',
          server: 'glean',
          durationMs: 20,
        },
      ],
    });
  });
});
