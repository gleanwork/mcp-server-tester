import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvalDataset, type EvalContext } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const mocks = vi.hoisted(() => ({
  simulateMCPHost: vi.fn(),
}));

vi.mock('./mcpHost/mcpHostSimulation.js', () => ({
  simulateMCPHost: mocks.simulateMCPHost,
}));

function createMockMCP(tools: Tool[]): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
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

function createHostDataset(): EvalDataset {
  return {
    name: 'tool-override-test',
    cases: [
      {
        id: 'search-discovery',
        mode: 'mcp_host',
        scenario: 'Find the expense policy',
        mcpHostConfig: { provider: 'openai', model: 'gpt-4o' },
        expect: {
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
    mocks.simulateMCPHost.mockReset();
  });

  it('exposes overridden tool metadata to mcp_host runs and preserves untouched tools', async () => {
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
    mocks.simulateMCPHost.mockImplementation(async (hostMcp: MCPFixtureApi) => {
      observedTools = await hostMcp.listTools();
      return {
        success: true,
        toolCalls: [{ name: 'search', arguments: { query: 'expense' } }],
        response: 'Done',
      };
    });

    const dataset = createHostDataset();
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
    expect(result.metadata?.toolOverrideVariantId).toBe(
      'search-description-v2'
    );
    expect(result.caseResults[0]?.request?.toolOverrideVariantId).toBe(
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
    expect(dataset.cases[0]?.expect?.toolsTriggered?.calls[0]?.name).toBe(
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

    mocks.simulateMCPHost.mockImplementation(async (hostMcp: MCPFixtureApi) => {
      await hostMcp.callTool('search', { query: 'expense policy' });
      return {
        success: true,
        toolCalls: [{ name: 'search', arguments: { query: 'expense policy' } }],
        response: 'Done',
      };
    });

    await runEvalDataset(
      {
        dataset: createHostDataset(),
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

    mocks.simulateMCPHost.mockImplementation(async (hostMcp: MCPFixtureApi) => {
      await hostMcp.listTools();
      return { success: true, toolCalls: [], response: 'Done' };
    });

    const result = await runEvalDataset(
      {
        dataset: createHostDataset(),
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
      'toolOverrides variant "bad-variant" references unknown tool(s): missing_tool'
    );
  });

  it('keeps direct mode calls working when toolOverrides are present', async () => {
    const mcp = createMockMCP([
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      },
    ]);
    const dataset: EvalDataset = {
      name: 'direct-override-test',
      cases: [
        { id: 'direct-search', toolName: 'search', args: { query: 'x' } },
      ],
    };

    const result = await runEvalDataset(
      {
        dataset,
        toolOverrides: {
          id: 'search-description-v2',
          tools: {
            search: {
              description: 'Search internal documents.',
            },
          },
        },
      },
      createContext(mcp)
    );

    expect(result.failed).toBe(0);
    expect(mcp.callTool).toHaveBeenCalledWith('search', { query: 'x' });
    expect(mcp.listTools).not.toHaveBeenCalled();
    expect(result.caseResults[0]?.request?.toolOverrideVariantId).toBe(
      'search-description-v2'
    );
  });
});
