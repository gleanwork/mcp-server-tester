import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvalDataset, type EvalContext } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { Tool } from '@modelcontextprotocol/client';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';

const mocks = vi.hoisted(() => ({
  simulateMstClient: vi.fn(),
}));

vi.mock('./mstClient/simulation.js', () => ({
  simulateMstClient: mocks.simulateMstClient,
}));

function createMockMCP(tools: Tool[]): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  };
}

function createContext(mcp: MCPFixtureApi): EvalContext {
  return {
    mcp,
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

function createClientDataset(): EvalDataset {
  return {
    name: 'tool-override-test',
    cases: [
      {
        id: 'search-discovery',
        input: 'Find the expense policy',
        assertions: {
          toolsTriggered: {
            calls: [{ name: 'search', required: true }],
          },
        },
      },
    ],
  };
}

describe('runEvalDataset toolOverrides', () => {
  beforeEach(() => {
    mocks.simulateMstClient.mockReset();
  });

  it('exposes overridden tool metadata to client runs and preserves untouched tools', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Old search description',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
      {
        name: 'read_document',
        description: 'Read a document',
        inputSchema: { type: 'object' },
      },
    ]);

    let observedTools: Tool[] = [];
    mocks.simulateMstClient.mockImplementation(
      async (clientMcp: MCPFixtureApi) => {
        observedTools = await clientMcp.listTools();
        return {
          success: true,
          toolCalls: [{ name: 'search', arguments: { query: 'expense' } }],
          response: 'Done',
        };
      }
    );

    const dataset = createClientDataset();
    const result = await runEvalDataset(
      {
        dataset,
        toolOverrides: {
          id: 'search-description-v2',
          tools: {
            search: {
              description: 'Search internal company documents and policies.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Natural language document query.',
                  },
                },
                required: ['query'],
              },
            },
          },
        },
      },
      createContext(mcp)
    );

    expect(result.failed).toBe(0);
    expect(result.metadata?.toolVariantId).toBe('search-description-v2');
    expect(result.caseResults[0]?.request?.toolVariantId).toBe(
      'search-description-v2'
    );
    expect(observedTools).toMatchObject([
      {
        name: 'search',
        description: 'Search internal company documents and policies.',
        inputSchema: {
          properties: {
            query: {
              description: 'Natural language document query.',
            },
          },
        },
      },
      {
        name: 'read_document',
        description: 'Read a document',
      },
    ]);
    expect(dataset.cases[0]?.assertions?.toolsTriggered?.calls[0]?.name).toBe(
      'search'
    );
  });

  it('forwards canonical tool calls to the underlying MCP fixture', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);

    mocks.simulateMstClient.mockImplementation(
      async (clientMcp: MCPFixtureApi) => {
        await clientMcp.callTool('search', { query: 'expense policy' });
        return {
          success: true,
          toolCalls: [
            { name: 'search', arguments: { query: 'expense policy' } },
          ],
          response: 'Done',
        };
      }
    );

    await runEvalDataset(
      {
        dataset: createClientDataset(),
        toolOverrides: {
          id: 'search-schema-v2',
          tools: {
            search: {
              description: 'Search internal documents.',
            },
          },
        },
      },
      createContext(mcp)
    );

    expect(mcp.callTool).toHaveBeenCalledWith('search', {
      query: 'expense policy',
    });
  });

  it('fails clearly when an override references an unknown tool', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);

    mocks.simulateMstClient.mockImplementation(
      async (clientMcp: MCPFixtureApi) => {
        await clientMcp.listTools();
        return { success: true, toolCalls: [], response: 'Done' };
      }
    );

    const result = await runEvalDataset(
      {
        dataset: createClientDataset(),
        toolOverrides: {
          id: 'bad-variant',
          tools: {
            missing_tool: {
              description: 'This tool does not exist.',
            },
          },
        },
      },
      createContext(mcp)
    );

    expect(result.failed).toBe(1);
    expect(result.caseResults[0]?.error).toContain(
      'toolOverrides variant "bad-variant" overrides unknown tool "missing_tool".'
    );
  });
});

describe('runEvalDataset toolOverrides renames', () => {
  beforeEach(() => {
    mocks.simulateMstClient.mockReset();
  });

  it('shows the client the new name and records calls under the original', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);
    let observed: string[] = [];
    mocks.simulateMstClient.mockImplementation(
      async (clientMcp: MCPFixtureApi) => {
        observed = (await clientMcp.listTools()).map((tool) => tool.name);
        await clientMcp.callTool('find_documents', { query: 'expense' });
        return {
          success: true,
          toolCalls: [
            { name: 'find_documents', arguments: { query: 'expense' } },
          ],
          response: 'Done',
        };
      }
    );
    // The dataset expects the original name: variants compare like for like.
    const dataset = createClientDataset();

    const result = await runEvalDataset(
      {
        dataset,
        toolOverrides: {
          id: 'renamed',
          tools: { search: { name: 'find_documents' } },
        },
      },
      createContext(mcp)
    );

    expect(observed).toEqual(['find_documents']);
    expect(mcp.callTool).toHaveBeenCalledWith('search', { query: 'expense' });
    expect(result.failed).toBe(0);
    expect(result.caseResults[0]?.trace?.events).toMatchObject([
      { kind: 'tool_call', name: 'search', rawName: 'find_documents' },
    ]);
  });
});
