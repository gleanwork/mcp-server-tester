import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  verifyCoworkMcpServers,
  CoworkMcpReadinessError,
} from './mcpReadiness.js';
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

  it('connects and lists tools for every configured server', async () => {
    vi.mocked(createMCPClientForConfig).mockResolvedValue({
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'search' }] }),
    } as never);

    await expect(
      verifyCoworkMcpServers([
        {
          transport: 'http',
          label: 'glean',
          serverUrl: 'https://example.test/mcp',
        },
      ])
    ).resolves.toMatchObject([
      { label: 'glean', status: 'connected', toolCount: 1 },
    ]);
    expect(createMCPClientForConfig).toHaveBeenCalledOnce();
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
      verifyCoworkMcpServers([
        {
          transport: 'http',
          label: 'glean',
          serverUrl: 'https://example.test/mcp',
        },
      ])
    ).rejects.toMatchObject({
      name: 'CoworkMcpReadinessError',
      servers: [
        { label: 'glean', status: 'failed', error: 'Authorization=[REDACTED]' },
      ],
    });
    expect(closeMCPClient).toHaveBeenCalledWith(client);
  });

  it('checks servers independently', async () => {
    vi.mocked(createMCPClientForConfig)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
      } as never);

    await expect(
      verifyCoworkMcpServers([
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
      ])
    ).rejects.toBeInstanceOf(CoworkMcpReadinessError);
    expect(createMCPClientForConfig).toHaveBeenCalledTimes(2);
  });
});
