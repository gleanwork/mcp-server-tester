import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureCloudConnectors,
  planCloudConnectors,
  verifyCloudConnectorEvents,
  recoverCloudConnectorSettings,
  type CloudConnectorSnapshot,
  type CloudConnectorIO,
  type PermissionPatch,
} from './claudeAiConnectors.js';

const snapshot: CloudConnectorSnapshot = {
  accountId: 'account',
  organizationId: 'org',
  permissions: {},
  servers: [
    {
      id: 'glean',
      name: 'Glean',
      nativeName: 'Glean',
      connectionState: 'connected',
      tools: [
        {
          name: 'search',
          enabledKey: 'glean:search',
          approvalKey: 'glean:search-hash',
          readOnly: true,
        },
        {
          name: 'send',
          enabledKey: 'glean:send',
          approvalKey: 'glean:send-hash',
          readOnly: false,
        },
        {
          name: 'unknown',
          enabledKey: 'glean:unknown',
          approvalKey: 'glean:unknown-hash',
        },
      ],
    },
    {
      id: 'jira',
      name: 'Jira',
      nativeName: 'Jira',
      connectionState: 'connected',
      tools: [
        {
          name: 'read',
          enabledKey: 'jira:read',
          approvalKey: 'jira:read-hash',
          readOnly: true,
        },
      ],
    },
  ],
};

