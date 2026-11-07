import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  assertWriteModes,
  readOnlyServerLabels,
  resolveWriteModes,
  type WriteModeCheck,
} from './writeModes.js';
import type { WriteMode } from '../types/index.js';

const server = (label: string): MCPConfig => ({
  transport: 'stdio',
  command: 'node',
  args: [`${label}.mjs`],
  label,
});

const read: Tool = {
  name: 'search',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};
const writeTool: Tool = {
  name: 'create_note',
  inputSchema: { type: 'object' },
};

function check(
  modes: Record<string, WriteMode>,
  overrides: Partial<WriteModeCheck> = {}
): WriteModeCheck {
  return {
    variants: [
      {
        variant: 'baseline',
        modes,
        servers: Object.keys(modes).map(server),
      },
    ],
    allowLiveWrites: false,
    writeCases: [],
    listTools: async () => [read],
    log: () => {},
    ...overrides,
  };
}

describe('resolveWriteModes', () => {
  it('takes the launch, then the declaration, else read-only', () => {
    const { modes } = resolveWriteModes(
      'baseline',
      [server('notes'), server('docs'), server('wiki')],
      new Map([['notes', 'planned']]),
      { docs: 'unguarded' }
    );
    expect(modes).toEqual({
      notes: 'planned',
      docs: 'unguarded',
      wiki: 'read-only',
    });
  });

  it('rejects a declaration for a server whose proxy handles its writes', () => {
    expect(() =>
      resolveWriteModes(
        'baseline',
        [server('notes')],
        new Map([['notes', 'planned']]),
        {
          notes: 'unguarded',
        }
      )
    ).toThrow(/already has a write mode \(planned\)/);
  });
});

describe('readOnlyServerLabels', () => {
  it('lists servers with no proxy and no declaration', () => {
    expect([
      ...readOnlyServerLabels([server('docs'), server('wiki')], {
        docs: 'unguarded',
      }),
    ]).toEqual(['wiki']);
  });
});

describe('assertWriteModes', () => {
  it('passes read-only servers that list only reads', async () => {
    await expect(
      assertWriteModes(check({ docs: 'read-only' }))
    ).resolves.toBeUndefined();
  });

  it('stops a read-only server that lists a write tool', async () => {
    await expect(
      assertWriteModes(
        check(
          { docs: 'read-only' },
          { listTools: async () => [read, writeTool] }
        )
      )
    ).rejects.toThrow(
      /"docs" lists tools that aren't read-only \(create_note\)/
    );
  });

  it("leaves a server it can't list to the readiness check", async () => {
    const log = vi.fn();
    await expect(
      assertWriteModes(
        check(
          { docs: 'read-only', cowork: 'read-only' },
          {
            listTools: async (config) => {
              if (config.label === 'cowork') return undefined;
              throw new Error('ECONNREFUSED');
            },
            log,
          }
        )
      )
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(
      /"docs".*ECONNREFUSED.*readiness check/
    );
  });

  it("doesn't list unguarded or proxied servers", async () => {
    const listTools = vi.fn(async () => [writeTool]);
    await assertWriteModes(
      check({ docs: 'unguarded', notes: 'planned' }, { listTools })
    );
    expect(listTools).not.toHaveBeenCalled();
  });

  it('needs --allow-live-writes for a live server', async () => {
    await expect(assertWriteModes(check({ crm: 'live' }))).rejects.toThrow(
      /--allow-live-writes/
    );
    await expect(
      assertWriteModes(check({ crm: 'live' }, { allowLiveWrites: true }))
    ).resolves.toBeUndefined();
  });

  it('refuses write cases on a live server', async () => {
    await expect(
      assertWriteModes(
        check(
          { crm: 'live' },
          {
            allowLiveWrites: true,
            writeCases: [{ id: 'log-call', servers: [] }],
          }
        )
      )
    ).rejects.toThrow(/needs an outcome check/);
  });

  it("refuses a write case MST can't see", async () => {
    await expect(
      assertWriteModes(
        check(
          { notes: 'planned', docs: 'unguarded' },
          { writeCases: [{ id: 'save', servers: ['docs'] }] }
        )
      )
    ).rejects.toThrow(
      /Case "save" lists writes MST can't see.*"docs" is unguarded/
    );
    await expect(
      assertWriteModes(
        check(
          { docs: 'unguarded' },
          { writeCases: [{ id: 'save', servers: [] }] }
        )
      )
    ).rejects.toThrow(/none of its servers is behind a dry-run proxy/);
  });

  it('refuses compared variants whose writes get different replies', async () => {
    await expect(
      assertWriteModes({
        ...check({}),
        variants: [
          {
            variant: 'a',
            modes: { notes: 'planned' },
            servers: [server('notes')],
          },
          {
            variant: 'b',
            modes: { notes: 'simulated' },
            servers: [server('notes')],
          },
        ],
      })
    ).rejects.toThrow(/different replies to a write/);
  });

  it('refuses a declaration that names no server', async () => {
    await expect(
      assertWriteModes(
        check({ docs: 'read-only' }, { declared: { dcos: 'unguarded' } })
      )
    ).rejects.toThrow(/names no server: dcos/);
  });
});
