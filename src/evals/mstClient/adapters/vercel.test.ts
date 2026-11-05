import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runVercelClient, stepModelCalls } from './vercel.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { createFixtureExtensions } from '../../../mcp/fixtures/fixtureExtensions.js';

// jsonSchema mock function — captured here so tests can inspect calls
const jsonSchemaMock = vi.fn((schema: Record<string, unknown>) => ({
  _type: 'json-schema' as const,
  jsonSchema: schema,
  validate: undefined,
}));

// Mock @ai-sdk/provider-utils (optional transitive dep — not directly importable)
vi.mock('@ai-sdk/provider-utils', () => ({
  jsonSchema: jsonSchemaMock,
}));

// Mock the 'ai' package
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'Final answer',
    steps: [
      {
        toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }],
        toolResults: [{ result: 'Sunny, 20°C' }],
        text: '',
      },
    ],
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
  streamText: vi.fn(() => ({
    consumeStream: () => Promise.resolve(),
    steps: Promise.resolve([]),
    text: Promise.resolve('Streamed answer'),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  })),
  tool: vi.fn(
    (config: {
      description: string;
      parameters: unknown;
      execute: (args: unknown) => Promise<string>;
    }) => config
  ),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ id: 'claude' }))),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => ({ id: 'gpt-4o' }))),
}));

function createMockMCP(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: 'get_weather',
      description: 'Get weather',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 20°C' }],
      isError: false,
    }),
  };
}

