/** Shared plumbing for judge completion adapters. */
import {
  hasLLMCredential,
  type LLMApiFamily,
  type LLMEndpointOptions,
} from '../llm/endpoint.js';

/**
 * Output token budget for a judge score, unless configured. Models often
 * reason before the JSON, so the budget leaves room for both.
 */
export const DEFAULT_JUDGE_MAX_TOKENS = 4096;
/** Judges are deterministic unless configured otherwise. */
export const DEFAULT_JUDGE_TEMPERATURE = 0;
/** The Claude model Anthropic-family judges use unless configured. */
export const DEFAULT_CLAUDE_JUDGE_MODEL = 'claude-sonnet-4-6';

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

/**
 * Throws, naming what to set, unless a credential for `family` is configured
 * (an API key, a bearer token, or the gateway auth command). The credential
 * itself is resolved per call with resolveLLMEndpoint.
 */
export function requireJudgeCredential(
  judge: string,
  family: LLMApiFamily,
  options: LLMEndpointOptions
): void {
  if (hasLLMCredential(family, options)) return;
  if (options.apiKeyEnvVar !== undefined)
    throw new Error(
      `${judge} judge requires an API key. Set the ${options.apiKeyEnvVar} environment variable.`
    );
  const [apiKey, baseURL, gatewayCredentials] =
    family === 'anthropic'
      ? [
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN or MST_LLM_AUTH_COMMAND',
        ]
      : ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MST_LLM_AUTH_COMMAND'];
  throw new Error(
    `${judge} judge requires an API key. Set the ${apiKey} environment variable ` +
      `(or, for a gateway, ${baseURL} with ${gatewayCredentials}; see docs/llm-gateways.md).`
  );
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
