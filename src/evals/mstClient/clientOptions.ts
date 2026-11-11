import { z } from 'zod';

export const ProviderSchema = z.enum([
  'openai',
  'anthropic',
  'azure',
  'google',
  'mistral',
  'deepseek',
  'openrouter',
  'xai',
  'vertex-anthropic',
]);
/** `clientOptions.skills` values. */
export const ClientSkillsModeSchema = z.enum(['off', 'catalog', 'preload']);

/**
 * Defaults shared by runtime resolution and the client options catalogue.
 * The model depends on the provider: `defaultApiModel` in
 * `src/llm/modelDefaults.ts`.
 */
export const API_CLIENT_DEFAULTS = {
  provider: 'anthropic',
  maxToolCalls: 5,
  temperature: 0,
  skills: 'off',
} as const;
export const CLAUDE_CODE_DEFAULTS = {
  timeout: 180_000,
  provider: 'anthropic',
  isolate: true,
} as const;

export const GenerationOptions = {
  model: z.string().min(1).optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
};

/**
 * Instructions the client adds to its system prompt, such as an
 * organisation's instructions. Only clients that can apply it accept it.
 */
export const SystemPromptOption = z.string().min(1).optional().meta({
  'x-defaultDescription': 'not set (no additional instructions)',
});

export type ClientEnvironment = Record<string, string | undefined>;

/** Read execution-local credentials without mutating the parent process. */
export function clientEnvironment(
  input: { env?: ClientEnvironment },
  context: { env?: ClientEnvironment }
): ClientEnvironment {
  return { ...process.env, ...context.env, ...input.env };
}
