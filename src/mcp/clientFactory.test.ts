import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };

// Use vi.hoisted to define mocks that can be used in vi.mock factories
const mocks = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockClose: vi.fn(),
  mockGetServerVersion: vi.fn(),
  MockClient: vi.fn(),
  MockStdioClientTransport: vi.fn(),
  MockStreamableHTTPClientTransport: vi.fn(),
  MockSSEClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.MockStdioClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.MockStreamableHTTPClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.MockSSEClientTransport,
}));

import { createMCPClientForConfig, closeMCPClient } from './clientFactory.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

describe('clientFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up mock implementations
    mocks.mockConnect.mockResolvedValue(undefined);
    mocks.mockClose.mockResolvedValue(undefined);
    mocks.mockGetServerVersion.mockReturnValue({
      name: 'test-server',
      version: '1.0.0',
    });
    mocks.MockClient.mockImplementation(function () {
      return {
        connect: mocks.mockConnect,
        close: mocks.mockClose,
        getServerVersion: mocks.mockGetServerVersion,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMCPClientForConfig', () => {
    describe('stdio transport', () => {
      it('creates client with stdio transport', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          args: ['server.js'],
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockClient).toHaveBeenCalledWith(
          {
            name: '@gleanwork/mcp-server-tester',
            version: packageJson.version,
          },
          {
            capabilities: {},
          }
        );
        expect(mocks.MockStdioClientTransport).toHaveBeenCalledWith({
          command: 'node',
          args: ['server.js'],
        });
        expect(mocks.mockConnect).toHaveBeenCalled();
      });

      it('creates client with cwd option', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          args: ['server.js'],
          cwd: '/path/to/server',
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStdioClientTransport).toHaveBeenCalledWith({
          command: 'node',
          args: ['server.js'],
          cwd: '/path/to/server',
        });
      });

      it('creates client with quiet mode', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          args: ['server.js'],
          quiet: true,
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStdioClientTransport).toHaveBeenCalledWith({
          command: 'node',
          args: ['server.js'],
          stderr: 'ignore',
        });
      });

      it('creates client with empty args array when not provided', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStdioClientTransport).toHaveBeenCalledWith({
          command: 'node',
          args: [],
        });
      });

      it('passes connectTimeoutMs as timeout to client.connect for stdio', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          connectTimeoutMs: 5000,
        };

        await createMCPClientForConfig(config);

        expect(mocks.mockConnect).toHaveBeenCalledWith(expect.anything(), {
          timeout: 5000,
        });
      });

      it('omits connect timeout options when connectTimeoutMs is not set', async () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
        };

        await createMCPClientForConfig(config);

        expect(mocks.mockConnect).toHaveBeenCalledWith(
          expect.anything(),
          undefined
        );
      });
    });

    describe('http transport', () => {
      it('falls back to SSE when StreamableHTTP connect fails', async () => {
        // First connect (StreamableHTTP) fails, second (SSE) succeeds
        mocks.mockConnect
          .mockRejectedValueOnce(new Error('Streamable HTTP not supported'))
          .mockResolvedValueOnce(undefined);

        const config = {
          transport: 'http' as const,
          serverUrl: 'http://localhost:3000/mcp',
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStreamableHTTPClientTransport).toHaveBeenCalled();
        expect(mocks.MockSSEClientTransport).toHaveBeenCalled();
        expect(mocks.mockConnect).toHaveBeenCalledTimes(2);
      });

      it('passes authProvider to SSE transport fallback', async () => {
        mocks.MockStreamableHTTPClientTransport.mockImplementationOnce(() => {
          throw new Error('Not supported');
        });
        const mockAuthProvider = {} as OAuthClientProvider;
        await createMCPClientForConfig(
          { transport: 'http', serverUrl: 'https://example.com/mcp' },
          { authProvider: mockAuthProvider }
        );
        expect(mocks.MockSSEClientTransport).toHaveBeenCalledWith(
          expect.any(URL),
          expect.objectContaining({ authProvider: mockAuthProvider })
        );
      });

      it('does not fall back to SSE when StreamableHTTP succeeds', async () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'http://localhost:3000/mcp',
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStreamableHTTPClientTransport).toHaveBeenCalled();
        expect(mocks.MockSSEClientTransport).not.toHaveBeenCalled();
        expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
      });

      it('creates client with http transport', async () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'http://localhost:3000/mcp',
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockClient).toHaveBeenCalled();
        expect(mocks.MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
          new URL('http://localhost:3000/mcp'),
          {
            requestInit: {
              headers: {
                'User-Agent': `@gleanwork/mcp-server-tester/${packageJson.version}`,
              },
            },
          }
        );
        expect(mocks.mockConnect).toHaveBeenCalled();
      });

      it('creates client with http headers', async () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'http://localhost:3000/mcp',
          headers: {
            Authorization: 'Bearer token123',
            'X-Custom-Header': 'value',
          },
        };

        await createMCPClientForConfig(config);

        expect(mocks.MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
          new URL('http://localhost:3000/mcp'),
          {
            requestInit: {
              headers: {
                'User-Agent': `@gleanwork/mcp-server-tester/${packageJson.version}`,
                Authorization: 'Bearer token123',
                'X-Custom-Header': 'value',
              },
            },
          }
        );
      });
    });

    describe('client info', () => {
      it('uses default client info when not provided', async () => {
        await createMCPClientForConfig({
          transport: 'stdio' as const,
          command: 'node',
        });

        expect(mocks.MockClient).toHaveBeenCalledWith(
          {
            name: '@gleanwork/mcp-server-tester',
            version: packageJson.version,
          },
          expect.anything()
        );
      });

      it('uses custom client info when provided', async () => {
        await createMCPClientForConfig(
          {
            transport: 'stdio' as const,
            command: 'node',
          },
          {
            clientInfo: {
              name: 'my-custom-client',
              version: '2.0.0',
            },
          }
        );

        expect(mocks.MockClient).toHaveBeenCalledWith(
          {
            name: 'my-custom-client',
            version: '2.0.0',
          },
          expect.anything()
        );
      });

      it('uses partial custom client info', async () => {
        await createMCPClientForConfig(
          {
            transport: 'stdio' as const,
            command: 'node',
          },
          {
            clientInfo: {
              name: 'my-custom-client',
            },
          }
        );

        expect(mocks.MockClient).toHaveBeenCalledWith(
          {
            name: 'my-custom-client',
            version: packageJson.version,
          },
          expect.anything()
        );
      });
    });

    describe('capabilities', () => {
      it('passes capabilities to client', async () => {
        await createMCPClientForConfig({
          transport: 'stdio' as const,
          command: 'node',
          capabilities: {
            roots: { listChanged: true },
          },
        });

        expect(mocks.MockClient).toHaveBeenCalledWith(expect.anything(), {
          capabilities: {
            roots: { listChanged: true },
          },
        });
      });
    });

    describe('validation errors', () => {
      it('throws on invalid stdio config (missing command)', async () => {
        const config = {
          transport: 'stdio' as const,
        };

        await expect(
          createMCPClientForConfig(
            config as Parameters<typeof createMCPClientForConfig>[0]
          )
        ).rejects.toThrow();
      });

      it('throws on invalid http config (missing serverUrl)', async () => {
        const config = {
          transport: 'http' as const,
        };

        await expect(
          createMCPClientForConfig(
            config as Parameters<typeof createMCPClientForConfig>[0]
          )
        ).rejects.toThrow();
      });

      it('throws on invalid http config (invalid URL)', async () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'not-a-valid-url',
        };

        await expect(createMCPClientForConfig(config)).rejects.toThrow();
      });
    });
  });

  describe('closeMCPClient', () => {
    it('closes client successfully', async () => {
      const mockClient = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      await closeMCPClient(
        mockClient as unknown as Parameters<typeof closeMCPClient>[0]
      );

      expect(mockClient.close).toHaveBeenCalled();
    });

    it('throws error when close fails', async () => {
      const closeError = new Error('Close failed');
      const mockClient = {
        close: vi.fn().mockRejectedValue(closeError),
      };

      await expect(
        closeMCPClient(
          mockClient as unknown as Parameters<typeof closeMCPClient>[0]
        )
      ).rejects.toThrow('Close failed');
    });
  });
});
