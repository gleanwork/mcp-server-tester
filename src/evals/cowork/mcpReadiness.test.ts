import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoworkMcpReadinessError,
  verifyCoworkMcpServers,
} from './mcpReadiness.js';
import { MCPHttpConnectionError } from '../../mcp/connectionDiagnostics.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../mcp/clientFactory.js';

vi.mock('../../mcp/clientFactory.js', () => ({
  closeMCPClient: vi.fn(),
  createMCPClientForConfig: vi.fn(),
}));

describe('Cowork MCP preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeMCPClient).mockResolvedValue(undefined);
  });

  it('fails closed on connection failure even when native readiness is claimed', async () => {
    vi.mocked(createMCPClientForConfig).mockRejectedValue(
      new Error('fetch failed')
    );
    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'http',
            label: 'glean',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
          },
        ],
        { MST_COWORK_NATIVE_MCP_READY: '1', TOKEN: 'test-token' }
      )
    ).rejects.toMatchObject({
      name: 'CoworkMcpReadinessError',
      servers: [{ label: 'glean', status: 'failed', error: 'network_error' }],
    });
    expect(createMCPClientForConfig).toHaveBeenCalledOnce();
  });

  it('connects and lists tools for every configured server', async () => {
    vi.mocked(createMCPClientForConfig).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'search' }] }),
    } as never);

    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'http',
            label: 'glean',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
            headers: { 'X-Custom-Header': 'custom-value' },
          },
        ],
        { TOKEN: 'secret' }
      )
    ).resolves.toMatchObject([
      { label: 'glean', status: 'connected', toolCount: 1 },
    ]);
    expect(createMCPClientForConfig).toHaveBeenCalledWith({
      transport: 'http',
      label: 'glean',
      serverUrl: 'https://example.test/mcp',
      auth: undefined,
      headers: {
        Authorization: 'Bearer secret',
        'X-Custom-Header': 'custom-value',
      },
    });
    expect(closeMCPClient).toHaveBeenCalledOnce();
  });

  it('fails closed and closes a client after listTools fails', async () => {
    const client = {
      listTools: vi
        .fn()
        .mockRejectedValue(new Error('Authorization token=secret')),
    };
    vi.mocked(createMCPClientForConfig).mockResolvedValue(client as never);

    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'http',
            label: 'glean',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
          },
        ],
        { TOKEN: 'secret' }
      )
    ).rejects.toMatchObject({
      name: 'CoworkMcpReadinessError',
      servers: [
        { label: 'glean', status: 'failed', error: 'connection_failed' },
      ],
    });
    expect(closeMCPClient).toHaveBeenCalledWith(client);
  });

  it.each([undefined, '', 'token\r\nInjected: value'])(
    'rejects missing or invalid tokens with the native flag set (%s)',
    async (token) => {
      await expect(
        verifyCoworkMcpServers(
          [
            {
              transport: 'http',
              label: 'glean',
              serverUrl: 'https://example.test/mcp',
              auth: { accessTokenEnv: 'TOKEN' },
            },
          ],
          { MST_COWORK_NATIVE_MCP_READY: '1', TOKEN: token }
        )
      ).rejects.toBeInstanceOf(CoworkMcpReadinessError);
      expect(createMCPClientForConfig).not.toHaveBeenCalled();
    }
  );

  it('reports both transport classifications without request or credential content', async () => {
    const secret = 'sensitive-bearer-value';
    vi.mocked(createMCPClientForConfig).mockRejectedValue(
      new MCPHttpConnectionError(
        new Error(
          `HTTP 403 POST https://example.test/mcp?key=${secret} Authorization: Bearer ${secret} request-body`
        ),
        Object.assign(new Error(`SSE unauthorized ${secret}`), { code: 401 }),
        false,
        null
      )
    );
    const error = await verifyCoworkMcpServers(
      [
        {
          transport: 'http',
          label: 'glean',
          serverUrl: 'https://example.test/mcp',
        },
      ],
      {}
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      servers: [
        {
          status: 'failed',
          error: 'MCP connection failed: streamableHttp=http_403; sse=http_401',
        },
      ],
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toMatch(/request-body|https:\/\//);
  });

  it('does not copy arbitrary errors into readiness reports', async () => {
    vi.mocked(createMCPClientForConfig).mockRejectedValue(
      new Error(
        'Authorization: Bearer sensitive-value Cookie: session=private request-body'
      )
    );
    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'http',
            label: 'glean',
            serverUrl: 'https://example.test/mcp',
          },
        ],
        {}
      )
    ).rejects.toMatchObject({ servers: [{ error: 'connection_failed' }] });
  });

  it('checks servers independently', async () => {
    vi.mocked(createMCPClientForConfig)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
      } as never);

    await expect(
      verifyCoworkMcpServers(
        [
          {
            transport: 'http',
            label: 'first',
            serverUrl: 'https://first.test/mcp',
          },
          {
            transport: 'http',
            label: 'second',
            serverUrl: 'https://second.test/mcp',
          },
        ],
        {}
      )
    ).rejects.toBeInstanceOf(CoworkMcpReadinessError);
    expect(createMCPClientForConfig).toHaveBeenCalledTimes(2);
  });
});
