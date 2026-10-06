import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { getBuiltinHostConfig } from './builtinHosts.js';
import { getHost } from './builtinHosts.js';
import { createMCPClientForConfig } from '../mcp/clientFactory.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { ToolOverrideVariant } from './evalRunner.js';
import type { HostRunInput } from './evalFrameworkTypes.js';

// Keep real ai.generateText + schema conversion; only the provider and transport are offline.
const mocks = vi.hoisted(() => ({ model: vi.fn(), provider: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.provider }));
vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
const answer = {
  content: [{ type: 'text' as const, text: 'done' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
};
let model: MockLanguageModelV3;
const callTool = vi.fn(async () => ({
  content: [{ type: 'text', text: 'found' }],
}));
function run(
  config: Record<string, unknown> = {},
  servers: MCPConfig[] = [],
  toolOverrides?: ToolOverrideVariant,
  env?: Record<string, string | undefined>
) {
  const input: HostRunInput & { env?: Record<string, string | undefined> } = {
    prompt: 'search',
    servers,
    env,
  };
  return getHost('vercel-sdk').run!(
    input,
    { type: 'vercel-sdk', provider: 'openai', ...config },
    { manifest: { name: 'offline', datasets: [], toolOverrides } }
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  model = new MockLanguageModelV3({ doGenerate: answer });
  mocks.model.mockImplementation(() => model);
  mocks.provider.mockReturnValue(mocks.model);
  vi.mocked(createMCPClientForConfig).mockResolvedValue({
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: 'search',
          description: 'original',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })),
    callTool,
  } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('SDK host through the real AI SDK', () => {
  it('forwards model, temperature, output token budget and a live deadline signal', async () => {
    const result = await run({
      model: 'case-model',
      temperature: 0.4,
      maxTokens: 123,
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('done');
    expect(mocks.model).toHaveBeenCalledWith('case-model');
    expect(model.doGenerateCalls[0]).toMatchObject({
      temperature: 0.4,
      maxOutputTokens: 123,
    });
    expect(model.doGenerateCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });
  it('enforces timeout even when the model ignores cancellation', async () => {
    vi.useFakeTimers();
    model = new MockLanguageModelV3({
      doGenerate: async () => new Promise(() => {}),
    });
    const pending = run({ timeout: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).error).toContain('timed out');
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears the lifecycle timer after successful execution', async () => {
    vi.useFakeTimers();
    expect((await run({ timeout: 1000 })).finalText).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses execution-local credentials and does not mutate process.env', async () => {
    const before = process.env.OPENAI_API_KEY;
    await run({}, [], undefined, { OPENAI_API_KEY: 'run-only' });
    expect(mocks.provider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'run-only' })
    );
    expect(process.env.OPENAI_API_KEY).toBe(before);
  });
  it.each(['host', 'case'] as const)(
    'uses explicit %s credentials ahead of suite environment at the SDK provider boundary',
    async (precedence) => {
      vi.stubEnv('OPENAI_API_KEY', 'ambient');
      const input = {
        prompt: 'hello',
        servers: [],
        env: { OPENAI_API_KEY: 'suite' },
      };
      const host = {
        type: 'vercel-sdk',
        provider: 'openai',
        env: { OPENAI_API_KEY: 'host' },
      };
      const context = {
        manifest: { name: 'offline', datasets: [] },
        env: { OPENAI_API_KEY: 'context' },
        mcpHostConfig:
          precedence === 'case' ? { env: { OPENAI_API_KEY: 'case' } } : {},
      };
      const before = structuredClone({ input, host, context });
      const result = await getHost('vercel-sdk').run!(input, host, context);
      expect(result.error).toBeUndefined();
      expect(result.finalText).toBe('done');
      expect(mocks.provider).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: precedence })
      );
      expect({ input, host, context }).toEqual(before);
      expect(process.env.OPENAI_API_KEY).toBe('ambient');
    }
  );
  it('applies server-qualified overrides before encoding provider names', async () => {
    const servers: MCPConfig[] = ['a', 'b'].map((label) => ({
      transport: 'http',
      serverUrl: `https://${label}.invalid`,
      label,
    }));
    await run({}, servers, {
      id: 'variant',
      tools: { 'a.search': { description: 'changed' } },
    });
    expect(model.doGenerateCalls[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'a__search', description: 'changed' }),
        expect.objectContaining({ name: 'b__search', description: 'original' }),
      ])
    );
    const ambiguous = await run({}, servers, {
      id: 'bad',
      tools: { search: { description: 'changed' } },
    });
    expect(ambiguous.error).toContain(
      'override "search" matches a tool on several servers; use "server.tool"'
    );
  });
  it('routes provider-encoded tool calls back to the original MCP name', async () => {
    model = new MockLanguageModelV3({
      doGenerate: async () =>
        model.doGenerateCalls.length === 1
          ? {
              ...answer,
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'one',
                  toolName: 'a__search',
                  input: '{}',
                },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool_use' },
            }
          : answer,
    });
    const result = await run(
      {},
      ['a', 'b'].map((label) => ({
        transport: 'http',
        serverUrl: `https://${label}.invalid`,
        label,
      }))
    );
    expect(result.error).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: {} });
    expect(result.events).toMatchObject([
      { source: 'mcp', server: 'a', name: 'search' },
    ]);
  });
  it('renames a tool on one server and routes calls to the original', async () => {
    model = new MockLanguageModelV3({
      doGenerate: async () =>
        model.doGenerateCalls.length === 1
          ? {
              ...answer,
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'one',
                  toolName: 'a__find',
                  input: '{}',
                },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool_use' },
            }
          : answer,
    });
    const result = await run(
      {},
      ['a', 'b'].map((label) => ({
        transport: 'http',
        serverUrl: `https://${label}.invalid`,
        label,
      })),
      { id: 'renamed', tools: { 'a.search': { name: 'find' } } }
    );
    expect(result.error).toBeUndefined();
    expect(model.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'a__find',
      'b__search',
    ]);
    expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: {} });
    expect(result.events).toMatchObject([
      { source: 'mcp', server: 'a', name: 'search', rawName: 'a__find' },
    ]);
  });
  it('renames a tool on a single server', async () => {
    model = new MockLanguageModelV3({
      doGenerate: async () =>
        model.doGenerateCalls.length === 1
          ? {
              ...answer,
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'one',
                  toolName: 'find',
                  input: '{}',
                },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool_use' },
            }
          : answer,
    });
    const result = await run(
      {},
      [{ transport: 'http', serverUrl: 'https://one.invalid' }],
      { id: 'renamed', tools: { search: { name: 'find' } } }
    );
    expect(result.error).toBeUndefined();
    expect(model.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'find',
    ]);
    expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: {} });
    expect(result.events).toMatchObject([
      { source: 'mcp', name: 'search', rawName: 'find' },
    ]);
  });
  it("puts a systemPrompt in the model's system prompt", async () => {
    const result = await run({ systemPrompt: 'Use find_skills first.' }, [
      { transport: 'http', serverUrl: 'https://one.invalid' },
    ]);
    expect(result.error).toBeUndefined();
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({
      role: 'system',
      content: 'Use find_skills first.',
    });
  });
  it('passes a claude-cli systemPrompt with --append-system-prompt', () => {
    const config = getHost('claude-cli').createConfig!({
      systemPrompt: 'Use find_skills first.',
    });
    const args = config.cli!.args;
    // The runner fills the placeholder, so the prompt is never re-scanned.
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(
      '{{systemPrompt}}'
    );
    expect(config.systemPrompt).toBe('Use find_skills first.');
    expect(getHost('claude-cli').createConfig!({}).cli!.args).not.toContain(
      '--append-system-prompt'
    );
  });
  it('enforces zero calls even if the real SDK receives a tool request', async () => {
    model = new MockLanguageModelV3({
      doGenerate: {
        ...answer,
        content: [
          {
            type: 'tool-call',
            toolCallId: 'one',
            toolName: 'search',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      },
    });
    const result = await run({ maxToolCalls: 0 }, [
      { transport: 'http', serverUrl: 'https://test.invalid' },
    ]);
    expect(result.error).toContain('budget exhausted');
    expect(callTool).not.toHaveBeenCalled();
  });
  it.each([
    { timeout: 0 },
    { maxTokens: 0 },
    { temperature: 2 },
    { maxToolCalls: -1 },
    { unsupported: true },
  ])('rejects invalid host options %j before execution', async (config) => {
    await expect(run(config)).rejects.toThrow();
    expect(mocks.model).not.toHaveBeenCalled();
  });
});

