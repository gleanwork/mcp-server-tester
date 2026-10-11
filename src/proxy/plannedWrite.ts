/**
 * The planned-write result: what the dry-run proxy returns for a write it did
 * not send. Its own module so the evals entry, which exports the key, doesn't
 * bundle the proxy.
 */

/** The key of a planned-write result: what the client asked to do, not done. */
export const PLANNED_WRITE_KEY = '_mst_planned_write';

/** The result a client gets for a write the proxy did not send. */
export function plannedWriteResult(
  server: string,
  toolName: string,
  args: unknown,
  aliases: readonly string[] = []
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const planned = { server, tool_name: toolName, arguments: args ?? {} };
  const envelope: Record<string, unknown> = { [PLANNED_WRITE_KEY]: planned };
  for (const alias of aliases) envelope[alias] = planned;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}
