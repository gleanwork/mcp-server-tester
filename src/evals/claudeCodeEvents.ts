import type { HostEvent } from './evalFrameworkTypes.js';
import type { LLMToolCall } from './mcpHost/mcpHostTypes.js';

/** A tool a host's tool search surfaced. */
export type SurfacedTool = NonNullable<HostEvent['results']>[number];

// An MCP tool name in text, as Claude Code writes them.
const MCP_TOOL_IN_TEXT = /mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_.-]+/g;

/**
 * Splits Claude Code's `mcp__<server>__<tool>` name. The server is the part
 * before the first `__` after the prefix, so a tool name may contain `__`.
 * Every Claude parser splits names this way, so searches and calls agree.
 */
export function splitClaudeMcpName(
  raw: string
): { server: string; name: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(raw);
  return match ? { server: match[1]!, name: match[2]! } : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The tools a tool search returned, from its result: `tool_reference` blocks
 * (`tool_name`), or any `mcp__<server>__<tool>` name in the result text.
 */
export function surfacedTools(output: string | undefined): SurfacedTool[] {
  if (!output) return [];
  const found = new Map<string, SurfacedTool>();
  const add = (name: string) => {
    const tool: SurfacedTool = splitClaudeMcpName(name) ?? { name };
    found.set(`${tool.server ?? ''}\u0000${tool.name}`, tool);
  };
  let referenced = false;
  try {
    const parsed: unknown = JSON.parse(output);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const block of blocks) {
      if (typeof block === 'string') add(block);
      else if (block && typeof block === 'object') {
        const name = text((block as Record<string, unknown>).tool_name);
        if (name) {
          add(name);
          referenced = true;
        }
      }
    }
  } catch {
    // Not JSON: read MCP tool names from the text.
  }
  // Without tool references, read MCP tool names from the text; a name that
  // ends a sentence keeps its full stop out.
  if (!referenced) {
    for (const match of output.matchAll(MCP_TOOL_IN_TEXT))
      add(match[0].replace(/\.+$/, ''));
  }
  return [...found.values()];
}

/**
 * Types a Claude Code host-native tool call (Claude CLI, Cowork) as the event
 * it is: `Skill` loads a skill, `SlashCommand` runs a command, `Task` and
 * `Agent` start a subagent, and `ToolSearch` searches the tool catalog. MCP
 * calls and other host tools stay tool calls. Call it once the call's result
 * is attached, since a tool search's results come from it.
 */
export function typeClaudeCodeCall(call: LLMToolCall): LLMToolCall {
  if (call.source !== 'host' || call.kind !== undefined) return call;
  const input = call.arguments ?? {};
  switch (call.name) {
    case 'Skill': {
      const skill = text(input.skill) ?? text(input.command);
      return skill ? { ...call, kind: 'skill', name: skill } : call;
    }
    case 'SlashCommand': {
      // `/review-pr 123` runs `/review-pr`; the arguments stay in `arguments`.
      const command = text(input.command)?.split(/\s+/)[0];
      return command ? { ...call, kind: 'command', name: command } : call;
    }
    case 'Task':
    case 'Agent':
      return {
        ...call,
        kind: 'subagent',
        name: text(input.subagent_type) ?? call.name,
      };
    case 'ToolSearch':
      return {
        ...call,
        kind: 'tool_search',
        results: surfacedTools(call.output),
      };
    default:
      return call;
  }
}
