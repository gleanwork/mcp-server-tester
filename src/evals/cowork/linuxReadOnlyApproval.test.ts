import { beforeEach, expect, it, vi } from 'vitest';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { openMCPClient, closeMCPClient } from '../../mcp/clientFactory.js';
import { linuxReadOnlyApprovals } from './linuxReadOnlyApproval.js';
import type { ClaudeTranscript } from './transcript.js';

vi.mock('../../mcp/clientFactory.js', () => ({
  openMCPClient: vi.fn(),
  closeMCPClient: vi.fn(),
  abandonMCPClient: vi.fn(),
}));
const server: MCPConfig = {
  label: 'drive',
  transport: 'http',
  serverUrl: 'https://example.test/mcp',
};
const search = {
  name: 'search_files',
  annotations: { readOnlyHint: true },
  title: 'Search files',
};
const transcript = (tool = 'mcp__drive__search_files', id = 'request-1') =>
  ({
    pendingToolPermission: { tool, id },
    isComplete: false,
  }) as ClaudeTranscript;
const listing = vi.fn();
const verify = (
  servers = [server] as MCPConfig[],
  deadline = Date.now() + 10000
) => linuxReadOnlyApprovals(servers, (s) => s, deadline);
beforeEach(() => {
  vi.clearAllMocks();
  listing.mockReset();
  vi.mocked(closeMCPClient).mockResolvedValue(undefined);
  vi.mocked(openMCPClient).mockResolvedValue({ listTools: listing } as never);
});
it('checks the complete catalog at the exact server and reuses a decision only for its request', async () => {
  listing
    .mockResolvedValueOnce({
      tools: [{ name: 'delete_file' }],
      nextCursor: 'more',
    })
    .mockResolvedValue({ tools: [search] });
  const check = verify();
  expect(await check(transcript())).toMatchObject({
    id: 'request-1',
    server: 'drive',
    titles: expect.arrayContaining(['Search files']),
  });
  expect(await check(transcript())).toBeDefined();
  expect(listing).toHaveBeenCalledTimes(2);
  expect(await check(transcript('mcp__drive__delete_file'))).toBeUndefined();
  expect(await check(transcript(undefined, 'request-2'))).toBeDefined();
  expect(listing).toHaveBeenCalledTimes(3);
  expect(closeMCPClient).toHaveBeenCalledTimes(2);
});
it('does not approve a write, unannotated, missing, duplicate or destructive tool, or a colliding card title', async () => {
  for (const tools of [
    [],
    [{ name: 'search_files' }],
    [{ ...search, annotations: { readOnlyHint: false } }],
    [{ ...search, annotations: { readOnlyHint: true, destructiveHint: true } }],
    [search, search],
    [{ ...search, name: 'different' }],
  ]) {
    listing.mockResolvedValue({ tools });
    expect(await verify()(transcript())).toBeUndefined();
  }
  listing.mockResolvedValue({
    tools: [search, { name: 'delete_file', title: 'Search files' }],
  });
  expect((await verify()(transcript()))?.titles).not.toContain('Search files');
});
it('does not act on missing or ambiguous identity, an expired deadline or a failed or incomplete catalog', async () => {
  expect(await verify()()).toBeUndefined();
  expect(await verify()({ ...transcript(), isComplete: true })).toBeUndefined();
  expect(await verify([server, server])(transcript())).toBeUndefined();
  expect(
    await verify()(transcript('mcp__other__search_files'))
  ).toBeUndefined();
  expect(await verify([server], 0)(transcript())).toBeUndefined();
  expect(openMCPClient).not.toHaveBeenCalled();
  listing.mockRejectedValueOnce(new Error('unavailable'));
  expect(await verify()(transcript())).toBeUndefined();
  listing.mockResolvedValue({ tools: [search], nextCursor: 'never ends' });
  expect(await verify()(transcript())).toBeUndefined();
});
it('respects proxy write overrides and argument-dependent dispatchers even when the upstream calls them reads', async () => {
  for (const flags of [
    ['--always-write', 'search_files'],
    ['--always-write=search_files'],
    ['--dispatcher', 'search_files=action'],
    ['--dispatcher=search_files=action'],
  ]) {
    const proxy: MCPConfig = {
      label: 'drive',
      transport: 'stdio',
      command: 'node',
      args: [
        '/installed/proxy/dryRun.js',
        '--upstream-url',
        'https://example.test',
        ...flags,
      ],
    };
    expect(await verify([proxy])(transcript())).toBeUndefined();
  }
  expect(openMCPClient).not.toHaveBeenCalled();
});
