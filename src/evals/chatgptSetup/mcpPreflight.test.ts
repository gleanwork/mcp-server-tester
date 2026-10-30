import { describe, expect, it, vi } from 'vitest';
import { checkMcpServers } from '../mcpReadiness.js';
import type * as ReadinessModule from '../mcpReadiness.js';
import { preflightChatgptMcpServers } from './mcpPreflight.js';

vi.mock('../mcpReadiness.js', async (original) => ({
  ...(await original<typeof ReadinessModule>()),
  checkMcpServers: vi.fn(),
}));

describe('preflightChatgptMcpServers', () => {
  it("checks a stdio server against its minTools, as the app can't", async () => {
    vi.mocked(checkMcpServers).mockResolvedValue([
      {
        label: 'slack',
        status: 'failed',
        elapsedMs: 1,
        error: 'too few tools (2 < 4)',
      },
    ]);
    const result = await preflightChatgptMcpServers(
      [
        {
          transport: 'stdio',
          label: 'slack',
          command: 'node',
          args: ['proxy.js'],
          minTools: 4,
        },
      ],
      {}
    );
    expect(vi.mocked(checkMcpServers).mock.calls[0]![0]).toEqual([
      expect.objectContaining({ label: 'slack', minTools: 4 }),
    ]);
    expect(result.passed).toBe(false);
  });
});
