import { z } from 'zod';

/**
 * `clientOptions.reasoningEffort`: one list of values for every client that
 * takes it (ADR 0011), from least to most effort. Each client accepts the
 * values of this list its product supports.
 */
export const REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type Efforts = readonly [ReasoningEffort, ...ReasoningEffort[]];

/** The values the Codex CLI (`codex-cli`) accepts. */
export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies Efforts;

/** The values the ChatGPT desktop app (`chatgpt`, `codex-app`) accepts. */
export const CHATGPT_APP_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies Efforts;

export type ChatgptAppReasoningEffort =
  (typeof CHATGPT_APP_REASONING_EFFORTS)[number];

/**
 * Why `value` isn't a reasoning effort `client` accepts: a value of the
 * list it doesn't support, or one that isn't in the list.
 */
function reasoningEffortIssue(
  client: string,
  accepted: Efforts,
  value: unknown
): string {
  const values = accepted.join(', ');
  // Backticks, not quotes, which an error that quotes this would escape.
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  return (REASONING_EFFORTS as readonly unknown[]).includes(value)
    ? `${client} doesn't support reasoningEffort \`${shown}\`: it accepts ${values}.`
    : `Unknown reasoningEffort \`${shown}\`: the values are ${REASONING_EFFORTS.join(', ')}, and ${client} accepts ${values}.`;
}

/**
 * `reasoningEffort` in `client`'s options schema: the values of
 * `REASONING_EFFORTS` it accepts, and what it accepts in its description,
 * which `mst clients show` prints.
 */
export function reasoningEffortOption<const T extends Efforts>(
  client: string,
  accepted: T
) {
  return z
    .enum(accepted, {
      error: (issue) => reasoningEffortIssue(client, accepted, issue.input),
    })
    .optional()
    .describe(
      `How hard the model reasons. ${client} accepts ${accepted.join(', ')}, of ${REASONING_EFFORTS.join(', ')}.`
    );
}
