/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
/**
 * Vercel AI SDK-based LLM host orchestrator.
 *
 * Replaces the custom agentic loop with generateText + stopWhen (ai v6),
 * giving access to 9 providers and built-in latency decomposition.
 *
 * Requires the `ai` package (v6+) as an optional peer dependency.
 * Additional providers require their respective @ai-sdk/* packages.
 */
import type {
  LLMHostConfig,
  LLMHostSimulationResult,
  LLMHostSimulator,
  LLMProvider,
  LLMToolCall,
} from '../llmHostTypes.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { extractText } from '../../../mcp/response.js';

/**
 * Classifies a raw error from the Vercel AI SDK agentic loop and returns a
 * human-readable message with an actionable hint.
 *
 * The message is always prefixed with "LLM host simulation failed: " so that
 * callers see a consistent error surface regardless of which failure path was
 * hit.
 */
function enrichErrorMessage(err: unknown, provider: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Missing optional peer dependency
  if (
    raw.includes('Cannot find module') ||
    raw.includes('ERR_MODULE_NOT_FOUND')
  ) {
    return (
      `LLM host simulation failed: required package not installed.\n` +
      `Hint: run \`getMissingDependencyMessage('${provider}')\` or check docs/llm-host.md for install instructions.`
    );
  }

  // Authentication / API key problems
  if (
    raw.includes('401') ||
    raw.includes('Unauthorized') ||
    raw.includes('API key') ||
    raw.includes('api_key')
  ) {
    return (
      `LLM host simulation failed: authentication error.\n` +
      `Hint: check your API key environment variable (e.g. ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS).`
    );
  }

  // Model not found (404 or explicit "model … not found" phrasing)
  if (
    raw.includes('404') ||
    raw.includes('Not Found') ||
    (raw.toLowerCase().includes('model') &&
      raw.toLowerCase().includes('not found'))
  ) {
    return (
      `LLM host simulation failed: model not found.\n` +
      `Hint: check the model name format for your provider. For vertex-anthropic use 'claude-3-5-haiku@20241022' (with @).`
    );
  }

  // Network / DNS / connection errors
  if (
    raw.includes('ENOTFOUND') ||
    raw.includes('fetch failed') ||
    raw.includes('ECONNREFUSED')
  ) {
    return (
      `LLM host simulation failed: network error.\n` +
      `Hint: check network connectivity and whether the provider's API endpoint is reachable from this machine.`
    );
  }

  // Rate limiting
  if (
    raw.includes('429') ||
    raw.toLowerCase().includes('rate limit') ||
    raw.includes('Too Many Requests')
  ) {
    return (
      `LLM host simulation failed: rate limited.\n` +
      `Hint: reduce concurrency, add delays between iterations, or upgrade your API plan.`
    );
  }

  // Default: preserve original message with a consistent prefix
  return `LLM host simulation failed: ${raw}`;
}

// Dynamic import helper bypasses TypeScript module resolution for optional peer deps.
// Each @ai-sdk/* package is optional — install only the providers you need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadModel(provider: LLMProvider, model: string): Promise<any> {
  switch (provider) {
    case 'openai': {
      const { openai } = await import('@ai-sdk/openai');
      return openai(model);
    }
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return anthropic(model);
    }
    case 'vertex-anthropic': {
      // Anthropic via Google Vertex AI — uses Application Default Credentials.
      // Required env vars: GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION
      // Install: npm install @ai-sdk/google-vertex
      // Use this instead of 'anthropic' when api.anthropic.com is not reachable.
      const { createVertexAnthropic } =
        await import('@ai-sdk/google-vertex/anthropic');
      const vertexAnthropic = createVertexAnthropic({
        project: process.env.GOOGLE_VERTEX_PROJECT,
        location: process.env.GOOGLE_VERTEX_LOCATION ?? 'us-east5',
      });
      return (vertexAnthropic as unknown as (m: string) => unknown)(model);
    }
    case 'google': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/google
      const { google } = await import('@ai-sdk/google');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (google as any)(model);
    }
    case 'mistral': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/mistral
      const { mistral } = await import('@ai-sdk/mistral');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mistral as any)(model);
    }
    case 'azure': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/azure
      const { azure } = await import('@ai-sdk/azure');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (azure as any)(model);
    }
    case 'ollama': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/ollama
      const { ollama } = await import('@ai-sdk/ollama');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (ollama as any)(model);
    }
    case 'deepseek': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/deepseek
      const { deepseek } = await import('@ai-sdk/deepseek');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (deepseek as any)(model);
    }
    case 'openrouter': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @openrouter/ai-sdk-provider
      const { openrouter } = await import('@openrouter/ai-sdk-provider');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (openrouter as any)(model);
    }
    case 'xai': {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional: npm install @ai-sdk/xai
      const { xai } = await import('@ai-sdk/xai');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (xai as any)(model);
    }
    default:
      throw new Error(
        `Unsupported Vercel AI SDK provider: ${String(provider)}`
      );
  }
}

