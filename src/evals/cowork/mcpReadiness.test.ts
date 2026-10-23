import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COWORK_MCP_PREFLIGHT_RETRY_DELAYS_MS,
  CoworkMcpReadinessError,
  preflightRetryDelaysMs,
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

const httpServer = (label: string) => ({
  transport: 'http' as const,
  label,
  serverUrl: `https://${label}.example.test/mcp`,
  auth: { accessTokenEnv: 'TOKEN' },
});

describe('Cowork MCP preflight retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeMCPClient).mockResolvedValue(undefined);
  });

  it('rechecks only the servers that failed, and passes once they recover', async () => {
    const attempts: string[] = [];
    vi.mocked(createMCPClientForConfig).mockImplementation(async (config) => {
      const url = 'serverUrl' in config ? String(config.serverUrl) : '';
      attempts.push(url);
      if (url.includes('jira') && attempts.filter((a) => a === url).length < 3)
        throw new Error('fetch failed');
      return {
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 't' }] }),
      } as never;
    });
    const log = vi.fn();
    const results = await verifyCoworkMcpServers(
      [httpServer('slack'), httpServer('jira')],
      { TOKEN: 'secret' },
      { retryDelaysMs: [0, 0], log }
    );
    expect(results).toMatchObject([
      { label: 'slack', status: 'connected' },
      { label: 'jira', status: 'connected' },
    ]);
    expect(attempts.filter((a) => a.includes('slack'))).toHaveLength(1);
    expect(attempts.filter((a) => a.includes('jira'))).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toContain('jira=failed(network_error)');
    expect(log.mock.calls[0]![0]).not.toContain('slack');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('fails after the last retry, reporting every server', async () => {
    vi.mocked(createMCPClientForConfig).mockImplementation(async (config) => {
      if ('serverUrl' in config && String(config.serverUrl).includes('jira'))
        throw new Error('fetch failed');
      return {
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 't' }] }),
      } as never;
    });
    const failure = await verifyCoworkMcpServers(
      [httpServer('slack'), httpServer('jira')],
      { TOKEN: 'secret' },
      { retryDelaysMs: [0] }
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoworkMcpReadinessError);
    expect(String(failure)).toContain(
      'slack=connected(1 tools), jira=failed(network_error)'
    );
    expect(createMCPClientForConfig).toHaveBeenCalledTimes(3);
  });

  it("takes MST_COWORK_MCP_PREFLIGHT_RETRY_S from the run's env", async () => {
    vi.mocked(createMCPClientForConfig).mockRejectedValue(
      new Error('fetch failed')
    );
    await expect(
      verifyCoworkMcpServers([httpServer('jira')], {
        TOKEN: 'secret',
        MST_COWORK_MCP_PREFLIGHT_RETRY_S: '',
      })
    ).rejects.toBeInstanceOf(CoworkMcpReadinessError);
    expect(createMCPClientForConfig).toHaveBeenCalledOnce();
  });

  it('reads retry delays from MST_COWORK_MCP_PREFLIGHT_RETRY_S', () => {
    expect(preflightRetryDelaysMs(undefined)).toEqual(
      COWORK_MCP_PREFLIGHT_RETRY_DELAYS_MS
    );
    expect(preflightRetryDelaysMs('5, 20')).toEqual([5000, 20000]);
    expect(preflightRetryDelaysMs('')).toEqual([]);
    expect(() => preflightRetryDelaysMs('soon')).toThrow(
      'MST_COWORK_MCP_PREFLIGHT_RETRY_S'
    );
  });
});

describe('Cowork MCP preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeMCPClient).mockResolvedValue(undefined);
    // These cases check a single attempt.
    vi.stubEnv('MST_COWORK_MCP_PREFLIGHT_RETRY_S', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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
            label: 'acme',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
          },
        ],
        { MST_COWORK_NATIVE_MCP_READY: '1', TOKEN: 'test-token' }
      )
    ).rejects.toMatchObject({
      name: 'CoworkMcpReadinessError',
      servers: [{ label: 'acme', status: 'failed', error: 'network_error' }],
    });
    expect(createMCPClientForConfig).toHaveBeenCalledOnce();
  });

  it('fails a server that connects but lists no tools (the shared rule)', async () => {
    vi.mocked(createMCPClientForConfig).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    } as never);
    const failure = await verifyCoworkMcpServers(
      [
        {
          transport: 'http',
          label: 'acme',
          serverUrl: 'https://example.test/mcp',
          auth: { accessTokenEnv: 'TOKEN' },
        },
      ],
      { TOKEN: 'secret' }
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoworkMcpReadinessError);
    expect(String(failure)).toContain(
      'Cowork MCP preflight failed; no task was submitted. acme=connected(0 tools)'
    );
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
            label: 'acme',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
            headers: { 'X-Custom-Header': 'custom-value' },
          },
        ],
        { TOKEN: 'secret' }
      )
    ).resolves.toMatchObject([
      { label: 'acme', status: 'connected', toolCount: 1 },
    ]);
    expect(createMCPClientForConfig).toHaveBeenCalledWith({
      transport: 'http',
      label: 'acme',
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
            label: 'acme',
            serverUrl: 'https://example.test/mcp',
            auth: { accessTokenEnv: 'TOKEN' },
          },
        ],
        { TOKEN: 'secret' }
      )
    ).rejects.toMatchObject({
      name: 'CoworkMcpReadinessError',
      servers: [
        { label: 'acme', status: 'failed', error: 'connection_failed' },
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
              label: 'acme',
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
          label: 'acme',
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
            label: 'acme',
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
