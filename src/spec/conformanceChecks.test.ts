import { describe, it, expect, vi } from 'vitest';
import { runConformanceChecks } from './conformanceChecks.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { Client } from '@modelcontextprotocol/client';
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client';
import type { Tool, ServerCapabilities } from '@modelcontextprotocol/client';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';

function createMockTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };
}

function createMockMCP(options: {
  serverInfo?: { name: string; version: string } | null;
  capabilities?: ServerCapabilities;
  tools?: Tool[];
  listToolsError?: Error;
  callToolError?: boolean;
  callToolThrows?: Error;
  resources?: Array<{ uri: string; name: string }>;
  prompts?: Array<{ name: string }>;
  listResourcesError?: Error;
  listPromptsError?: Error;
}): MCPFixtureApi {
  const mockClient = {
    getServerCapabilities: vi.fn().mockReturnValue(options.capabilities),
    listResources: options.listResourcesError
      ? vi.fn().mockRejectedValue(options.listResourcesError)
      : vi.fn().mockResolvedValue({ resources: options.resources ?? [] }),
    listPrompts: options.listPromptsError
      ? vi.fn().mockRejectedValue(options.listPromptsError)
      : vi.fn().mockResolvedValue({ prompts: options.prompts ?? [] }),
  } as unknown as Client;

  return {
    client: mockClient,
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions(mockClient),
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue(options.serverInfo ?? null),
    listTools: options.listToolsError
      ? vi.fn().mockRejectedValue(options.listToolsError)
      : vi.fn().mockResolvedValue(options.tools ?? []),
    callTool: options.callToolThrows
      ? vi.fn().mockRejectedValue(options.callToolThrows)
      : vi.fn().mockResolvedValue({
          isError: options.callToolError ?? true,
          content: [{ type: 'text', text: 'Error: Tool not found' }],
        }),
  };
}

