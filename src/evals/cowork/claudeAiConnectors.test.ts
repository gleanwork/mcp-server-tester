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

const policySnapshot: CloudConnectorSnapshot = {
  accountId: 'acme-account',
  organizationId: 'acme-org',
  permissions: {},
  servers: [
    {
      id: 'docs',
      name: 'Acme Documents',
      nativeName: 'Acme_Documents',
      connectionState: 'connected',
      tools: [
        {
          name: 'search',
          enabledKey: 'docs:search',
          approvalKey: 'docs:search-hash',
          readOnly: true,
        },
        {
          name: 'send',
          enabledKey: 'docs:send',
          approvalKey: 'docs:send-hash',
          readOnly: false,
        },
      ],
    },
    {
      id: 'tasks',
      name: 'Task Board',
      nativeName: 'Task_Board',
      connectionState: 'connected',
      tools: [
        {
          name: 'read',
          enabledKey: 'tasks:read',
          approvalKey: 'tasks:read-hash',
          readOnly: true,
        },
      ],
    },
  ],
};

describe('cloud connector configuration', () => {
  it.each([false, true])(
    'refuses preparation when an excluded connected inventory fails (saved keys: %s)',
    async (savedKeys) => {
      const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-inventory-'));
      const state = structuredClone(policySnapshot);
      state.servers[1]!.tools = [];
      state.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
      if (savedKeys) state.permissions['tasks:old-tool'] = true;
      const original = structuredClone(state.permissions);
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
        await expect(
          configureCloudConnectors(
            io,
            { servers: { docs: { policy: 'read-only' } } },
            journal
          )
        ).rejects.toThrow(/Task Board.*Tool inventory HTTP 503/);
        expect(state.permissions).toEqual(original);
        await expect(readFile(journal)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('recovers an earlier transaction before refusing an excluded inventory gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-connectors-recovery-'));
    const state = structuredClone(policySnapshot);
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
      const journal = join(dir, 'journal.json');
      const config = { servers: { docs: { policy: 'read-only' as const } } };
      await configureCloudConnectors(io, config, journal);
      expect(state.permissions['docs:search']).toBe(true);
      state.servers[1]!.tools = [];
      state.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
      await expect(
        configureCloudConnectors(io, config, journal)
      ).rejects.toThrow(/Task Board.*Tool inventory HTTP 503/);
      expect(state.permissions).toEqual({});
      await expect(readFile(journal)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(['Acme_Documents', 'Acme Documents'])(
    'recognizes the pending server name %s without widening allowed tools',
    (pendingName) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      const init = {
        payload: {
          type: 'system',
          subtype: 'init',
          tools: ['ToolSearch'],
          mcp_servers: [{ name: pendingName, status: 'pending' }],
        },
      };
      const result = verifyCloudConnectorEvents(plan, [init]);
      expect(result).toMatchObject({
        allowedTools: ['mcp__Acme_Documents__search'],
        observedAllowedTools: [],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        pendingServers: [pendingName],
        catalogComplete: false,
      });
      const search = {
        payload: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'lookup', name: 'ToolSearch' }],
          },
        },
      };
      const reference = (tool: string) => ({
        payload: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'lookup',
                content: [{ type: 'tool_reference', tool_name: tool }],
              },
            ],
          },
        },
      });
      expect(
        verifyCloudConnectorEvents(plan, [
          init,
          search,
          reference('mcp__Acme_Documents__search'),
        ]).observedAllowedTools
      ).toEqual(['mcp__Acme_Documents__search']);
      for (const tool of [
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
        'mcp__Task_Board__read',
        'mcp__Task_Board__new_tool',
      ]) {
        expect(() =>
          verifyCloudConnectorEvents(plan, [init, search, reference(tool)])
        ).toThrow('1 unexpected tools');
      }
    }
  );

  it.each(['Acme_Documents', 'Acme Documents'])(
    'recognizes pending name %s for an inherited connector with a tool override',
    (name) => {
      const plan = planCloudConnectors(policySnapshot, {
        default: 'inherit',
        servers: { docs: { policy: 'inherit', tools: { search: 'allow' } } },
      });
      expect(
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name, status: 'pending' }],
            },
          },
        ])
      ).toMatchObject({
        allowedTools: ['mcp__Acme_Documents__search'],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        catalogComplete: false,
      });
    }
  );

  it('refuses an explicit block with an unavailable connected inventory but permits inheritance', () => {
    const unavailable = structuredClone(policySnapshot);
    unavailable.servers[1]!.tools = [];
    unavailable.servers[1]!.toolDiscoveryError = 'Tool inventory HTTP 503';
    expect(() =>
      planCloudConnectors(unavailable, {
        default: 'inherit',
        servers: { tasks: { policy: 'block' } },
      })
    ).toThrow(/Task Board.*Tool inventory HTTP 503/);
    expect(
      planCloudConnectors(unavailable, { default: 'inherit' }).patch
    ).toEqual({});
  });

  it.each(['Task_Board', 'Task Board', 'Acme.Documents'])(
    'does not excuse missing allowed tools for unrelated pending name %s',
    (pendingName) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      expect(() =>
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name: pendingName, status: 'pending' }],
            },
          },
        ])
      ).toThrow('Missing: mcp__Acme_Documents__search');
    }
  );

  it.each(['Acme_Documents', 'Acme Documents'])(
    'still requires allowed tools when server %s is no longer pending',
    (name) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      expect(() =>
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name, status: 'connected' }],
            },
          },
        ])
      ).toThrow('Missing: mcp__Acme_Documents__search');
    }
  );

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
  it.each(['text', 'text-blocks'] as const)(
    'verifies allowed, blocked and newly surfaced managed tools in ToolSearch %s results',
    (format) => {
      const plan = planCloudConnectors(policySnapshot, {
        servers: { docs: { policy: 'read-only' } },
      });
      const init = {
        payload: { type: 'system', subtype: 'init', tools: ['ToolSearch'] },
      };
      const search = {
        payload: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'lookup', name: 'ToolSearch' }],
          },
        },
      };
      const result = (tools: string[]) => {
        const text = `Available: ${tools.join(', ')}.`;
        return {
          payload: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'lookup',
                  content: format === 'text' ? text : [{ type: 'text', text }],
                },
              ],
            },
          },
        };
      };
      expect(
        verifyCloudConnectorEvents(plan, [
          init,
          search,
          result(['mcp__Acme_Documents__search']),
        ])
      ).toMatchObject({
        observedAllowedTools: ['mcp__Acme_Documents__search'],
        unobservedAllowedTools: [],
        catalogComplete: true,
      });
      for (const tool of [
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
        'mcp__Task_Board__read',
        'mcp__Task_Board__new_tool',
      ]) {
        expect(() =>
          verifyCloudConnectorEvents(plan, [
            init,
            search,
            result(['mcp__Acme_Documents__search', tool]),
          ])
        ).toThrow(`Unexpected: ${tool}. Missing: none.`);
      }
    }
  );

  it.each(['text', 'text-blocks', 'references'] as const)(
    'does not treat unrelated MCP %s results as ToolSearch catalog evidence',
    (format) => {
      const plan = planCloudConnectors(policySnapshot, {
        default: 'inherit',
        servers: { docs: { policy: 'read-only' } },
      });
      const tools = [
        'mcp__Acme_Documents__search',
        'mcp__Acme_Documents__send',
        'mcp__Acme_Documents__new_tool',
      ];
      const text = `The document mentions ${tools.join(', ')}.`;
      const content =
        format === 'text'
          ? text
          : format === 'text-blocks'
            ? [{ type: 'text', text }]
            : tools.map((tool_name) => ({ type: 'tool_reference', tool_name }));
      expect(
        verifyCloudConnectorEvents(plan, [
          {
            payload: {
              type: 'system',
              subtype: 'init',
              tools: ['ToolSearch'],
              mcp_servers: [{ name: 'Acme Documents', status: 'pending' }],
            },
          },
          {
            payload: {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', id: 'lookup', name: 'ToolSearch' },
                  {
                    type: 'tool_use',
                    id: 'read',
                    name: 'mcp__Task_Board__read',
                  },
                ],
              },
            },
          },
          {
            payload: {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'lookup',
                    content: 'No matching tools.',
                  },
                  { type: 'tool_result', tool_use_id: 'read', content },
                  { type: 'tool_result', tool_use_id: 'unknown', content },
                ],
              },
            },
          },
        ])
      ).toMatchObject({
        observedToolCount: 2,
        observedAllowedTools: [],
        unobservedAllowedTools: ['mcp__Acme_Documents__search'],
        catalogComplete: false,
      });
    }
  );

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
    expect(() => planCloudConnectors(unavailable, { servers: {} })).toThrow(
      'Cannot configure'
    );
    expect(() =>
      planCloudConnectors(unavailable, {
        servers: { glean: { policy: 'allow-all' } },
      })
    ).toThrow('Cannot configure');
    unavailable.servers[0]!.connectionState = 'initiated';
    expect(
      planCloudConnectors(unavailable, { servers: {} }).patch['glean:old-tool']
    ).toBe(false);
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