describe('CLI connection policy preflight', () => {
  it.each([
    { auth: { clientCredentials: { tokenEndpoint: 'https://auth.invalid' } } },
    { tls: { cert: '/cert.pem', key: '/key.pem' } },
    { proxy: { url: 'http://proxy.invalid' } },
    { retryAttempts: 2 },
  ])(
    'rejects unsupported HTTP policy before config generation: %j',
    (policy) => {
      expect(() =>
        getBuiltinHostConfig('claude-cli', {
          servers: [
            { transport: 'http', serverUrl: 'https://test.invalid', ...policy },
          ],
        })
      ).toThrow("claude-cli can't forward");
    }
  );
  it('uses runtime environment for CLI provider configuration without mutation', () => {
    vi.stubEnv('ANTHROPIC_VERTEX_PROJECT_ID', undefined);
    vi.stubEnv('GOOGLE_VERTEX_PROJECT', 'ambient-project');
    const before = process.env.GOOGLE_VERTEX_PROJECT;
    const config = getBuiltinHostConfig('claude-cli', {
      provider: 'vertex',
      env: { GOOGLE_VERTEX_PROJECT: 'run-project' },
    });
    expect(config.cli?.env?.ANTHROPIC_VERTEX_PROJECT_ID).toBe('run-project');
    expect(config.cli?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.GOOGLE_VERTEX_PROJECT).toBe(before);
  });
  it('serializes supported static token and headers', () => {
    const config = getBuiltinHostConfig('claude-cli', {
      servers: [
        {
          transport: 'http',
          label: 'a',
          serverUrl: 'https://test.invalid',
          auth: { accessToken: 'token' },
          headers: { 'X-Test': 'yes' },
        },
      ],
    });
    expect(config.mcpServers?.a).toMatchObject({
      headers: { Authorization: 'Bearer token', 'X-Test': 'yes' },
    });
  });
  it.each([{ maxTokens: 100 }, { temperature: 0.2 }, { maxToolCalls: 0 }])(
    'explicitly rejects unsupported CLI generation policy %j',
    (config) => {
      expect(() => getBuiltinHostConfig('claude-cli', config)).toThrow();
    }
  );
});

describe('vercel-sdk skills', () => {
  it.each([
    ['catalog', 'catalog'],
    ['preload', 'preload'],
    ['off', undefined],
  ] as const)('skills: %s gives the SDK host skills %s', (skills, expected) => {
    const config = getHost('vercel-sdk').createConfig!({
      provider: 'anthropic',
      skills,
    });
    expect(config.skills).toBe(expected);
  });
});
