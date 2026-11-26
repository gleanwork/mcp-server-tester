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
    status: 'approved',
    approval: {
      id: 'request-1',
      server: 'drive',
      titles: expect.arrayContaining(['Search files']),
    },
  });
  expect(await check(transcript())).toMatchObject({ status: 'approved' });
  expect(listing).toHaveBeenCalledTimes(2);
  // Same request id, different tool: a new decision, not the cached grant.
  expect(await check(transcript('mcp__drive__delete_file'))).toEqual({
    status: 'denied',
  });
  expect(await check(transcript(undefined, 'request-2'))).toMatchObject({
    status: 'approved',
  });
  expect(listing).toHaveBeenCalledTimes(4);
  expect(closeMCPClient).toHaveBeenCalledTimes(3);
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
    expect(await verify()(transcript())).toEqual({ status: 'denied' });
  }
  listing.mockResolvedValue({
    tools: [search, { name: 'delete_file', title: 'Search files' }],
  });
  const colliding = await verify()(transcript());
  expect(colliding).toMatchObject({ status: 'approved' });
  if (colliding.status === 'approved')
    expect(colliding.approval.titles).not.toContain('Search files');
});
it('waits when the audit or catalog is not ready, and retries a failed probe', async () => {
  expect(await verify()()).toEqual({ status: 'pending' });
  expect(await verify()({ ...transcript(), isComplete: true })).toEqual({
    status: 'pending',
  });
  expect(await verify([server], 0)(transcript())).toEqual({
    status: 'pending',
  });
  expect(openMCPClient).not.toHaveBeenCalled();
  const check = verify();
  listing.mockRejectedValueOnce(new Error('unavailable'));
  expect(await check(transcript())).toEqual({ status: 'pending' });
  listing.mockResolvedValueOnce({ tools: [search], nextCursor: 'never ends' });
  expect(await check(transcript())).toEqual({ status: 'pending' });
  listing.mockResolvedValue({ tools: [search] });
  expect(await check(transcript())).toMatchObject({ status: 'approved' });
  // The failed probe, the unfinished catalog, and the later successful one.
  expect(listing).toHaveBeenCalledTimes(4);
});
it('denies a pending call that is not this server, and remembers that denial', async () => {
  expect(await verify([server, server])(transcript())).toEqual({
    status: 'denied',
  });
  const check = verify();
  expect(await check(transcript('mcp__other__search_files'))).toEqual({
    status: 'denied',
  });
  expect(await check(transcript('mcp__other__search_files'))).toEqual({
    status: 'denied',
  });
  expect(openMCPClient).not.toHaveBeenCalled();
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
    expect(await verify([proxy])(transcript())).toEqual({ status: 'denied' });
  }
  expect(openMCPClient).not.toHaveBeenCalled();
});
