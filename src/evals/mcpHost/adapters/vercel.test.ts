import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVercelOrchestrator } from './vercel.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';

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
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
  tool: vi.fn(
    (config: {
      description: string;
      parameters: unknown;
      execute: (args: unknown) => Promise<string>;
    }) => config
  ),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => ({ id: 'gpt-4o' })),
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
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 20°C' }],
      isError: false,
    }),
  };
}

describe('createVercelOrchestrator', () => {
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
      usage: { promptTokens: 100, completionTokens: 50 },
    } as never);

    const { openai } = await import('@ai-sdk/openai');
    vi.mocked(openai).mockReturnValue({ id: 'gpt-4o' } as never);
  });

  it('should return a simulation result with tool calls', async () => {
    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(
      createMockMCP(),
      'What is the weather in London?',
      { provider: 'openai', model: 'gpt-4o' }
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('Final answer');
    expect(result.llmDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.mcpDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('should return success:false on error', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API error'));

    const orchestrator = createVercelOrchestrator();
    const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API error');
  });

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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'Search for docs', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'List all items', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'Run batch search', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'Get status', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'scenario', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'scenario', {
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

      const orchestrator = createVercelOrchestrator();
      await orchestrator.simulate(mcp, 'scenario', {
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

      const orchestrator = createVercelOrchestrator();
      const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('authentication error');
    });

    it('classifies rate limit errors with a helpful hint', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error('429 Too Many Requests')
      );

      const orchestrator = createVercelOrchestrator();
      const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limited');
    });

    it('classifies 404 model not found errors', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockRejectedValueOnce(
        new Error('404 Not Found: model not found')
      );

      const orchestrator = createVercelOrchestrator();
      const result = await orchestrator.simulate(createMockMCP(), 'scenario', {
        provider: 'openai',
        model: 'gpt-4o',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('model not found');
    });
  });
});
