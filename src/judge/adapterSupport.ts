/** Shared plumbing for judge completion adapters. */

/** Output token budget for a judge verdict, unless configured. */
export const DEFAULT_JUDGE_MAX_TOKENS = 1000;
/** Judges are deterministic unless configured otherwise. */
export const DEFAULT_JUDGE_TEMPERATURE = 0;
/** The Claude model Anthropic-family judges use unless configured. */
export const DEFAULT_CLAUDE_JUDGE_MODEL = 'claude-sonnet-4-20250514';

/**
 * Loads a judge's optional SDK. Pass the import as a thunk with a literal
 * specifier (`() => import('openai')`) so bundlers and `vi.mock` see it;
 * the SDK stays an optional dependency until a judge actually runs.
 *
 * @typeParam Sdk - The minimal module shape the adapter reads.
 */
export async function loadJudgeSdk<Sdk>(
  load: () => Promise<unknown>,
  judge: string,
  packageName: string
): Promise<Sdk> {
  try {
    return (await load()) as Sdk;
  } catch (cause) {
    throw new Error(
      `${judge} judge requires the \`${packageName}\` package. ` +
        `Install it with: npm install ${packageName}\n` +
        `Original error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

/** Reads the API key a judge needs, or throws naming the variable to set. */
export function requireJudgeApiKey(judge: string, envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey)
    throw new Error(
      `${judge} judge requires an API key. Set the ${envVar} environment variable.`
    );
  return apiKey;
}