describe('runVercelClient', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Restore the jsonSchema mock implementation after clearAllMocks
    jsonSchemaMock.mockImplementation((schema: Record<string, unknown>) => ({
      _type: 'json-schema' as const,
      jsonSchema: schema,
      validate: undefined,
    }));

    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'Final answer',
      steps: [
        {
          stepType: 'tool-result',
          toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }],
          toolResults: [{ result: 'Sunny, 20°C' }],
          text: '',
        },
      ],
      usage: { inputTokens: 100, outputTokens: 50 },
    } as never);

    const { createOpenAI } = await import('@ai-sdk/openai');
    vi.mocked(createOpenAI).mockReturnValue(
      vi.fn(() => ({ id: 'gpt-4o' })) as never
    );
  });

  it('returns a common result with model and MCP timing', async () => {
    const result = await runVercelClient(
      createMockMCP(),
      'What is the weather in London?',
      { provider: 'openai', model: 'gpt-4o' }
    );

    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('Final answer');
    expect(result.llmDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry?.mcpDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry?.content).toMatchObject({
      input: 'What is the weather in London?',
      conversationHistory: [{ role: 'tool' }],
    });
  });

  it('points the anthropic provider at the public API with its /v1 base URL by default', async () => {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText, streamText } = await import('ai');
    vi.mocked(generateText).mockClear();
    const result = await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'anthropic',
      model: 'claude',
      env: { ANTHROPIC_API_KEY: 'key' },
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'key',
    });
    // The anthropic provider runs its agent loop with streamText.
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('Streamed answer');
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('drops ANTHROPIC_AUTH_TOKEN without a base URL override', async () => {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    vi.mocked(createAnthropic).mockClear();
    await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'anthropic',
      model: 'claude',
      env: { ANTHROPIC_AUTH_TOKEN: 'gateway-token', ANTHROPIC_API_KEY: 'key' },
    });

    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'key',
    });
  });

  it('keeps OpenAI response storage on for the public API', async () => {
    const { generateText } = await import('ai');
    await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    const options = vi.mocked(generateText).mock.calls[0]?.[0] as {
      providerOptions?: unknown;
    };
    expect(options.providerOptions).toBeUndefined();
  });

  it('turns OpenAI response storage off behind a base URL override', async () => {
    const { generateText } = await import('ai');
    await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
      env: { OPENAI_BASE_URL: 'https://gateway.example/openai/v1' },
    });

    const options = vi.mocked(generateText).mock.calls[0]?.[0] as {
      providerOptions?: unknown;
    };
    expect(options.providerOptions).toEqual({ openai: { store: false } });
  });

  it('should capture token usage from SDK response', async () => {
    const result = await runVercelClient(
      createMockMCP(),
      'What is the weather?',
      { provider: 'openai', model: 'gpt-4o' }
    );

    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(50);
    // The SDK reports tokens, not cost: unknown, not zero.
    expect(result.usage!.totalCostUsd).toBeUndefined();
    expect(result.usage!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should omit usage when SDK does not return it', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'Answer',
      steps: [],
    } as never);

    const result = await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(result.error).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('returns an error on a failed run', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API error'));

    const result = await runVercelClient(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(result.finalText).toBe('');
    expect(result.error).toContain('API error');
  });

  it('retains completed MCP calls when the next model request fails', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (options: {
      tools: Record<
        string,
        {
          execute(
            args: Record<string, unknown>,
            options: { toolCallId: string }
          ): Promise<string>;
        }
      >;
    }) => {
      await options.tools.get_weather!.execute(
        { city: 'London' },
        { toolCallId: 'weather-1' }
      );
      throw Object.assign(new Error('Overloaded'), { statusCode: 529 });
    }) as never);
    const result = await runVercelClient(createMockMCP(), 'Weather?', {
      provider: 'openai',
    });
    expect(result.finalText).toBe('');
    expect(result.error).toContain('Overloaded');
    expect(result.ending).toMatchObject({
      kind: 'infrastructure',
      broke: 'provider',
      retryable: true,
    });
    expect(result.events).toMatchObject([
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'get_weather',
        rawName: 'get_weather',
        id: 'weather-1',
        arguments: { city: 'London' },
        output: 'Sunny, 20°C',
      },
    ]);
    expect(result.telemetry).toBeUndefined();
  });

  it.each([false, true])(
    'keeps an empty skill-load array when a skill session ran (failed: %s)',
    async (failed) => {
      const mcp = createMockMCP();
      vi.spyOn(mcp.skills, 'supported').mockReturnValue(true);
      vi.spyOn(mcp.skills, 'list').mockResolvedValue([]);
      if (failed) {
        const { generateText } = await import('ai');
        vi.mocked(generateText).mockRejectedValueOnce(new Error('API error'));
      }
      const result = await runVercelClient(mcp, 'Weather?', {
        provider: 'openai',
        skills: 'catalog',
      });
      expect(result.telemetry).toHaveProperty('skillLoads', []);
      expect(result.events).toEqual([]);
      if (failed) expect(result.error).toContain('API error');
      else expect(result.error).toBeUndefined();
    }
  );

  describe('MCP tool schema conversion', () => {
    it('converts a required-field MCP tool to Vercel tool format with inputSchema', async () => {
      const mcp = createMockMCP([
        {
          name: 'search',
          description: 'Search documents',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ]);

      await runVercelClient(mcp, 'Search for docs', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      // jsonSchemaMock should have been called with the tool's input schema
      expect(jsonSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ query: { type: 'string' } }),
          required: ['query'],
        })
      );
    });

    it('handles optional fields (no required array) correctly', async () => {
      const mcp = createMockMCP([
        {
          name: 'list_items',
          description: 'List items with optional filter',
          inputSchema: {
            type: 'object',
            properties: { filter: { type: 'string' } },
          },
        },
      ]);

      await runVercelClient(mcp, 'List all items', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(jsonSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ filter: { type: 'string' } }),
        })
      );
    });

    it('handles array-type parameters in tool schema', async () => {
      const mcp = createMockMCP([
        {
          name: 'batch_search',
          description: 'Search with multiple queries',
          inputSchema: {
            type: 'object',
            properties: {
              queries: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['queries'],
          },
        },
      ]);

      await runVercelClient(mcp, 'Run batch search', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(jsonSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            queries: { type: 'array', items: { type: 'string' } },
          }),
        })
      );
    });

    it('preserves enum constraints in tool schema', async () => {
      const mcp = createMockMCP([
        {
          name: 'get_status',
          description: 'Get entity status',
          inputSchema: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['active', 'inactive', 'pending'],
              },
            },
            required: ['status'],
          },
        },
      ]);

      await runVercelClient(mcp, 'Get status', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(jsonSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            status: expect.objectContaining({
              enum: ['active', 'inactive', 'pending'],
            }),
          }),
        })
      );
    });

    it('ensures type:object is always present even if the server omits it', async () => {
      // Some MCP servers omit type:'object' from inputSchema
      const mcp = createMockMCP([
        {
          name: 'no_type_tool',
          description: 'Tool without type:object',
          inputSchema: {
            // Note: no 'type' field
            properties: { param: { type: 'string' } },
          },
        },
      ]);

      await runVercelClient(mcp, 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      // The adapter always adds type:'object' — Anthropic requires it
      expect(jsonSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'object' })
      );
    });

    it('converts multiple MCP tools by calling jsonSchema once per tool', async () => {
      const mcp = createMockMCP([
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
        {
          name: 'get_document',
          description: 'Get a document by ID',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ]);

      await runVercelClient(mcp, 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      // jsonSchema should have been called once per tool
      expect(jsonSchemaMock).toHaveBeenCalledTimes(2);
    });

    it('uses empty string as description when MCP tool has no description', async () => {
      const mcp = createMockMCP([
        {
          name: 'no_desc_tool',
          // No description field
          inputSchema: { type: 'object', properties: {} },
        },
      ]);

      await runVercelClient(mcp, 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      const { generateText } = await import('ai');
      const callArg = vi.mocked(generateText).mock.calls[0]?.[0] as {
        tools: Record<string, { description: string }>;
      };
      expect(callArg?.tools?.['no_desc_tool']?.description).toBe('');
    });
  });

  describe('error classification', () => {
    it('classifies authentication errors with a helpful hint', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error('401 Unauthorized: Invalid API key')
      );

      const result = await runVercelClient(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.error).toContain('authentication error');
    });

    it('classifies rate limit errors with a helpful hint', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error('429 Too Many Requests')
      );

      const result = await runVercelClient(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.error).toContain('rate limited');
    });

    it('classifies 404 model not found errors', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error('404 Not Found: model not found')
      );

      const result = await runVercelClient(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.error).toBeTruthy();
      // Raw provider error is preserved, not collapsed to a misleading guess.
      expect(result.error).toContain('404 Not Found: model not found');
      // Hint points at the real causes (model id / base-URL override).
      expect(result.error).toContain('ANTHROPIC_BASE_URL');
    });
  });

  describe('how a failed run ended (ADR 0010)', () => {
    const statusError = (statusCode: number, message: string) =>
      Object.assign(new Error(message), { statusCode });
    const infra = (broke: string, retryable = true) => ({
      kind: 'infrastructure',
      broke,
      retryable,
    });

    it.each([
      ['an error of its own', new Error('API error'), { kind: 'trial' }],
      [
        'a missing provider package',
        new Error("Cannot find module '@ai-sdk/openai'"),
        infra('setup', false),
      ],
      [
        'a key the provider rejects',
        new Error('401 Unauthorized: Invalid API key'),
        infra('setup', false),
      ],
      [
        'a model the provider does not serve',
        new Error('404 Not Found: model not found'),
        infra('setup', false),
      ],
      ['a rate limit', new Error('429 Too Many Requests'), infra('provider')],
      [
        'a server error',
        statusError(500, 'Internal server error'),
        infra('provider'),
      ],
      [
        'an overloaded stream',
        { type: 'overloaded_error', message: 'Overloaded' },
        infra('provider'),
      ],
      ['a failed connection', new Error('fetch failed'), infra('network')],
      // A status is the provider's answer; the words in its message aren't.
      [
        'a bad request that quotes an API key',
        statusError(400, 'Invalid tool schema; the API key field is unused'),
        { kind: 'trial' },
      ],
      [
        'a server error that quotes a 429',
        statusError(502, 'Upstream returned 429 and ECONNRESET'),
        infra('provider'),
      ],
      [
        'a forbidden key by status alone',
        statusError(403, 'Forbidden'),
        infra('setup', false),
      ],
      // The AI SDK retries these, then throws a RetryError around the last.
      [
        'an overload the SDK gave up retrying',
        Object.assign(
          new Error('Failed after 3 attempts. Last error: Overloaded'),
          {
            name: 'AI_RetryError',
            reason: 'maxRetriesExceeded',
            lastError: statusError(529, 'Overloaded'),
          }
        ),
        infra('provider'),
      ],
      [
        'a server error the SDK gave up retrying',
        Object.assign(
          new Error('Failed after 3 attempts. Last error: Internal error'),
          {
            name: 'AI_RetryError',
            reason: 'maxRetriesExceeded',
            lastError: statusError(500, 'Internal error'),
          }
        ),
        infra('provider'),
      ],
      [
        'a prompt too long for the context',
        statusError(400, 'prompt is too long: 210000 tokens > 200000 maximum'),
        infra('setup', false),
      ],
      [
        "OpenAI's context code in the response body",
        Object.assign(statusError(400, 'Bad request'), {
          responseBody: '{"error":{"code":"context_length_exceeded"}}',
        }),
        infra('setup', false),
      ],
    ])('types %s', async (_, error, expected) => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(error);
      const result = await runVercelClient(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect(result.error).toBeTruthy();
      expect(result.ending).toMatchObject(expected);
    });

    it('is a trial when the context fills after the model answered', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockImplementationOnce((async (options: {
        onStepFinish?: () => void;
      }) => {
        // The first request answered; the next one no longer fit.
        options.onStepFinish?.();
        throw statusError(
          400,
          'prompt is too long: 210000 tokens > 200000 maximum'
        );
      }) as never);
      const result = await runVercelClient(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect(result.error).toContain('prompt is too long');
      expect(result.ending).toEqual({ kind: 'trial' });
    });
  });
});