describe('cloud connector configuration', () => {
  it('verifies lazy-loaded tools without treating a pending init catalog as complete', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    const init = {
      payload: {
        type: 'system',
        subtype: 'init',
        tools: ['ToolSearch'],
        mcp_servers: [{ name: 'Glean', status: 'pending' }],
      },
    };
    const call = {
      payload: {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call-1', name: 'mcp__Glean__search' },
          ],
        },
      },
    };
    const result = verifyCloudConnectorEvents(plan, [init, call]);
    expect(result.observedAllowedTools).toEqual(['mcp__Glean__search']);
    expect(result.catalogComplete).toBe(false);
    expect(
      verifyCloudConnectorEvents(plan, [init]).unobservedAllowedTools
    ).toEqual(['mcp__Glean__search']);
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        init,
        {
          payload: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'mcp__Glean__send' }],
            },
          },
        },
      ])
    ).toThrow('unexpected');
    const search = {
      payload: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch' }],
        },
      },
    };
    const references = {
      payload: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search',
              content: [
                { type: 'tool_reference', tool_name: 'mcp__Glean__send' },
              ],
            },
          ],
        },
      },
    };
    expect(() =>
      verifyCloudConnectorEvents(plan, [init, search, references])
    ).toThrow('unexpected');
  });
  it('verifies actual tool exposure and refuses approval prompts', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    const event = (tools: string[]) => ({
      payload: { type: 'system', subtype: 'init', tools },
    });
    expect(
      verifyCloudConnectorEvents(plan, [event(['Read', 'mcp__Glean__search'])])
        .approvalRequests
    ).toBe(0);
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        event(['mcp__Glean__search', 'mcp__Glean__send']),
      ])
    ).toThrow('unexpected');
    expect(() => verifyCloudConnectorEvents(plan, [event([])])).toThrow(
      'missing'
    );
    expect(() =>
      verifyCloudConnectorEvents(plan, [
        event(['mcp__Glean__search']),
        {
          payload: {
            type: 'control_request',
            request: { subtype: 'can_use_tool' },
          },
        },
      ])
    ).toThrow('approvals');
    const none = planCloudConnectors(snapshot, { servers: {} });
    expect(
      verifyCloudConnectorEvents(none, [event(['Read'])]).observedToolCount
    ).toBe(1);
    expect(() =>
      verifyCloudConnectorEvents(none, [event(['mcp__Jira__new_tool'])])
    ).toThrow('unexpected');
  });

  it('resolves mixed configurations and refuses unavailable, ambiguous, or disconnected selections', () => {
    expect(
      planCloudConnectors(snapshot, {
        servers: {
          Glean: { policy: 'read-only' },
          jira: { policy: 'read-only' },
        },
      }).allowedTools
    ).toEqual(['mcp__Glean__search', 'mcp__Jira__read']);
    const unavailable = structuredClone(snapshot);
    unavailable.servers[0]!.toolDiscoveryError = 'HTTP 401';
    unavailable.servers[0]!.tools = [];
    unavailable.permissions['glean:old-tool'] = true;
    expect(
      planCloudConnectors(unavailable, { servers: {} }).patch['glean:old-tool']
    ).toBe(false);
    expect(() =>
      planCloudConnectors(unavailable, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('Cannot configure');
    unavailable.servers[0]!.connectionState = 'initiated';
    expect(() =>
      planCloudConnectors(unavailable, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('not connected');
    expect(() =>
      planCloudConnectors(snapshot, { servers: { glean: {}, Glean: {} } })
    ).toThrow('twice');
  });

  it('retains a recovery journal instead of overwriting concurrent edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-conflict-'));
    const state = structuredClone(snapshot);
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
        }
      },
    };
    try {
      const journal = join(dir, 'journal.json');
      const session = await configureCloudConnectors(
        io,
        { servers: {} },
        journal
      );
      state.permissions['glean:search'] = true;
      await expect(session.restore()).rejects.toThrow('concurrent edits');
      expect(state.permissions).toEqual({ 'glean:search': true });
      expect(JSON.parse(await readFile(journal, 'utf8')).version).toBe(1);
      delete state.permissions['glean:search'];
      await expect(recoverCloudConnectorSettings(io, journal)).resolves.toBe(
        true
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports allow-all, ask, tool overrides and inherited configuration independently', () => {
    const all = planCloudConnectors(snapshot, {
      servers: { glean: { policy: 'allow-all', tools: { send: 'block' } } },
    });
    expect(all.patch['glean:search-hash']).toBe(true);
    expect(all.patch['glean:unknown']).toBe(true);
    expect(all.patch['glean:send']).toBe(false);
    const ask = planCloudConnectors(snapshot, {
      default: 'inherit',
      failOnApproval: false,
      servers: { glean: { policy: 'ask' } },
    });
    expect(ask.patch['glean:search']).toBe(true);
    expect(ask.patch['glean:search-hash']).toBe(false);
    expect(ask.patch).not.toHaveProperty('jira:read');
    expect(() =>
      planCloudConnectors(snapshot, { servers: { glean: { policy: 'ask' } } })
    ).toThrow('failOnApproval');
    expect(() =>
      planCloudConnectors(snapshot, {
        servers: { missing: { policy: 'allow-all' } },
      })
    ).toThrow('unknown');
    expect(() =>
      planCloudConnectors(snapshot, {
        servers: { glean: { tools: { typo: 'allow' } } },
      })
    ).toThrow('Unknown tool');
    const restricted = structuredClone(snapshot);
    restricted.servers[0]!.tools[0]!.maxPermission = 'ask';
    expect(() =>
      planCloudConnectors(restricted, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('Organization policy');
  });

  it('applies both permissions and exactly restores absent keys while preserving unrelated concurrent changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-test-'));
    const state = structuredClone(snapshot);
    state.permissions['unrelated'] = true;
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch, expected) {
        for (const [key, value] of Object.entries(patch)) {
          expect(state.permissions[key] ?? null).toEqual(expected[key]);
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
        }
      },
    };
    try {
      const session = await configureCloudConnectors(
        io,
        { servers: { Glean: { policy: 'read-only' } } },
        join(dir, 'journal.json')
      );
      expect(state.permissions['glean:search-hash']).toBe(true);
      expect(state.permissions['glean:send']).toBe(false);
      state.permissions.unrelated = false;
      await session.restore();
      expect(state.permissions).toEqual({ unrelated: false });
      await expect(readFile(join(dir, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back partial application failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-failure-'));
    const state = structuredClone(snapshot);
    let fail = true;
    const io: CloudConnectorIO = {
      inspect: async () => structuredClone(state),
      read: async () => structuredClone(state),
      async patch(_identity, patch: PermissionPatch) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete state.permissions[key];
          else state.permissions[key] = value;
          if (fail) {
            fail = false;
            throw new Error('connection dropped after partial write');
          }
        }
      },
    };
    try {
      await expect(
        configureCloudConnectors(io, { servers: {} }, join(dir, 'journal.json'))
      ).rejects.toThrow('connection dropped');
      expect(state.permissions).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('selects Glean read-only, explicitly approves reads, and blocks writes, unknowns and other servers', () => {
    const plan = planCloudConnectors(snapshot, {
      servers: { Glean: { policy: 'read-only' } },
    });
    expect(plan.patch).toEqual({
      'glean:search': true,
      'glean:search-hash': true,
      'glean:send': false,
      'glean:send-hash': false,
      'glean:unknown': false,
      'glean:unknown-hash': false,
      'jira:read': false,
      'jira:read-hash': false,
    });
    expect(plan.allowedTools).toEqual(['mcp__Glean__search']);
  });
});