describe('runConformanceChecks', () => {
  describe('basic checks', () => {
    it('should pass when server info is present', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [createMockTool('test-tool')],
      });

      const result = await runConformanceChecks(mcp);

      expect(result.pass).toBe(true);
      const serverCheck = result.checks.find(
        (c) => c.name === 'server_info_present'
      );
      expect(serverCheck?.pass).toBe(true);
      expect(serverCheck?.message).toContain('test-server');
    });

    it('should fail when server info is missing', async () => {
      const mcp = createMockMCP({
        serverInfo: null,
        capabilities: { tools: {} },
        tools: [createMockTool('test-tool')],
      });

      const result = await runConformanceChecks(mcp);

      const serverCheck = result.checks.find(
        (c) => c.name === 'server_info_present'
      );
      expect(serverCheck?.pass).toBe(false);
      expect(serverCheck?.message).toBe('Server info is missing');
    });

    it('should skip server info check when disabled', async () => {
      const mcp = createMockMCP({
        serverInfo: null,
        capabilities: { tools: {} },
        tools: [createMockTool('test-tool')],
      });

      const result = await runConformanceChecks(mcp, {
        checkServerInfo: false,
      });

      const serverCheck = result.checks.find(
        (c) => c.name === 'server_info_present'
      );
      expect(serverCheck).toBeUndefined();
    });
  });

  describe('capabilities check', () => {
    it('should pass when capabilities are present', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      const capCheck = result.checks.find(
        (c) => c.name === 'capabilities_valid'
      );
      expect(capCheck?.pass).toBe(true);
      expect(capCheck?.message).toContain('tools');
      expect(capCheck?.message).toContain('resources');
      expect(capCheck?.message).toContain('prompts');
    });

    it('should fail when capabilities are undefined', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: undefined,
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      const capCheck = result.checks.find(
        (c) => c.name === 'capabilities_valid'
      );
      expect(capCheck?.pass).toBe(false);
    });
  });

  describe('tool checks', () => {
    it('should pass when listTools succeeds', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [createMockTool('tool1'), createMockTool('tool2')],
      });

      const result = await runConformanceChecks(mcp);

      const toolsCheck = result.checks.find(
        (c) => c.name === 'list_tools_succeeds'
      );
      expect(toolsCheck?.pass).toBe(true);
      expect(toolsCheck?.message).toContain('2 tools');
    });

    it('should fail when listTools throws', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        listToolsError: new Error('Connection failed'),
      });

      const result = await runConformanceChecks(mcp);

      expect(result.pass).toBe(false);
      const toolsCheck = result.checks.find(
        (c) => c.name === 'list_tools_succeeds'
      );
      expect(toolsCheck?.pass).toBe(false);
      expect(toolsCheck?.message).toContain('Connection failed');
    });

    it('should check required tools', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [createMockTool('tool1'), createMockTool('tool2')],
      });

      const result = await runConformanceChecks(mcp, {
        requiredTools: ['tool1', 'tool3'],
      });

      const reqCheck = result.checks.find(
        (c) => c.name === 'required_tools_present'
      );
      expect(reqCheck?.pass).toBe(false);
      expect(reqCheck?.message).toContain('tool3');
    });

    it('should validate tool schemas', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [
          createMockTool('valid-tool'),
          {
            name: 'invalid-tool',
            inputSchema: { type: 'string' } as unknown as Tool['inputSchema'],
          },
        ],
      });

      const result = await runConformanceChecks(mcp, { validateSchemas: true });

      const schemaCheck = result.checks.find(
        (c) => c.name === 'tool_schemas_valid'
      );
      expect(schemaCheck?.pass).toBe(false);
      expect(schemaCheck?.message).toContain('invalid-tool');
      expect(schemaCheck?.message).toContain('must be "object"');
    });

    it('checks that output schemas compile', async () => {
      const mcp = createMockMCP({
        capabilities: { tools: {} },
        tools: [
          {
            ...createMockTool('typed'),
            outputSchema: {
              type: 'object',
              properties: { count: { type: 'number' } },
            },
          },
          {
            ...createMockTool('broken'),
            outputSchema: {
              type: 'object',
              properties: { id: { type: 'string', pattern: '([' } },
            },
          },
        ],
      });

      const result = await runConformanceChecks(mcp);

      const schemaCheck = result.checks.find(
        (c) => c.name === 'tool_schemas_valid'
      );
      expect(schemaCheck?.pass).toBe(false);
      expect(schemaCheck?.message).toContain(
        'broken: outputSchema does not compile'
      );
      expect(schemaCheck?.message).not.toContain('typed:');
    });
  });

  describe('capability-aware resource checks', () => {
    it('should check resources when capability is declared', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, resources: {} },
        tools: [],
        resources: [{ uri: 'file://test.txt', name: 'test.txt' }],
      });

      const result = await runConformanceChecks(mcp);

      const resourceCheck = result.checks.find(
        (c) => c.name === 'list_resources_succeeds'
      );
      expect(resourceCheck).toBeDefined();
      expect(resourceCheck?.pass).toBe(true);
      expect(result.raw.resources).toHaveLength(1);
    });

    it('should skip resources check when capability not declared', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      const resourceCheck = result.checks.find(
        (c) => c.name === 'list_resources_succeeds'
      );
      expect(resourceCheck).toBeUndefined();
      expect(result.raw.resources).toBeNull();
    });

    it('should fail when listResources throws', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, resources: {} },
        tools: [],
        listResourcesError: new Error('Resource error'),
      });

      const result = await runConformanceChecks(mcp);

      const resourceCheck = result.checks.find(
        (c) => c.name === 'list_resources_succeeds'
      );
      expect(resourceCheck?.pass).toBe(false);
      expect(resourceCheck?.message).toContain('Resource error');
    });

    it('should skip resources check when disabled', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, resources: {} },
        tools: [],
        resources: [{ uri: 'file://test.txt', name: 'test.txt' }],
      });

      const result = await runConformanceChecks(mcp, { checkResources: false });

      const resourceCheck = result.checks.find(
        (c) => c.name === 'list_resources_succeeds'
      );
      expect(resourceCheck).toBeUndefined();
    });
  });

  describe('capability-aware prompt checks', () => {
    it('should check prompts when capability is declared', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, prompts: {} },
        tools: [],
        prompts: [{ name: 'greeting' }],
      });

      const result = await runConformanceChecks(mcp);

      const promptCheck = result.checks.find(
        (c) => c.name === 'list_prompts_succeeds'
      );
      expect(promptCheck).toBeDefined();
      expect(promptCheck?.pass).toBe(true);
      expect(result.raw.prompts).toHaveLength(1);
    });

    it('should skip prompts check when capability not declared', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      const promptCheck = result.checks.find(
        (c) => c.name === 'list_prompts_succeeds'
      );
      expect(promptCheck).toBeUndefined();
      expect(result.raw.prompts).toBeNull();
    });

    it('should fail when listPrompts throws', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {}, prompts: {} },
        tools: [],
        listPromptsError: new Error('Prompt error'),
      });

      const result = await runConformanceChecks(mcp);

      const promptCheck = result.checks.find(
        (c) => c.name === 'list_prompts_succeeds'
      );
      expect(promptCheck?.pass).toBe(false);
      expect(promptCheck?.message).toContain('Prompt error');
    });
  });

  describe('error handling check', () => {
    it('should pass when invalid tool returns error', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [],
        callToolError: true,
      });

      const result = await runConformanceChecks(mcp);

      const errorCheck = result.checks.find(
        (c) => c.name === 'invalid_tool_returns_error'
      );
      expect(errorCheck?.pass).toBe(true);
    });

    it('passes when the invalid tool call throws a protocol error', async () => {
      const mcp = createMockMCP({
        capabilities: { tools: {} },
        callToolThrows: new ProtocolError(-32602, 'Unknown tool'),
      });

      const result = await runConformanceChecks(mcp);

      expect(
        result.checks.find((c) => c.name === 'invalid_tool_returns_error')?.pass
      ).toBe(true);
    });

    it('fails when the invalid tool call fails locally (e.g. a timeout)', async () => {
      const mcp = createMockMCP({
        capabilities: { tools: {} },
        callToolThrows: new SdkError(SdkErrorCode.RequestTimeout, 'timed out'),
      });

      const result = await runConformanceChecks(mcp);

      const check = result.checks.find(
        (c) => c.name === 'invalid_tool_returns_error'
      );
      expect(check?.pass).toBe(false);
      expect(check?.message).toContain('failed locally');
    });

    it('should fail when invalid tool does not return error', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: [],
        callToolError: false,
      });

      const result = await runConformanceChecks(mcp);

      const errorCheck = result.checks.find(
        (c) => c.name === 'invalid_tool_returns_error'
      );
      expect(errorCheck?.pass).toBe(false);
    });
  });

  describe('raw responses', () => {
    it('should return raw server info', async () => {
      const mcp = createMockMCP({
        serverInfo: { name: 'my-server', version: '2.0.0' },
        capabilities: { tools: {} },
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      expect(result.raw.serverInfo).toEqual({
        name: 'my-server',
        version: '2.0.0',
      });
    });

    it('should return raw capabilities', async () => {
      const capabilities: ServerCapabilities = {
        tools: {},
        resources: {},
        logging: {},
      };
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities,
        tools: [],
      });

      const result = await runConformanceChecks(mcp);

      expect(result.raw.capabilities).toEqual(capabilities);
    });

    it('should return raw tools', async () => {
      const tools = [createMockTool('tool1'), createMockTool('tool2')];
      const mcp = createMockMCP({
        serverInfo: { name: 'test-server', version: '1.0.0' },
        capabilities: { tools: {} },
        tools,
      });

      const result = await runConformanceChecks(mcp);

      expect(result.raw.tools).toHaveLength(2);
      expect(result.raw.tools[0]!.name).toBe('tool1');
      expect(result.raw.tools[1]!.name).toBe('tool2');
    });
  });
});
