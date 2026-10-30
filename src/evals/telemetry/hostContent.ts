/**
 * Which of a host's telemetry attributes are content (`telemetry.host`): on
 * its own, with no Node imports, for code that redacts stored results.
 *
 * Content attributes say what the trial said, not what it did, and are kept
 * only with `content`: Claude Code's and Codex's names, and OpenTelemetry's.
 */
const CONTENT_ATTRIBUTES = new Set([
  'prompt',
  'response',
  'body',
  'content',
  'tool_input',
  'tool_parameters',
  'tool_output',
  'arguments',
  'output',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]);

/** Whether a host attribute says what the trial said (a content attribute). */
export function isHostContentAttribute(key: string): boolean {
  return CONTENT_ATTRIBUTES.has(key);
}
