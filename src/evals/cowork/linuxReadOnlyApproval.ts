import type { Tool } from '@modelcontextprotocol/client';
import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import { isReadOnlyTool } from '../../proxy/plannedWrite.js';
import { checkMcpServers, isMcpServerReady } from '../mcpReadiness.js';
import type { ClaudeTranscript } from './transcript.js';

/** Expected identity on a one-time managed Desktop permission card. No arguments or credentials. */
export interface ReadOnlyApproval {
  id: string;
  server: string;
  titles: string[];
}

function titles(tool: Tool): string[] {
  const words = tool.name.replace(/[_-]+/g, ' ');
  return [
    ...new Set(
      [
        tool.name,
        words.charAt(0).toUpperCase() + words.slice(1),
        tool.title,
        tool.annotations?.title,
      ].filter((v): v is string => !!v && v.length <= 128 && !/[\r\n]/.test(v))
    ),
  ];
}

/** A launch may classify an annotated read as a write or dispatch by argument.
 * These flags only veto approval; an unrecognized launch never grants it. */
function overridesRead(server: MCPConfig, name: string): boolean {
  return (
    server.transport === 'stdio' &&
    (server.args ?? []).some(
      (arg, i, args) =>
        (arg === '--always-write' && args[i + 1] === name) ||
        arg === `--always-write=${name}` ||
        (arg === '--dispatcher' && args[i + 1]?.startsWith(`${name}=`)) ||
        arg.startsWith(`--dispatcher=${name}=`)
    )
  );
}

/** Resolve only the server named by the bound audit, through Cowork's own launch.
 * Cache the decision for that request, never authorize from a verb or a UI label. */
export function linuxReadOnlyApprovals(
  servers: readonly MCPConfig[],
  resolve: (s: MCPConfig) => MCPConfig,
  deadlineAt: number
) {
  const selected = servers.map((s, i) => ({
    ...s,
    label: mcpServerLabel(s, i),
  }));
  let previous:
    | { id: string; tool: string; approval?: ReadOnlyApproval }
    | undefined;
  return async (
    transcript?: ClaudeTranscript
  ): Promise<ReadOnlyApproval | undefined> => {
    const request = transcript?.pendingToolPermission;
    if (!request || transcript?.isComplete !== false) return undefined;
    if (previous?.id === request.id)
      return previous.tool === request.tool ? previous.approval : undefined;
    const decision: NonNullable<typeof previous> = { ...request };
    previous = decision;
    const matches = selected.filter((s) =>
      request.tool.startsWith(`mcp__${s.label}__`)
    );
    if (matches.length !== 1) return undefined;
    const server = matches[0]!;
    const name = request.tool.slice(`mcp__${server.label}__`.length);
    const ms = Math.min(30000, deadlineAt - Date.now());
    if (ms <= 0) return undefined;
    let allowed: string[] = [];
    const [ready] = await checkMcpServers(
      [{ ...server, connectTimeoutMs: ms }],
      (s) => {
        const launch = resolve(s);
        if (overridesRead(launch, name))
          throw new Error('Tool has a write override.');
        return { ...launch, connectTimeoutMs: ms };
      },
      ms,
      (_, catalog) => {
        const matching = catalog.filter((t) => t.name === name);
        if (matching.length !== 1 || !isReadOnlyTool(matching[0])) return;
        const ambiguous = new Set(
          catalog.filter((t) => t.name !== name).flatMap(titles)
        );
        allowed = titles(matching[0]!).filter((title) => !ambiguous.has(title));
      }
    );
    if (!ready || !isMcpServerReady(ready) || !allowed.length) return undefined;
    decision.approval = {
      id: request.id,
      server: server.label,
      titles: allowed,
    };
    return decision.approval;
  };
}
