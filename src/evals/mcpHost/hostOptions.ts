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
/** `mcpHostConfig.skills` values. */
export const HostSkillsModeSchema = z.enum(['off', 'catalog', 'preload']);

export const GenerationOptions = {
  model: z.string().min(1).optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
};

export type HostEnvironment = Record<string, string | undefined>;

/** Read execution-local credentials without mutating the parent process. */
export function hostEnvironment(
  input: { env?: HostEnvironment },
  context: { env?: HostEnvironment }
): HostEnvironment {
  return { ...process.env, ...context.env, ...input.env };
}
