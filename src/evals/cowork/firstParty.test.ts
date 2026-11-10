import { describe, expect, it } from 'vitest';
import {
  assertFirstPartyServers,
  bindFirstPartyServers,
} from './firstParty.js';
import type { CloudConnectorSnapshot } from './claudeAiConnectors.js';

const snapshot: CloudConnectorSnapshot = {
  accountId: 'account',
  organizationId: 'org',
  permissions: {},
  servers: [
    {
      id: 'remote-id',
      name: 'Account Search',
      nativeName: 'Account_Search',
      url: 'https://example.com/mcp',
      connectionState: 'connected',
      tools: [
        {
          name: 'search',
          enabledKey: 'remote-id:search',
          approvalKey: 'remote-id:search-hash',
          readOnly: true,
        },
        {
          name: 'write',
          enabledKey: 'remote-id:write',
          approvalKey: 'remote-id:write-hash',
          readOnly: false,
        },
      ],
    },
  ],
};
describe('first-party server declarations', () => {
  const server = {
    transport: 'http' as const,
    label: 'eval-search',
    serverUrl: 'https://example.com/mcp',
  };
  it('uses label-keyed policies and keeps the write-mode guard', () => {
    const bound = bindFirstPartyServers(snapshot, [server], {
      servers: {
        'eval-search': { policy: 'read-only', tools: { search: 'block' } },
      },
    });
    expect(bound.config.servers?.['remote-id']?.tools).toEqual({
      search: 'block',
    });
    const all = {
      servers: { 'eval-search': { policy: 'allow-all' as const } },
    };
    expect(() => bindFirstPartyServers(snapshot, [server], all)).toThrow(
      'Declare writes.eval-search'
    );
    expect(
      bindFirstPartyServers(snapshot, [server], all, {
        'eval-search': 'unguarded',
      }).config.servers?.['remote-id']?.policy
    ).toBe('allow-all');
    expect(() =>
      bindFirstPartyServers(snapshot, [server], {
        servers: { 'eval-search': { tools: { write: 'allow' } } },
      })
    ).toThrow('permits write');
  });
  it('refuses absent, disconnected, ambiguous and duplicate account bindings', () => {
    expect(() =>
      bindFirstPartyServers(snapshot, [
        { ...server, serverUrl: 'https://other.example/mcp' },
      ])
    ).toThrow('found 0');
    const disconnected = structuredClone(snapshot);
    disconnected.servers[0]!.connectionState = 'initiated';
    expect(() => bindFirstPartyServers(disconnected, [server])).toThrow(
      'found 0'
    );
    const ambiguous = structuredClone(snapshot);
    ambiguous.servers.push({ ...ambiguous.servers[0]!, id: 'second' });
    expect(() => bindFirstPartyServers(ambiguous, [server])).toThrow('found 2');
    expect(() =>
      bindFirstPartyServers(snapshot, [
        server,
        { ...server, label: 'duplicate' },
      ])
    ).toThrow('same account connector');
  });
  it('rejects transport settings it cannot honor and policies for unselected labels', () => {
    expect(() =>
      assertFirstPartyServers([{ transport: 'stdio', command: 'node' }])
    ).toThrow('stdio');
    expect(() =>
      assertFirstPartyServers([
        { ...server, auth: { accessTokenEnv: 'TOKEN' } },
      ])
    ).toThrow('cannot apply auth');
    expect(() =>
      assertFirstPartyServers([
        { ...server, headers: { Authorization: 'secret' } },
      ])
    ).toThrow('cannot apply headers');
    expect(() =>
      assertFirstPartyServers([
        { ...server, serverUrl: 'https://user:secret@example.com/mcp' },
      ])
    ).toThrow('embedded credentials');
    expect(() =>
      assertFirstPartyServers([server], { servers: { typo: {} } })
    ).toThrow('no selected server label');
    expect(() =>
      assertFirstPartyServers([server], { default: 'inherit' })
    ).toThrow('requires connectors.default');
    expect(() =>
      assertFirstPartyServers([server], {
        servers: { 'eval-search': { tools: { search: 'inherit' } } },
      })
    ).toThrow('inherit is unsupported');
  });
  it('binds a normal HTTP server label to its connected account connector and defaults to read-only', () => {
    const binding = bindFirstPartyServers(snapshot, [
      {
        transport: 'http',
        label: 'eval-search',
        serverUrl: 'https://example.com/mcp',
      },
    ]);
    expect(binding.labels).toEqual({ Account_Search: 'eval-search' });
    expect(binding.config).toEqual({
      default: 'block',
      failOnApproval: true,
      servers: { 'remote-id': { policy: 'read-only', tools: {} } },
    });
    expect(bindFirstPartyServers(snapshot, []).config.servers).toEqual({});
  });
  it('rejects a selected connector with an empty authenticated tool inventory', () => {
    const empty = structuredClone(snapshot);
    empty.servers[0]!.tools = [];
    expect(() => bindFirstPartyServers(empty, [server])).toThrow(
      'listed no tools'
    );
    expect(bindFirstPartyServers(empty, []).config.servers).toEqual({});
  });
  it('still accepts deliberately blocked tools on a nonempty inventory', () => {
    expect(
      bindFirstPartyServers(snapshot, [server], {
        servers: { 'eval-search': { policy: 'block' } },
      }).config.servers?.['remote-id']?.policy
    ).toBe('block');
    expect(
      bindFirstPartyServers(snapshot, [server], {
        servers: {
          'eval-search': {
            policy: 'read-only',
            tools: { search: 'block', write: 'block' },
          },
        },
      }).config.servers?.['remote-id']?.tools
    ).toEqual({ search: 'block', write: 'block' });
  });
});
