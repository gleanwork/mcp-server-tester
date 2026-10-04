import type { Tool } from '@modelcontextprotocol/client';
import type { ToolOverrideVariant } from './evalRunner.js';

/** One server's tools as it listed them. `server` is its label, if it has one. */
export interface ListedServerTools {
  server?: string;
  tools: Tool[];
}

/** A tool as the host shows it to the model. */
export interface SurfaceTool {
  /** The label of the server that serves the tool, if it has one. */
  server?: string;
  /** The tool's name on its server. */
  originalName: string;
  /** The tool with the variant applied; `tool.name` is the presented name. */
  tool: Tool;
}

/**
 * An arm's tools as the host presents them: the servers' tools with the
 * arm's tool variant (renames, descriptions, input schemas) applied.
 *
 * Every host builds its tool list from a surface, so a variant means the same
 * thing on every host. Hosts still choose how to qualify names across
 * several servers (`label.tool`, `label__tool`); the surface's names are
 * per server.
 */
export interface ToolSurface {
  readonly tools: readonly SurfaceTool[];
  /** The original tool behind a presented name on a server, if there is one. */
  resolve(name: string, server?: string): SurfaceTool | undefined;
}

// MCP tool names: 1-128 characters from A-Z a-z 0-9 _ - . (SEP-986).
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Applies a tool variant to the listed tools. Override keys are a tool's
 * name on its server, or `server.tool` to pick one of several servers; a
 * qualified key wins over a bare one. Throws for a key that matches no tool
 * or several, and for a rename that is not a valid tool name or collides with
 * another tool on the same server.
 */
export function buildToolSurface(
  listed: readonly ListedServerTools[],
  variant?: ToolOverrideVariant
): ToolSurface {
  const entries = listed.flatMap(({ server, tools }) =>
    tools.map((tool) => ({ server, tool }))
  );
  const overrides = variant?.tools ?? {};
  const overrideFor = (key: string | undefined) =>
    key !== undefined && Object.hasOwn(overrides, key)
      ? overrides[key]
      : undefined;
  const label = variant ? `toolOverrides variant "${variant.id}"` : '';

  for (const key of Object.keys(overrides)) {
    const matches = entries.filter(({ server, tool }) => {
      const qualified =
        server === undefined ? undefined : `${server}.${tool.name}`;
      return (
        key === qualified ||
        (key === tool.name &&
          (qualified === undefined || !Object.hasOwn(overrides, qualified)))
      );
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `${label} overrides unknown tool "${key}".`
          : `${label} override "${key}" matches a tool on several servers; use "server.tool".`
      );
    }
  }

  const tools: SurfaceTool[] = entries.map(({ server, tool }) => {
    const override =
      overrideFor(
        server === undefined ? undefined : `${server}.${tool.name}`
      ) ?? overrideFor(tool.name);
    if (!override) return { server, originalName: tool.name, tool };
    if (override.name !== undefined && !TOOL_NAME.test(override.name)) {
      throw new Error(
        `${label} renames "${tool.name}" to "${override.name}", which is not a valid tool name (1-128 of A-Z a-z 0-9 _ - .).`
      );
    }
    return {
      server,
      originalName: tool.name,
      tool: {
        ...tool,
        ...(override.name !== undefined && { name: override.name }),
        ...(override.description !== undefined && {
          description: override.description,
        }),
        ...(override.inputSchema !== undefined && {
          inputSchema: override.inputSchema as Tool['inputSchema'],
        }),
      },
    };
  });

  // A rename may not take another tool's original name on the same server:
  // presented and original names never clash, so a name resolves one way.
  const originals = new Set(
    entries.map(({ server, tool }) => `${server}\u0000${tool.name}`)
  );
  for (const entry of tools) {
    const key = `${entry.server}\u0000${entry.tool.name}`;
    if (entry.tool.name !== entry.originalName && originals.has(key)) {
      throw new Error(
        `${label} renames "${entry.originalName}" to "${entry.tool.name}", which another tool${entry.server === undefined ? '' : ` on server "${entry.server}"`} already has.`
      );
    }
  }

  const byName = new Map<string, SurfaceTool>();
  for (const entry of tools) {
    const key = `${entry.server}\u0000${entry.tool.name}`;
    const other = byName.get(key);
    if (other) {
      throw new Error(
        `${label} gives "${other.originalName}" and "${entry.originalName}" the same name "${entry.tool.name}"${entry.server === undefined ? '' : ` on server "${entry.server}"`}.`
      );
    }
    byName.set(key, entry);
  }

  return {
    tools,
    resolve(name, server) {
      return byName.get(`${server}\u0000${name}`);
    },
  };
}

// The MCP fixtures that present a surface, and how each maps a name a host
// called back to the tool's original name in the same namespace. Keyed by the
// fixture object itself: a copy (`{ ...mcp }`) is not registered.
const presentedFixtures = new WeakMap<
  object,
  (calledName: string) => string | undefined
>();

/**
 * Records that `mcp` presents a tool surface. `originalName` maps a name a host
 * called (as `mcp.listTools()` showed it) to the original tool's name in the
 * same form, or undefined for a name it doesn't know.
 */
export function registerPresentedTools(
  mcp: object,
  originalName: (calledName: string) => string | undefined
): void {
  presentedFixtures.set(mcp, originalName);
}

/**
 * Records a host's tool calls through a presented surface under the tools'
 * original names, so expectations and comparisons read the same names in
 * every arm. `rawName` keeps the name the model used.
 */
export function withOriginalToolNames<
  T extends {
    toolCalls: Array<{ name: string; rawName?: string; kind?: string }>;
    events?: Array<{ kind: string; name?: string; rawName?: string }>;
  },
>(result: T, mcp: object): T {
  const originalName = presentedFixtures.get(mcp);
  if (!originalName) return result;
  function restore<
    C extends { name?: string; rawName?: string; kind?: string },
  >(call: C): C {
    // Typed host events (skills, searches) are not calls to a tool.
    if (call.name === undefined || (call.kind ?? 'tool_call') !== 'tool_call')
      return call;
    const original = originalName!(call.name);
    return original === undefined || original === call.name
      ? call
      : { ...call, name: original, rawName: call.rawName ?? call.name };
  }
  return {
    ...result,
    toolCalls: result.toolCalls.map(restore),
    ...(result.events !== undefined && {
      events: result.events.map(restore),
    }),
  };
}