function defaultModel(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-1.5-pro';
    case 'mistral':
      return 'mistral-large-latest';
    default:
      return 'default';
  }
}

/**
 * Creates a Vercel AI SDK-based LLM host simulator.
 *
 * Uses generateText with stopWhen (ai v6) to handle multi-turn tool calling.
 * Produces llmDurationMs and mcpDurationMs for latency decomposition.
 */
export function createVercelOrchestrator(): LLMHostSimulator {
  return {
    async simulate(
      mcp: MCPFixtureApi,
      scenario: string,
      config: LLMHostConfig
    ): Promise<LLMHostSimulationResult> {
      try {
        const { generateText, stepCountIs } = await import('ai');
        // jsonSchema from @ai-sdk/provider-utils creates a proper Schema object
        // (with .jsonSchema property) that ai's prepareToolsAndToolChoice can read.
        // Do NOT use jsonSchema from 'ai' — in v6 it produces the wrong shape.
        const { jsonSchema } = await import('@ai-sdk/provider-utils');

        const modelId = config.model ?? defaultModel(config.provider);
        const model = await loadModel(config.provider, modelId);

        // Get available MCP tools and wrap them for Vercel AI SDK
        const mcpTools = await mcp.listTools();
        let mcpDurationMs = 0;
        const allToolCalls: LLMToolCall[] = [];

        // Build tool definitions in Vercel AI SDK format.
        // Uses any because the tool() generic requires inferred parameter types
        // which aren't available from MCP's JSON Schema at compile time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // Build tool definitions using explicit inputSchema (a Schema object with .jsonSchema).
        // We bypass the tool() helper because ai v6 tool() stores schema as .parameters
        // but prepareToolsAndToolChoice reads .inputSchema — they're inconsistent in v6.
        // Using jsonSchema() from @ai-sdk/provider-utils produces the correct Schema object.
        const tools: Record<string, any> = {};
        for (const mcpTool of mcpTools) {
          const toolName = mcpTool.name;
          // Ensure type:'object' is present — Anthropic requires it, some servers omit it.
          const rawSchema = {
            type: 'object',
            ...(mcpTool.inputSchema as Record<string, unknown>),
          };
          tools[toolName] = {
            description: mcpTool.description ?? '',
            inputSchema: jsonSchema(rawSchema),
            execute: async (args: Record<string, unknown>) => {
              const mcpStart = Date.now();
              const result = await mcp.callTool(toolName, args);
              mcpDurationMs += Date.now() - mcpStart;

              allToolCalls.push({ name: toolName, arguments: args });
              return extractText(result);
            },
          };
        }

        const maxSteps = config.maxToolCalls ?? 10;
        const llmStart = Date.now();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (generateText as any)({
          model,
          prompt: scenario,
          tools,
          stopWhen: stepCountIs(maxSteps),
          temperature: config.temperature ?? 0,
          maxTokens: config.maxTokens,
        });

        const totalDurationMs = Date.now() - llmStart;
        const llmDurationMs = totalDurationMs - mcpDurationMs;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conversationHistory = (result.steps ?? []).map((step: any) => ({
          role: (step.toolCalls?.length > 0 ? 'tool' : 'assistant') as
            | 'tool'
            | 'assistant',
          content:
            step.toolCalls?.length > 0
              ? JSON.stringify(step.toolResults)
              : (step.text ?? ''),
        }));

        return {
          success: true,
          toolCalls: allToolCalls,
          response: result.text as string,
          scenario,
          llmDurationMs,
          mcpDurationMs,
          conversationHistory,
        };
      } catch (err) {
        return {
          success: false,
          toolCalls: [],
          error: enrichErrorMessage(err, config.provider),
        };
      }
    },
  };
}
