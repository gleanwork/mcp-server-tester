/**
 * The tool-surface proxy's interface, and the eval's side of using it: which
 * clients get it, and how their traces are settled. The proxy itself is in
 * toolSurfaceProxyServer.ts, so bundles that only settle traces don't carry an
 * HTTP and MCP server.
 */
import type { MCPConfig } from '../config/mcpConfig.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
} from './evalFrameworkTypes.js';

/** A tool call the proxy forwarded, under the tool's original name. */
interface ProxiedToolCall {
  server?: string;
  /** The tool's name on its server. */
  name: string;
  /** The name the host called, when the variant renamed the tool. */
  rawName?: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  startedAt: string;
  durationMs: number;
}

/** What one scope's (one client request's) traffic did through the proxy. */
export interface ToolSurfaceProxyActivity {
  /**
   * The client listed tools from a proxied server (always true when no server
   * has tools, since there is nothing to list).
   */
  listedTools: boolean;
  calls: ProxiedToolCall[];
}

/**
 * Serves a variant's servers with its tool variant applied, for clients that
 * connect to servers themselves (plugin clients, the Claude CLI). Each upstream
 * server gets a loopback Streamable HTTP endpoint with the same label; each
 * client request gets its own scope, so the eval can tell whether the client saw
 * the variant. The proxy holds one connection to each server for the variant.
 */
export interface ToolSurfaceProxy {
  /** Server configs for one client request, pointing at the proxy. */
  serversFor(scope: string): MCPConfig[];
  /** The scope's traffic so far. */
  activity(scope: string): ToolSurfaceProxyActivity;
  /** The scope's traffic, after which the proxy forgets the scope. */
  endScope(scope: string): ToolSurfaceProxyActivity;
  /** The original name behind a presented tool name on a server. */
  originalName(name: string, server?: string): string | undefined;
  close(): Promise<void>;
}

/**
 * Whether the eval gives a client a variant's tool metadata through the proxy:
 * clients that run cases themselves and don't apply variants, unless they opt
 * out with `toolSurfaceProxy: false`.
 */
export function usesToolSurfaceProxy(definition: ClientDefinition): boolean {
  return (
    definition.toolMetadata !== true &&
    definition.toolSurfaceProxy !== false &&
    (typeof definition.run === 'function' ||
      typeof definition.runBatch === 'function')
  );
}

/** A proxied client's context: the proxy applies the variant, not the client. */
export function withoutToolVariant(
  context: ClientRunContext
): ClientRunContext {
  const { tools: _configTools, ...evalConfig } = context.evalConfig;
  if (!context.variant) return { ...context, evalConfig };
  const { tools: _variantTools, ...variant } = context.variant;
  return { ...context, evalConfig, variant };
}

/**
 * Settles one proxied client request. A client that never listed the proxied
 * tools never showed the model the variant, so its trace becomes an error
 * rather than a result for a variant it ignored. Tool calls the client reports
 * are recorded under the tools' original names, with the client's in `rawName`.
 */
export function settleProxiedTrace(
  trace: ClientRunResult,
  proxy: ToolSurfaceProxy,
  listedTools: boolean,
  servers: readonly MCPConfig[],
  variantId: string
): ClientRunResult {
  if (!trace.error && !listedTools) {
    return {
      ...trace,
      error: `The client never listed tools from the servers it was given, so the model didn't see tool variant "${variantId}". Variants reach clients that connect to input.servers.`,
    };
  }
  return {
    ...trace,
    events: trace.events.map((event) => {
      if (event.kind === 'tool_search' && event.results) {
        // A search shows the variant's names; record the tools it found.
        return {
          ...event,
          results: event.results.map((tool) => {
            const original =
              proxy.originalName(tool.name, tool.server) ??
              (servers.length === 1
                ? proxy.originalName(tool.name, servers[0]!.label)
                : undefined);
            return original === undefined ? tool : { ...tool, name: original };
          }),
        };
      }
      if (event.kind !== 'tool_call' || event.source !== 'mcp') return event;
      // Clients name a call's server in `server`, as a `label.` prefix, or
      // (with one server) not at all.
      let server = event.server;
      let name = event.name;
      let prefix = '';
      if (server === undefined) {
        const qualified = servers.find(
          ({ label }) => label !== undefined && name.startsWith(`${label}.`)
        )?.label;
        if (qualified !== undefined && servers.length > 1) {
          server = qualified;
          prefix = `${qualified}.`;
          name = name.slice(prefix.length);
        }
      }
      const original =
        proxy.originalName(name, server) ??
        (servers.length === 1
          ? proxy.originalName(name, servers[0]!.label)
          : undefined);
      return original === undefined || original === name
        ? event
        : {
            ...event,
            name: `${prefix}${original}`,
            rawName: event.rawName ?? event.name,
          };
    }),
  };
}
