/**
 * The planned-write result: what the dry-run proxy returns for a write it did
 * not send, and the rule that makes a tool a write. Its own module so the
 * evals entry, which exports the key, doesn't bundle the proxy.
 */

/** A tool as `tools/list` returns it, as far as the rule reads it. */
interface AnnotatedTool {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Read-only means readOnlyHint true and destructiveHint not true. */
export function isReadOnlyTool(tool: AnnotatedTool | undefined): boolean {
  const annotations = tool?.annotations;
  if (!annotations) return false;
  return (
    annotations.readOnlyHint === true && annotations.destructiveHint !== true
  );
}

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
