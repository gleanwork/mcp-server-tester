import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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

/** Overrides use canonical server.tool names, never provider-encoded names.
 * Bare names are allowed only when unambiguous; qualified overrides take priority.
 */
export function overrideHostTools<T extends Tool & { server?: string }>(
  tools: T[],
  overrides?: {
    tools: Record<
      string,
      { description?: string; inputSchema?: Record<string, unknown> }
    >;
  }
): T[] {
  for (const key of Object.keys(overrides?.tools ?? {})) {
    const matches = tools.filter(
      (tool) => key === tool.name || key === `${tool.server}.${tool.name}`
    );
    if (matches.length !== 1)
      throw new Error(
        `${matches.length ? 'Ambiguous' : 'Unknown'} tool override: ${key}`
      );
  }
  return tools.map((tool) => {
    const override =
      overrides?.tools[`${tool.server}.${tool.name}`] ??
      overrides?.tools[tool.name];
    return override
      ? {
          ...tool,
          ...override,
          inputSchema: (override.inputSchema ??
            tool.inputSchema) as Tool['inputSchema'],
        }
      : tool;
  });
}
