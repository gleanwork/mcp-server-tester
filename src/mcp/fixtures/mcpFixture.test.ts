import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { createMCPFixture } from './mcpFixture.js';

/**
 * Unit tests for mcpFixture.ts
 *
 * Note: Tests for the "with testInfo" path that use test.step() are covered
 * by the Playwright integration tests in tests/mcp-tests.spec.ts.
 * The test.step() function from Playwright can only be called within a
 * Playwright test context, so we focus on the non-testInfo path here.
 */

// Create mock client
function createMockClient(overrides: Partial<Client> = {}): Client {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'echo', description: 'Echoes input' },
        { name: 'add', description: 'Adds two numbers' },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Result: 42' }],
      isError: false,
    }),
    getServerVersion: vi.fn().mockReturnValue({
      name: 'test-server',
      version: '1.0.0',
    }),
    ...overrides,
  } as unknown as Client;
}

describe('mcpFixture', () => {
  describe('createMCPFixture', () => {
    let mockClient: Client;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClient = createMockClient();
    });

    describe('without testInfo', () => {
      it('creates fixture with client reference', () => {
        const fixture = createMCPFixture(mockClient);
        expect(fixture.client).toBe(mockClient);
      });

      it('listTools returns tools from client', async () => {
        const fixture = createMCPFixture(mockClient);

        const tools = await fixture.listTools();

        expect(tools).toHaveLength(2);
        expect(tools[0]!.name).toBe('echo');
        expect(tools[1]!.name).toBe('add');
        expect(mockClient.listTools).toHaveBeenCalled();
      });

      it('listTools returns empty array when no tools', async () => {
        mockClient = createMockClient({
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
        });
        const fixture = createMCPFixture(mockClient);

        const tools = await fixture.listTools();

        expect(tools).toHaveLength(0);
      });

      it('callTool forwards arguments to client', async () => {
        const fixture = createMCPFixture(mockClient);

        const result = await fixture.callTool('echo', { message: 'hello' });

        expect(mockClient.callTool).toHaveBeenCalledWith({
          name: 'echo',
          arguments: { message: 'hello' },
        });
        expect(result.content).toEqual([{ type: 'text', text: 'Result: 42' }]);
        expect(result.isError).toBe(false);
      });

      it('callTool handles error responses', async () => {
        mockClient = createMockClient({
          callTool: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Error occurred' }],
            isError: true,
          }),
        });
        const fixture = createMCPFixture(mockClient);

        const result = await fixture.callTool('failing_tool', {});

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          { type: 'text', text: 'Error occurred' },
        ]);
      });

      it('callTool handles empty arguments', async () => {
        const fixture = createMCPFixture(mockClient);

        await fixture.callTool('simple_tool', {});

        expect(mockClient.callTool).toHaveBeenCalledWith({
          name: 'simple_tool',
          arguments: {},
        });
      });

      it('callTool handles complex arguments', async () => {
        const fixture = createMCPFixture(mockClient);
        const complexArgs = {
          nested: { key: 'value' },
          array: [1, 2, 3],
          flag: true,
        };

        await fixture.callTool('complex_tool', complexArgs);

        expect(mockClient.callTool).toHaveBeenCalledWith({
          name: 'complex_tool',
          arguments: complexArgs,
        });
      });

      it('getServerInfo returns server version', () => {
        const fixture = createMCPFixture(mockClient);

        const info = fixture.getServerInfo();

        expect(info).toEqual({
          name: 'test-server',
          version: '1.0.0',
        });
      });

      it('getServerInfo returns null when no server version', () => {
        mockClient = createMockClient({
          getServerVersion: vi.fn().mockReturnValue(null),
        });
        const fixture = createMCPFixture(mockClient);

        const info = fixture.getServerInfo();

        expect(info).toBeNull();
      });

      it('getServerInfo returns partial info when version has partial data', () => {
        mockClient = createMockClient({
          getServerVersion: vi.fn().mockReturnValue({
            name: 'partial-server',
          }),
        });
        const fixture = createMCPFixture(mockClient);

        const info = fixture.getServerInfo();

        expect(info).toEqual({
          name: 'partial-server',
          version: undefined,
        });
      });
    });

    describe('MCPFixtureApi interface', () => {
      it('exposes the correct interface shape', () => {
        const fixture = createMCPFixture(mockClient);

        // Type check - these should all be functions/properties
        expect(typeof fixture.client).toBe('object');
        expect(typeof fixture.listTools).toBe('function');
        expect(typeof fixture.callTool).toBe('function');
        expect(typeof fixture.getServerInfo).toBe('function');
      });

      it('callTool supports generic type parameter', async () => {
        const fixture = createMCPFixture(mockClient);

        // TypeScript should accept typed args
        type EchoArgs = {
          message: string;
        } & Record<string, unknown>;
        const result = await fixture.callTool<EchoArgs>('echo', {
          message: 'typed',
        });

        expect(result).toBeDefined();
      });

      it('multiple calls work correctly', async () => {
        const fixture = createMCPFixture(mockClient);

        await fixture.listTools();
        await fixture.callTool('echo', { message: 'first' });
        await fixture.callTool('add', { a: 1, b: 2 });
        fixture.getServerInfo();

        expect(mockClient.listTools).toHaveBeenCalledTimes(1);
        expect(mockClient.callTool).toHaveBeenCalledTimes(2);
        expect(mockClient.getServerVersion).toHaveBeenCalledTimes(1);
      });
    });

    describe('error handling', () => {
      it('listTools propagates client errors', async () => {
        mockClient = createMockClient({
          listTools: vi.fn().mockRejectedValue(new Error('Connection failed')),
        });
        const fixture = createMCPFixture(mockClient);

        await expect(fixture.listTools()).rejects.toThrow('Connection failed');
      });

      it('callTool propagates client errors', async () => {
        mockClient = createMockClient({
          callTool: vi
            .fn()
            .mockRejectedValue(new Error('Tool execution failed')),
        });
        const fixture = createMCPFixture(mockClient);

        await expect(fixture.callTool('failing', {})).rejects.toThrow(
          'Tool execution failed'
        );
      });
    });
  });
});
