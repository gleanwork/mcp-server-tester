import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import {
  buildToolSurface,
  registerPresentedTools,
  withOriginalToolNames,
} from './toolSurface.js';

function tool(name: string, description = `${name} tool`): Tool {
  return { name, description, inputSchema: { type: 'object' } };
}

const twoServers = [
  { server: 'a', tools: [tool('search'), tool('read')] },
  { server: 'b', tools: [tool('search')] },
];

function presented(surface: ReturnType<typeof buildToolSurface>) {
  return surface.tools.map(({ server, originalName, tool }) => ({
    server,
    originalName,
    name: tool.name,
    description: tool.description,
  }));
}

describe('buildToolSurface', () => {
  it('presents the listed tools unchanged without a variant', () => {
    const surface = buildToolSurface(twoServers);
    expect(presented(surface)).toEqual([
      {
        server: 'a',
        originalName: 'search',
        name: 'search',
        description: 'search tool',
      },
      {
        server: 'a',
        originalName: 'read',
        name: 'read',
        description: 'read tool',
      },
      {
        server: 'b',
        originalName: 'search',
        name: 'search',
        description: 'search tool',
      },
    ]);
  });

  it('applies a bare key to the one tool with that name', () => {
    const surface = buildToolSurface(twoServers, {
      id: 'v',
      tools: { read: { description: 'Read a document.' } },
    });
    expect(surface.tools[1]?.tool.description).toBe('Read a document.');
  });

  it('applies a qualified key to its server only, ahead of a bare key', () => {
    const surface = buildToolSurface(twoServers, {
      id: 'v',
      tools: {
        'a.search': { description: 'qualified' },
        search: { description: 'bare' },
      },
    });
    expect(surface.tools.map((entry) => entry.tool.description)).toEqual([
      'qualified',
      'read tool',
      'bare',
    ]);
  });

  it('rejects unknown and ambiguous keys', () => {
    expect(() =>
      buildToolSurface(twoServers, { id: 'v', tools: { missing: {} } })
    ).toThrow('toolOverrides variant "v" overrides unknown tool "missing".');
    expect(() =>
      buildToolSurface(twoServers, { id: 'v', tools: { search: {} } })
    ).toThrow(
      'toolOverrides variant "v" override "search" matches a tool on several servers; use "server.tool".'
    );
  });

  it('only matches qualified keys on labelled servers', () => {
    expect(() =>
      buildToolSurface([{ tools: [tool('search')] }], {
        id: 'v',
        tools: { 'undefined.search': {} },
      })
    ).toThrow('overrides unknown tool "undefined.search"');
  });

  it('renames a tool and resolves the new name to the original', () => {
    const surface = buildToolSurface(twoServers, {
      id: 'v',
      tools: { 'b.search': { name: 'find_more_tools' } },
    });
    expect(surface.tools[2]?.tool.name).toBe('find_more_tools');
    expect(surface.resolve('find_more_tools', 'b')).toMatchObject({
      server: 'b',
      originalName: 'search',
    });
    expect(surface.resolve('search', 'b')).toBeUndefined();
    expect(surface.resolve('find_more_tools', 'a')).toBeUndefined();
    expect(surface.resolve('search', 'a')?.originalName).toBe('search');
  });

  it('rejects a rename that is not a valid tool name', () => {
    expect(() =>
      buildToolSurface(twoServers, {
        id: 'v',
        tools: { read: { name: 'read a doc' } },
      })
    ).toThrow('renames "read" to "read a doc", which is not a valid tool name');
  });

  it('rejects a rename onto another tool on the same server', () => {
    expect(() =>
      buildToolSurface(twoServers, {
        id: 'v',
        tools: { read: { name: 'search' } },
      })
    ).toThrow(
      'renames "read" to "search", which another tool on server "a" already has.'
    );
  });

  it('allows the same name on different servers', () => {
    const surface = buildToolSurface(twoServers, {
      id: 'v',
      tools: { read: { name: 'lookup' }, 'b.search': { name: 'lookup' } },
    });
    expect(surface.resolve('lookup', 'a')?.originalName).toBe('read');
    expect(surface.resolve('lookup', 'b')?.originalName).toBe('search');
  });

  it('rejects two renames onto the same new name', () => {
    expect(() =>
      buildToolSurface(twoServers, {
        id: 'v',
        tools: { 'a.search': { name: 'lookup' }, read: { name: 'lookup' } },
      })
    ).toThrow('gives "search" and "read" the same name "lookup" on server "a"');
  });

  it.each([
    ['a swap', { 'a.search': { name: 'read' }, read: { name: 'search' } }],
    ['a chain', { 'a.search': { name: 'read' }, read: { name: 'fetch' } }],
  ])('rejects %s, so a name never resolves two ways', (_label, tools) => {
    expect(() => buildToolSurface(twoServers, { id: 'v', tools })).toThrow(
      'which another tool on server "a" already has'
    );
  });

  it('accepts 128-character names and rejects 129', () => {
    const ok = 'n'.repeat(128);
    expect(
      buildToolSurface(twoServers, { id: 'v', tools: { read: { name: ok } } })
        .tools[1]?.tool.name
    ).toBe(ok);
    expect(() =>
      buildToolSurface(twoServers, {
        id: 'v',
        tools: { read: { name: `${ok}n` } },
      })
    ).toThrow('is not a valid tool name');
  });

  it("only applies the variant's own keys", () => {
    const surface = buildToolSurface(
      [{ server: 'a', tools: [tool('constructor'), tool('toString')] }],
      { id: 'v', tools: {} }
    );
    expect(surface.tools.map((entry) => entry.tool.name)).toEqual([
      'constructor',
      'toString',
    ]);
  });
});

describe('withOriginalToolNames', () => {
  it('records calls and tool events under the original name', () => {
    const mcp = {};
    registerPresentedTools(mcp, (name) =>
      name === 'find' ? 'search' : undefined
    );
    const result = withOriginalToolNames(
      {
        toolCalls: [
          { name: 'find', arguments: {} },
          { name: 'other', arguments: {} },
          { name: 'find', rawName: 'a__find', arguments: {} },
        ],
        events: [
          { kind: 'tool_call', name: 'find' },
          { kind: 'skill', name: 'find' },
        ],
      },
      mcp
    );
    expect(result.toolCalls).toEqual([
      { name: 'search', rawName: 'find', arguments: {} },
      { name: 'other', arguments: {} },
      { name: 'search', rawName: 'a__find', arguments: {} },
    ]);
    expect(result.events).toEqual([
      { kind: 'tool_call', name: 'search', rawName: 'find' },
      { kind: 'skill', name: 'find' },
    ]);
  });

  it('leaves results from an unregistered fixture alone', () => {
    const result = { toolCalls: [{ name: 'find', arguments: {} }] };
    expect(withOriginalToolNames(result, {})).toBe(result);
  });
});
