import type { Tool } from '@modelcontextprotocol/client';
import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import { isReadOnlyTool } from '../../proxy/plannedWrite.js';
import { checkMcpServers } from '../mcpReadiness.js';
import type { ClaudeTranscript } from './transcript.js';

/** Expected identity on a one-time managed Desktop permission card. No arguments or credentials. */
export interface ReadOnlyApproval {
  id: string;
  server: string;
  titles: string[];
}

/**
 * `approved` may be clicked once. `denied` is a pending call that is not a
 * verified read. `pending` means the audit or catalog is not ready yet, so
 * the caller waits and asks again.
 */
export type ReadOnlyApprovalVerdict =
  | { status: 'approved'; approval: ReadOnlyApproval }
  | { status: 'denied' }
  | { status: 'pending' };

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
 * Cache a grant or a tool that is present and not a safe read. A failed or
 * incomplete catalog stays uncached so the next poll can try again. */
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
    | {
        id: string;
        tool: string;
        verdict: ReadOnlyApprovalVerdict;
      }
    | undefined;
  return async (
    transcript?: ClaudeTranscript
  ): Promise<ReadOnlyApprovalVerdict> => {
    const request = transcript?.pendingToolPermission;
    if (!request || transcript?.isComplete !== false)
      return { status: 'pending' };
    if (previous?.id === request.id && previous.tool === request.tool)
      return previous.verdict;
    const matches = selected.filter((s) =>
      request.tool.startsWith(`mcp__${s.label}__`)
    );
    const deny = (): ReadOnlyApprovalVerdict => {
      const verdict: ReadOnlyApprovalVerdict = { status: 'denied' };
      previous = { id: request.id, tool: request.tool, verdict };
      return verdict;
    };
    if (matches.length !== 1) return deny();
    const server = matches[0]!;
    const name = request.tool.slice(`mcp__${server.label}__`.length);
    if (overridesRead(resolve(server), name)) return deny();
    const ms = Math.min(30000, deadlineAt - Date.now());
    if (ms <= 0) return { status: 'pending' };
    let allowed: string[] = [];
    let catalogComplete = false;
    const [ready] = await checkMcpServers(
      [{ ...server, connectTimeoutMs: ms }],
      (s) => ({ ...resolve(s), connectTimeoutMs: ms }),
      ms,
      (_, catalog) => {
        catalogComplete = true;
        const matching = catalog.filter((t) => t.name === name);
        if (matching.length !== 1 || !isReadOnlyTool(matching[0])) return;
        const ambiguous = new Set(
          catalog.filter((t) => t.name !== name).flatMap(titles)
        );
        allowed = titles(matching[0]!).filter((title) => !ambiguous.has(title));
      }
    );
    // An empty complete catalog is a missing tool, not a connection failure.
    if (
      !catalogComplete ||
      !ready ||
      ready.status !== 'connected' ||
      ready.error
    )
      return { status: 'pending' };
    if (!allowed.length) return deny();
    const verdict: ReadOnlyApprovalVerdict = {
      status: 'approved',
      approval: { id: request.id, server: server.label, titles: allowed },
    };
    previous = { id: request.id, tool: request.tool, verdict };
    return verdict;
  };
}
