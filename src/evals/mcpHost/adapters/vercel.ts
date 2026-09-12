/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment */
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
  MCPHostConfig,
  MCPHostSimulationResult,
  MCPHostSimulator,
  LLMProvider,
  LLMToolCall,
} from '../mcpHostTypes.js';
import type { UsageMetrics } from '../../../types/index.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { extractText } from '../../../mcp/response.js';
import { z } from 'zod';
import {
  GenerationOptions,
  ProviderSchema,
  type HostEnvironment,
} from '../hostOptions.js';

const SdkConfigSchema = z
  .object({
    hostType: z.literal('sdk').optional(),
    provider: ProviderSchema,
    ...GenerationOptions,
    apiKeyEnvVar: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict();

/**
 * Classifies a raw error from the Vercel AI SDK agentic loop and returns a
 * human-readable message with an actionable hint.
 *
 * The message is always prefixed with "MCP host simulation failed: " so that
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
      `MCP host simulation failed: required package not installed.\n` +
      `Hint: run \`getMissingDependencyMessage('${provider}')\` or check docs/mcp-host.md for install instructions.`
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
      `MCP host simulation failed: authentication error.\n` +
      `Hint: check your API key environment variable (e.g. ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS).`
    );
  }

  // 404 / not-found: the SDK collapses several distinct causes here — a wrong
  // or retired model id, or a base-URL override routing to a gateway that
  // doesn't serve the model. Preserve the raw error instead of guessing.
  if (
    raw.includes('404') ||
    raw.includes('Not Found') ||
    (raw.toLowerCase().includes('model') &&
      raw.toLowerCase().includes('not found'))
  ) {
    return (
      `MCP host simulation failed: ${raw}\n` +
      `Hint: a 404 usually means the model id is wrong or retired, or a ` +
      `base-URL override (e.g. ANTHROPIC_BASE_URL / OPENAI_BASE_URL pointing ` +
      `at a gateway) is routing requests somewhere that doesn't serve this ` +
      `model. Verify the model id and that no unexpected *_BASE_URL is set.`
    );
  }

  // Network / DNS / connection errors
  if (
    raw.includes('ENOTFOUND') ||
    raw.includes('fetch failed') ||
    raw.includes('ECONNREFUSED')
  ) {
    return (
      `MCP host simulation failed: network error.\n` +
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
      `MCP host simulation failed: rate limited.\n` +
      `Hint: reduce concurrency, add delays between iterations, or upgrade your API plan.`
    );
  }

  // Default: preserve original message with a consistent prefix
  return `MCP host simulation failed: ${raw}`;
}

// Dynamic import helper bypasses TypeScript module resolution for optional peer deps.
// Each @ai-sdk/* package is optional — install only the providers you need.
async function loadModel(
  provider: LLMProvider,
  model: string,
  config: MCPHostConfig
): Promise<any> {
  const env: HostEnvironment = { ...process.env, ...config.env };
  function apiKey(defaultName: string): string {
    return env[config.apiKeyEnvVar ?? defaultName] ?? '';
  }
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        apiKey: apiKey('OPENAI_API_KEY'),
        baseURL: env.OPENAI_BASE_URL,
      })(model);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey: apiKey('ANTHROPIC_API_KEY'),
        baseURL: env.ANTHROPIC_BASE_URL,
      })(model);
    }
    case 'vertex-anthropic': {
      // Anthropic via Google Vertex AI — uses Application Default Credentials.
      // Required env vars: GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION
      // Install: npm install @ai-sdk/google-vertex
      // Use this instead of 'anthropic' when api.anthropic.com is not reachable.
      const { createVertexAnthropic } =
        await import('@ai-sdk/google-vertex/anthropic');
      const vertexAnthropic = createVertexAnthropic({
        project: env.GOOGLE_VERTEX_PROJECT,
        location: env.GOOGLE_VERTEX_LOCATION ?? 'us-east5',
        googleAuthOptions: env.GOOGLE_APPLICATION_CREDENTIALS
          ? { keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS }
          : undefined,
      });
      return (vertexAnthropic as unknown as (m: string) => unknown)(model);
    }
    case 'google': {
      // @ts-ignore - optional: npm install @ai-sdk/google
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({
        apiKey: apiKey('GOOGLE_GENERATIVE_AI_API_KEY'),
      })(model);
    }
    case 'mistral': {
      // @ts-ignore - optional: npm install @ai-sdk/mistral
      const { createMistral } = await import('@ai-sdk/mistral');
      return createMistral({ apiKey: apiKey('MISTRAL_API_KEY') })(model);
    }
    case 'azure': {
      // @ts-ignore - optional: npm install @ai-sdk/azure
      const { createAzure } = await import('@ai-sdk/azure');
      return createAzure({
        apiKey: apiKey('AZURE_API_KEY'),
        resourceName: env.AZURE_RESOURCE_NAME,
        baseURL: env.AZURE_BASE_URL,
      })(model);
    }
    case 'deepseek': {
      // @ts-ignore - optional: npm install @ai-sdk/deepseek
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      return createDeepSeek({ apiKey: apiKey('DEEPSEEK_API_KEY') })(model);
    }
    case 'openrouter': {
      // @ts-ignore - optional: npm install @openrouter/ai-sdk-provider
      const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
      return createOpenRouter({ apiKey: apiKey('OPENROUTER_API_KEY') })(model);
    }
    case 'xai': {
      // @ts-ignore - optional: npm install @ai-sdk/xai
      const { createXai } = await import('@ai-sdk/xai');
      return createXai({ apiKey: apiKey('XAI_API_KEY') })(model);
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
 * Creates a Vercel AI SDK-based MCP host simulator.
 *
 * Uses generateText with stopWhen (ai v6) to handle multi-turn tool calling.
 * Produces llmDurationMs and mcpDurationMs for latency decomposition.
 */
export function createVercelOrchestrator(): MCPHostSimulator {
  return {
    async simulate(
      mcp: MCPFixtureApi,
      scenario: string,
      config: MCPHostConfig,
      signal?: AbortSignal
    ): Promise<MCPHostSimulationResult> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortFromHost: (() => void) | undefined;
      const allToolCalls: LLMToolCall[] = [];
      let expired: Promise<never>;
      function withinDeadline<T>(promise: Promise<T>): Promise<T> {
        return Promise.race([promise, expired]);
      }
      try {
        SdkConfigSchema.parse(config);
        expired = new Promise<never>((_, reject) => {
          if (signal) {
            abortFromHost = function abortFromHost() {
              const reason: unknown = signal.reason;
              const error =
                reason instanceof Error
                  ? reason
                  : new Error(
                      typeof reason === 'string' ? reason : 'SDK host aborted.'
                    );
              controller.abort(error);
              reject(error);
            };
            signal.addEventListener('abort', abortFromHost, { once: true });
            if (signal.aborted) abortFromHost();
          } else if (config.timeout !== undefined)
            timer = setTimeout(() => {
              const error = new Error(
                `SDK host timed out after ${config.timeout} ms.`
              );
              controller.abort(error);
              reject(error);
            }, config.timeout);
        });
        const { generateText, stepCountIs } = await withinDeadline(
          import('ai')
        );
        // jsonSchema from @ai-sdk/provider-utils creates a proper Schema object
        // (with .jsonSchema property) that ai's prepareToolsAndToolChoice can read.
        // Do NOT use jsonSchema from 'ai' — in v6 it produces the wrong shape.
        const { jsonSchema } = await withinDeadline(
          import('@ai-sdk/provider-utils')
        );

        if (!config.provider) {
          throw new Error('provider is required for SDK host type');
        }

        const modelId = config.model ?? defaultModel(config.provider);
        const model = await withinDeadline(
          loadModel(config.provider, modelId, config)
        );

        // Get available MCP tools and wrap them for Vercel AI SDK
        const mcpTools = await withinDeadline(mcp.listTools());
        let mcpDurationMs = 0;
        let attemptedToolCalls = 0;
        let budgetError: Error | undefined;

        // Build tool definitions in Vercel AI SDK format.
        // Uses any because the tool() generic requires inferred parameter types
        // which aren't available from MCP's JSON Schema at compile time.
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
          const encodedName = toolName.replaceAll('.', '__');
          if (tools[encodedName])
            throw new Error(`Duplicate encoded tool name: ${encodedName}`);
          tools[encodedName] = {
            description: mcpTool.description ?? '',
            inputSchema: jsonSchema(rawSchema),
            execute: async (
              args: Record<string, unknown>,
              opts?: { toolCallId?: string }
            ) => {
              if (controller.signal.aborted) throw controller.signal.reason;
              if (attemptedToolCalls >= (config.maxToolCalls ?? 10)) {
                budgetError = new Error(
                  `Tool call budget exhausted (${config.maxToolCalls ?? 10}).`
                );
                throw budgetError;
              }
              attemptedToolCalls++;
              const mcpStart = Date.now();
              const result = await withinDeadline(mcp.callTool(toolName, args));
              mcpDurationMs += Date.now() - mcpStart;

              const output = extractText(result);
              allToolCalls.push({
                id: opts?.toolCallId,
                name: toolName,
                source: 'mcp',
                rawName: encodedName,
                arguments: args,
                output,
              });
              return output;
            },
          };
        }

        const maxSteps = config.maxToolCalls ?? 10;
        const llmStart = Date.now();

        const result = await withinDeadline(
          generateText({
            model,
            prompt: scenario,
            tools,
            stopWhen: stepCountIs(Math.max(1, maxSteps)),
            temperature: config.temperature ?? 0,
            maxOutputTokens: config.maxTokens,
            abortSignal: controller.signal,
          })
        );
        if (budgetError) throw budgetError;

        const totalDurationMs = Date.now() - llmStart;
        const llmDurationMs = totalDurationMs - mcpDurationMs;

        const usage = result.totalUsage ?? result.usage;
        const hostUsage: UsageMetrics | undefined = usage
          ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalCostUsd: 0,
              durationMs: llmDurationMs,
            }
          : undefined;

        const conversationHistory: Array<{
          role: 'tool' | 'assistant';
          content?: string;
          toolCallId?: string;
        }> = (result.steps ?? []).flatMap<{
          role: 'tool' | 'assistant';
          content?: string;
          toolCallId?: string;
        }>((step) => {
          if (step.toolCalls?.length > 0) {
            // Reference each call by id; the payload lives once on allToolCalls.
            return (step.toolCalls as Array<{ toolCallId?: string }>).map(
              (tc) => ({
                role: 'tool' as const,
                toolCallId: tc.toolCallId,
              })
            );
          }
          return step.text
            ? [{ role: 'assistant' as const, content: step.text as string }]
            : [];
        });

        return {
          success: true,
          toolCalls: allToolCalls,
          response: result.text as string,
          scenario,
          llmDurationMs,
          mcpDurationMs,
          conversationHistory,
          usage: hostUsage,
        };
      } catch (err) {
        return {
          success: false,
          toolCalls: allToolCalls,
          error: enrichErrorMessage(err, config.provider ?? 'unknown'),
        };
      } finally {
        clearTimeout(timer);
        if (abortFromHost) signal?.removeEventListener('abort', abortFromHost);
        controller.abort();
      }
    },
  };
}
