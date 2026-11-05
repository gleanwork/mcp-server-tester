import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coworkReadinessServer } from './readinessServer.js';
import { checkServersReady } from '../readinessCheck.js';
import { MCPHttpConnectionError } from '../../mcp/connectionDiagnostics.js';
import { closeMCPClient, openMCPClient } from '../../mcp/clientFactory.js';
import type { MCPConfig } from '../../config/mcpConfig.js';

// The probe opens each server with `openMCPClient`.
vi.mock('../../mcp/clientFactory.js', () => ({
  closeMCPClient: vi.fn(),
  openMCPClient: vi.fn(),
}));

/** MST's readiness check, with each server resolved as Cowork launches it. */
function verify(servers: MCPConfig[], env: Record<string, string | undefined>) {
  return checkServersReady(servers, {
    resolve: (server) =>
      coworkReadinessServer(server, env, { plugins: [], paths: {} }),
    // These cases check a single attempt.
    env: { MST_MCP_READINESS_RETRY_S: '' },
  });
}

const acme = (extra: Partial<MCPConfig> = {}): MCPConfig =>
  ({
    transport: 'http',
    label: 'acme',
    serverUrl: 'https://example.test/mcp',
    auth: { accessTokenEnv: 'TOKEN' },
    ...extra,
  }) as MCPConfig;

describe('Cowork servers in the readiness check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeMCPClient).mockResolvedValue(undefined);
  });

  it('fails closed on connection failure even when native readiness is claimed', async () => {
    vi.mocked(openMCPClient).mockRejectedValue(new Error('fetch failed'));
    await expect(
      verify([acme()], {
        MST_COWORK_NATIVE_MCP_READY: '1',
        TOKEN: 'test-token',
      })
    ).resolves.toMatchObject({
      ready: false,
      servers: [{ label: 'acme', status: 'failed', error: 'network_error' }],
    });
    expect(openMCPClient).toHaveBeenCalledOnce();
  });

  it('fails a server that connects but lists no tools (the shared rule)', async () => {
    vi.mocked(openMCPClient).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    } as never);
    await expect(verify([acme()], { TOKEN: 'secret' })).resolves.toMatchObject({
      ready: false,
      reason:
        'MCP server not ready, so no trial was sent: acme listed no tools. Checked 1 time.',
    });
  });

  it('connects with Cowork headers and lists tools for every configured server', async () => {
    vi.mocked(openMCPClient).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'search' }] }),
    } as never);

    await expect(
      verify([acme({ headers: { 'X-Custom-Header': 'custom-value' } })], {
        TOKEN: 'secret',
      })
    ).resolves.toMatchObject({
      ready: true,
      servers: [{ label: 'acme', status: 'connected', toolCount: 1 }],
    });
    expect(openMCPClient).toHaveBeenCalledWith(
      {
        transport: 'http',
        label: 'acme',
        serverUrl: 'https://example.test/mcp',
        auth: undefined,
        headers: {
          Authorization: 'Bearer secret',
          'X-Custom-Header': 'custom-value',
        },
        connectTimeoutMs: 30_000,
      },
      undefined,
      expect.any(AbortSignal)
    );
    expect(closeMCPClient).toHaveBeenCalledOnce();
  });

  it('fails closed and closes a client after listTools fails', async () => {
    const client = {
      listTools: vi
        .fn()
        .mockRejectedValue(new Error('Authorization token=secret')),
    };
    vi.mocked(openMCPClient).mockResolvedValue(client as never);

    await expect(verify([acme()], { TOKEN: 'secret' })).resolves.toMatchObject({
      ready: false,
      servers: [
        // It connected; listing its tools is what failed.
        { label: 'acme', status: 'connected', error: 'connection_failed' },
      ],
    });
    expect(closeMCPClient).toHaveBeenCalledWith(client);
  });

  it.each([undefined, '', 'token\r\nInjected: value'])(
    'rejects missing or invalid tokens with the native flag set (%s)',
    async (token) => {
      await expect(
        verify([acme()], { MST_COWORK_NATIVE_MCP_READY: '1', TOKEN: token })
      ).resolves.toMatchObject({ ready: false });
      expect(openMCPClient).not.toHaveBeenCalled();
    }
  );

  it('reports both transport classifications without request or credential content', async () => {
    const secret = 'sensitive-bearer-value';
    vi.mocked(openMCPClient).mockRejectedValue(
      new MCPHttpConnectionError(
        new Error(
          `HTTP 403 POST https://example.test/mcp?key=${secret} Authorization: Bearer ${secret} request-body`
        ),
        Object.assign(new Error(`SSE unauthorized ${secret}`), { code: 401 }),
        false,
        null
      )
    );
    const readiness = await verify([acme({ auth: undefined })], {});
    expect(readiness).toMatchObject({
      servers: [
        {
          status: 'failed',
          error: 'MCP connection failed: streamableHttp=http_403; sse=http_401',
        },
      ],
    });
    expect(JSON.stringify(readiness)).not.toContain(secret);
    expect(JSON.stringify(readiness)).not.toMatch(/request-body|https:\/\//);
  });

  it('does not copy arbitrary errors into readiness reports', async () => {
    vi.mocked(openMCPClient).mockRejectedValue(
      new Error(
        'Authorization: Bearer sensitive-value Cookie: session=private request-body'
      )
    );
    await expect(
      verify([acme({ auth: undefined })], {})
    ).resolves.toMatchObject({ servers: [{ error: 'connection_failed' }] });
  });

  it('checks servers independently', async () => {
    vi.mocked(openMCPClient)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
      } as never);

    await expect(
      verify(
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
    ).resolves.toMatchObject({ ready: false });
    expect(openMCPClient).toHaveBeenCalledTimes(2);
  });
});