describe('stepModelCalls', () => {
  const at = (seconds: number) => Date.UTC(2026, 9, 22, 12, 0, seconds);
  const iso = (seconds: number) => new Date(at(seconds)).toISOString();

  it("reads each step's request: its usage, and its time until its first tool call", () => {
    const calls = stepModelCalls(
      [
        {
          usage: {
            inputTokens: 100,
            outputTokens: 8,
            inputTokenDetails: { cacheReadTokens: 40 },
          },
          finishReason: 'tool-calls',
          response: { id: 'resp-1', modelId: 'model-x' },
          text: '',
          toolCalls: [{ toolCallId: 'call-1' }, { toolCallId: 'call-2' }],
        },
        {
          usage: { inputTokens: 130, outputTokens: 3 },
          finishReason: 'stop',
          response: { id: 'resp-2', modelId: 'model-x' },
          text: 'Done.',
          toolCalls: [],
        },
      ] as unknown as Parameters<typeof stepModelCalls>[0],
      at(0),
      [at(5), at(8)],
      [at(3), at(2)]
    );
    expect(calls).toEqual([
      {
        id: 'resp-1',
        model: 'model-x',
        startedAt: iso(0),
        completedAt: iso(2),
        durationMs: 2_000,
        inputTokens: 100,
        outputTokens: 8,
        cacheReadInputTokens: 40,
        finishReason: 'tool-calls',
        toolCallIds: ['call-1', 'call-2'],
      },
      {
        id: 'resp-2',
        model: 'model-x',
        startedAt: iso(5),
        completedAt: iso(8),
        durationMs: 3_000,
        inputTokens: 130,
        outputTokens: 3,
        finishReason: 'stop',
        text: 'Done.',
      },
    ]);
  });
});
