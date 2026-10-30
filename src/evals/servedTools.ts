import type { Tool } from '@modelcontextprotocol/client';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import type { ListedServerTools } from './toolSurface.js';

/** A run's servers served other tool metadata than it was told to expect. */
export class ServedToolsChangedError extends Error {
  override name = 'ServedToolsChangedError';
}

/** Pages of tools/list MST reads from one server before it gives up. */
const MAX_PAGES = 50;

/**
 * The tools each server serves, before any variant's tool metadata: one
 * connection per server, every page of tools/list, closed again. A server
 * that doesn't declare tools serves none.
 */
export async function listServedTools(
  servers: readonly MCPConfig[]
): Promise<ListedServerTools[]> {
  const listed: ListedServerTools[] = [];
  for (const config of servers) {
    const client = await createMCPClientForConfig(config);
    try {
      const capabilities = (client.getServerCapabilities() ?? {}) as Record<
        string,
        unknown
      >;
      const tools: Tool[] = [];
      if ('tools' in capabilities) {
        const timeout = config.requestTimeoutMs;
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await client.listTools(
            cursor ? { cursor } : undefined,
            timeout !== undefined ? { timeout } : undefined
          );
          tools.push(...result.tools);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
      }
      listed.push({
        ...(config.label !== undefined ? { server: config.label } : {}),
        tools,
      });
    } finally {
      await closeMCPClient(client);
    }
  }
  return listed;
}

/** The metadata of one tool a variant's tool metadata can replace, plus its name. */
function toolMetadataKey(tool: Tool): string {
  return JSON.stringify({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
  });
}

/** Each served tool's metadata, keyed by server and name, labelled for messages. */
function indexTools(
  listed: readonly ListedServerTools[]
): Map<string, { label: string; key: string }> {
  return new Map(
    listed.flatMap(({ server, tools }) =>
      tools.map((tool) => [
        `${server ?? ''}\u0000${tool.name}`,
        {
          label:
            listed.length > 1 && server ? `${server}.${tool.name}` : tool.name,
          key: toolMetadataKey(tool),
        },
      ])
    )
  );
}

/**
 * How the servers' tool metadata changed between two listings, in words, or
 * undefined when it didn't. Only what reaches the model's choice of tool
 * counts (name, title, description, input schema): annotations, output
 * schemas and `_meta` don't.
 */
export function servedToolsChange(
  before: readonly ListedServerTools[],
  after: readonly ListedServerTools[]
): string | undefined {
  const was = indexTools(before);
  const now = indexTools(after);
  const added = [...now.keys()].filter((key) => !was.has(key));
  const removed = [...was.keys()].filter((key) => !now.has(key));
  const changed = [...now.keys()].filter(
    (key) => was.has(key) && was.get(key)!.key !== now.get(key)!.key
  );
  const parts = [
    added.length &&
      `added ${added.map((key) => now.get(key)!.label).join(', ')}`,
    removed.length &&
      `removed ${removed.map((key) => was.get(key)!.label).join(', ')}`,
    changed.length &&
      `changed ${changed.map((key) => now.get(key)!.label).join(', ')}`,
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : undefined;
}
