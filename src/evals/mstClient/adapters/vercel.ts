/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment */
/**
 * Vercel AI SDK-based LLM client orchestrator.
 *
 * Replaces the custom agentic loop with generateText + stopWhen (ai v6),
 * giving access to 9 providers and built-in latency decomposition.
 *
 * Requires the `ai` package (v6+) as an optional peer dependency.
 * Additional providers require their respective @ai-sdk/* packages.
 */
import type {
  MstClientConfig,
  MstClientSimulationResult,
  MstClientSimulator,
  LLMProvider,
  LLMToolCall,
} from '../types.js';
import type { UsageMetrics } from '../../../types/index.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { extractText } from '../../../mcp/response.js';
import type { ModelCall, TraceEvent } from '../../evalFrameworkTypes.js';
import {
  createClientSkillsSession,
  HOST_SKILL_TOOL_NAMES,
  withSkillEvents,
  type ClientSkillsSession,
} from '../skills.js';
import type * as AI from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { resolveLLMEndpoint } from '../../../llm/endpoint.js';
import type { TrialEnding } from '../../../types/trialEnding.js';
import {
  TRIAL_ENDING,
  contextOverflowEnding,
  infrastructureEnding,
} from '../../trialEnding.js';
import {
  GenerationOptions,
  ProviderSchema,
  type ClientEnvironment,
  ClientSkillsModeSchema,
  SystemPromptOption,
} from '../clientOptions.js';

const SdkConfigSchema = z
  .object({
    clientType: z.literal('sdk').optional(),
    provider: ProviderSchema,
    ...GenerationOptions,
    apiKeyEnvVar: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    skills: ClientSkillsModeSchema.optional(),
    systemPrompt: SystemPromptOption,
  })
  .strict();

/** A failed simulation's message, and how its attempt ended. */
interface SdkFailure {
  message: string;
  ending: TrialEnding;
}

/**
 * Classifies a raw error from the Vercel AI SDK agentic loop: a
 * human-readable message with an actionable hint, and how the attempt ended
 * (ADR 0010). The provider reports these only as text and status codes, so
 * this is the one place they are read. `acted` says whether the model had
 * answered at least once, which decides what running out of context means.
 */
function sdkFailure(
  thrown: unknown,
  provider: string,
  acted: boolean
): SdkFailure {
  // The AI SDK retries a retryable provider error, then throws a RetryError
  // around the last one: read that one. Its message keeps the attempts.
  const err = lastRetriedError(thrown) ?? thrown;
  const raw = errorText(thrown);
  // APICallError carries the HTTP status separately from its message, which
  // is often the provider's own text ("Bearer token required").
  const statusCode =
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : null;
  // A status code is the provider's answer: the message is read only when
  // there is none. The message can quote anything (a tool result, a model
  // id, "API key" in a 400's explanation), so it never overrides a status.
  const lower = raw.toLowerCase();
  const says = (
    status: (code: number) => boolean,
    words: (text: string, lowered: string) => boolean
  ): boolean => (statusCode !== null ? status(statusCode) : words(raw, lower));

  // Missing optional peer dependency
  if (
    raw.includes('Cannot find module') ||
    raw.includes('ERR_MODULE_NOT_FOUND')
  ) {
    const message =
      `The mst client failed: required package not installed.\n` +
      `Hint: run \`getMissingDependencyMessage('${provider}')\` or check docs/mst-client.md for install instructions.`;
    return {
      message,
      ending: infrastructureEnding('setup', message, false),
    };
  }

  // The model's context ran out: before it answered, the case's prompt
  // didn't fit; after, its own turns and tool results filled it.
  if (CONTEXT_OVERFLOW.test(`${raw} ${responseBody(err)}`)) {
    const message = `client simulation failed: ${raw}`;
    return { message, ending: contextOverflowEnding(message, acted) };
  }

  // Authentication / API key problems
  if (
    says(
      (code) => code === 401 || code === 403,
      (text) =>
        text.includes('401') ||
        text.includes('Unauthorized') ||
        text.includes('API key') ||
        text.includes('api_key')
    )
  ) {
    const message =
      `client simulation failed: authentication error (${raw}).\n` +
      `Hint: ${AUTH_HINTS[provider] ?? AUTH_HINTS.default}`;
    return {
      message,
      ending: infrastructureEnding('setup', message, false),
    };
  }

  // 404 / not-found: the SDK collapses several distinct causes here — a wrong
  // or retired model id, or a base-URL override routing to a gateway that
  // doesn't serve the model. Preserve the raw error instead of guessing.
  if (
    says(
      (code) => code === 404,
      (text, lowered) =>
        text.includes('404') ||
        text.includes('Not Found') ||
        (lowered.includes('model') && lowered.includes('not found'))
    )
  ) {
    const message =
      `client simulation failed: ${raw}\n` +
      `Hint: a 404 usually means the model id is wrong or retired, or a ` +
      `base-URL override (e.g. ANTHROPIC_BASE_URL / OPENAI_BASE_URL pointing ` +
      `at a gateway) is routing requests somewhere that doesn't serve this ` +
      `model. Verify the model id and that no unexpected *_BASE_URL is set.`;
    return {
      message,
      ending: infrastructureEnding('setup', message, false),
    };
  }

  // Network / DNS / connection errors
  // A request that got a status reached the provider: not the network.
  if (
    says(
      () => false,
      (text) =>
        text.includes('ENOTFOUND') ||
        text.includes('fetch failed') ||
        text.includes('ECONNREFUSED') ||
        text.includes('ECONNRESET') ||
        text.includes('ETIMEDOUT')
    )
  ) {
    const message =
      `The mst client failed: network error.\n` +
      `Hint: check network connectivity and whether the provider's API endpoint is reachable from this machine.`;
    return { message, ending: infrastructureEnding('network', message) };
  }

  // Rate limiting
  if (
    says(
      (code) => code === 429,
      (text, lowered) =>
        text.includes('429') ||
        lowered.includes('rate limit') ||
        text.includes('Too Many Requests')
    )
  ) {
    const message =
      `The mst client failed: rate limited.\n` +
      `Hint: reduce concurrency, add delays between requests, or upgrade your API plan.`;
    return { message, ending: infrastructureEnding('provider', message) };
  }

  // Default: preserve original message with a consistent prefix
  const message = `client simulation failed: ${raw}`;
  // The provider's API failed: a server error, or overloaded.
  if (
    says(
      (code) => code >= 500,
      (text) => text.includes('503')
    ) ||
    PROVIDER_ERROR_TYPES.has(errorType(err) ?? '')
  )
    return { message, ending: infrastructureEnding('provider', message) };
  // Anything else is the client's own failure: a trial that failed.
  return { message, ending: TRIAL_ENDING };
}

/** The last error an AI SDK `RetryError` gave up on, if `error` is one. */
function lastRetriedError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, lastError } = error as { name?: unknown; lastError?: unknown };
  return name === 'AI_RetryError' ? lastError : undefined;
}

/** How providers say the context ran out (Anthropic, OpenAI, Google). */
const CONTEXT_OVERFLOW =
  /prompt is too long|context_length_exceeded|maximum context length|exceeds the context window|input token count .*exceeds the maximum|tokens > \d+ maximum/i;

/** Error types a provider streams when its API, not the request, failed. */
const PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
]);

/** A stream error part's `type` (`{ type: 'overloaded_error', message }`). */
function errorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/** An APICallError's response body, where OpenAI puts its error `code`. */
function responseBody(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const body = (err as { responseBody?: unknown }).responseBody;
  return typeof body === 'string' ? body : '';
}

/** What to check after an authentication error, by provider. */
const AUTH_HINTS: Record<string, string> = {
  anthropic:
    'check ANTHROPIC_API_KEY. Behind a gateway (ANTHROPIC_BASE_URL), use ANTHROPIC_AUTH_TOKEN or MST_LLM_AUTH_COMMAND; see docs/llm-gateways.md.',
  openai:
    'check OPENAI_API_KEY. Behind a gateway (OPENAI_BASE_URL), use MST_LLM_AUTH_COMMAND; see docs/llm-gateways.md.',
  default:
    'check your API key environment variable (e.g. ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS).',
};

/**
 * A readable message for anything thrown or streamed. Stream error parts are
 * often plain provider objects (`{ type: 'overloaded_error', message }`).
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unserializable error object';
    }
  }
  return String(err);
}

/** A provider model plus how the agent loop must call it. */
interface LoadedModel {
  model: AI.LanguageModel;
  providerOptions?: ProviderOptions;
  /** Run the agent loop with streamText instead of generateText. */
  streams?: boolean;
}

// Dynamic import helper bypasses TypeScript module resolution for optional peer deps.
// Each @ai-sdk/* package is optional — install only the providers you need.
async function loadModel(
  provider: LLMProvider,
  model: string,
  config: MstClientConfig
): Promise<LoadedModel> {
  const env: ClientEnvironment = { ...process.env, ...config.env };
  // Providers without gateway support read their key directly; the
  // anthropic and openai cases resolve theirs through resolveLLMEndpoint.
  function apiKey(defaultName: string): string {
    return env[config.apiKeyEnvVar ?? defaultName] ?? '';
  }
  const endpointOptions = { env, apiKeyEnvVar: config.apiKeyEnvVar };
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const endpoint = await resolveLLMEndpoint('openai', endpointOptions);
      return {
        model: createOpenAI({
          apiKey: endpoint.apiKey ?? '',
          baseURL: endpoint.baseURL,
        })(model),
        // The AI SDK refers back to earlier Responses items by id, which
        // needs them stored upstream; gateways and proxies usually don't
        // persist them (store: false), so send the items inline instead.
        ...(endpoint.overridden
          ? { providerOptions: { openai: { store: false } } }
          : {}),
      };
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const endpoint = await resolveLLMEndpoint('anthropic', endpointOptions);
      return {
        // Gateways that proxy the Messages API pass streamed responses through
        // untouched, while their rebuilt non-streaming responses can fail the
        // AI SDK's response schema.
        streams: true,
        model: createAnthropic({
          // The AI SDK's base URL includes the API version; the endpoint's is the root.
          baseURL: `${endpoint.baseURL}/v1`,
          ...(endpoint.authToken
            ? { authToken: endpoint.authToken }
            : { apiKey: endpoint.apiKey ?? '' }),
        })(model),
      };
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
      return {
        model: (vertexAnthropic as unknown as (m: string) => AI.LanguageModel)(
          model
        ),
      };
    }
    case 'google': {
      // @ts-ignore - optional: npm install @ai-sdk/google
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return {
        model: createGoogleGenerativeAI({
          apiKey: apiKey('GOOGLE_GENERATIVE_AI_API_KEY'),
        })(model),
      };
    }
    case 'mistral': {
      // @ts-ignore - optional: npm install @ai-sdk/mistral
      const { createMistral } = await import('@ai-sdk/mistral');
      return {
        model: createMistral({ apiKey: apiKey('MISTRAL_API_KEY') })(model),
      };
    }
    case 'azure': {
      // @ts-ignore - optional: npm install @ai-sdk/azure
      const { createAzure } = await import('@ai-sdk/azure');
      return {
        model: createAzure({
          apiKey: apiKey('AZURE_API_KEY'),
          resourceName: env.AZURE_RESOURCE_NAME,
          baseURL: env.AZURE_BASE_URL,
        })(model),
      };
    }
    case 'deepseek': {
      // @ts-ignore - optional: npm install @ai-sdk/deepseek
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      return {
        model: createDeepSeek({ apiKey: apiKey('DEEPSEEK_API_KEY') })(model),
      };
    }
    case 'openrouter': {
      // @ts-ignore - optional: npm install @openrouter/ai-sdk-provider
      const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
      return {
        model: createOpenRouter({ apiKey: apiKey('OPENROUTER_API_KEY') })(
          model
        ),
      };
    }
    case 'xai': {
      // @ts-ignore - optional: npm install @ai-sdk/xai
      const { createXai } = await import('@ai-sdk/xai');
      return { model: createXai({ apiKey: apiKey('XAI_API_KEY') })(model) };
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

/** The options the simulator passes to generateText/streamText. */
interface AgentLoopOptions {
  model: AI.LanguageModel;
  system?: string;
  prompt: string;
  tools: AI.ToolSet;
  stopWhen: AI.StopCondition<AI.ToolSet>;
  temperature: number;
  maxOutputTokens?: number;
  abortSignal: AbortSignal;
  providerOptions?: ProviderOptions;
  /** Called as each step (a model request and its tool calls) ends. */
  onStepFinish?: () => void;
}

/** The parts of a generateText/streamText result the simulator reads. */
interface AgentLoopResult {
  text: string;
  steps: Array<AI.StepResult<AI.ToolSet>>;
  /** Optional: SDK test doubles may omit it. */
  usage?: AI.LanguageModelUsage;
}

/**
 * Runs the agent loop with generateText, or with streamText when the
 * provider streams. streamText reports errors through onError only (a
 * mid-stream error otherwise resolves as an empty answer), so the first one
 * is rethrown here.
 */
async function runAgentLoop(
  ai: typeof AI,
  options: AgentLoopOptions,
  streaming: boolean
): Promise<AgentLoopResult> {
  if (!streaming) {
    const generated = await ai.generateText(options);
    return {
      text: generated.text,
      steps: generated.steps,
      usage: generated.totalUsage ?? generated.usage,
    };
  }
  let streamError: unknown;
  const result = ai.streamText({
    ...options,
    onError({ error }) {
      streamError ??= error;
    },
  });
  try {
    await result.consumeStream();
    const steps = await result.steps;
    if (streamError !== undefined) throw toError(streamError);
    return {
      text: await result.text,
      steps,
      usage: await result.totalUsage,
    };
  } catch (err) {
    throw toError(streamError ?? err);
  }
}

/**
 * Each step's model request. A step is a request and then its tool calls,
 * so a request runs from the step's start to its first tool call (or the
 * step's end): `stepEnds[i]` is when step `i` ended, `toolStarts` when each
 * tool call started, all in epoch ms.
 */
export function stepModelCalls(
  steps: ReadonlyArray<
    Pick<
      AI.StepResult<AI.ToolSet>,
      'usage' | 'finishReason' | 'response' | 'text' | 'toolCalls'
    >
  >,
  startedAt: number,
  stepEnds: readonly number[],
  toolStarts: readonly number[]
): ModelCall[] {
  return steps.map((step, index) => {
    const start = index === 0 ? startedAt : stepEnds[index - 1];
    const stepEnd = stepEnds[index];
    const firstTool =
      start !== undefined && stepEnd !== undefined
        ? toolStarts
            .filter((at) => at >= start && at <= stepEnd)
            .reduce<
              number | undefined
            >((first, at) => (first === undefined ? at : Math.min(first, at)), undefined)
        : undefined;
    const end = firstTool ?? stepEnd;
    const usage = step.usage;
    const toolCallIds = (step.toolCalls ?? [])
      .map((call) => call.toolCallId)
      .filter((id): id is string => typeof id === 'string');
    const call: ModelCall = {
      ...(step.response?.modelId ? { model: step.response.modelId } : {}),
      ...(step.response?.id ? { id: step.response.id } : {}),
      ...(start !== undefined
        ? { startedAt: new Date(start).toISOString() }
        : {}),
      ...(end !== undefined
        ? { completedAt: new Date(end).toISOString() }
        : {}),
      ...(start !== undefined && end !== undefined
        ? { durationMs: Math.max(0, end - start) }
        : {}),
      ...(usage?.inputTokens !== undefined
        ? { inputTokens: usage.inputTokens }
        : {}),
      ...(usage?.outputTokens !== undefined
        ? { outputTokens: usage.outputTokens }
        : {}),
      ...(usage?.inputTokenDetails?.cacheReadTokens !== undefined
        ? { cacheReadInputTokens: usage.inputTokenDetails.cacheReadTokens }
        : {}),
      ...(usage?.inputTokenDetails?.cacheWriteTokens !== undefined
        ? { cacheCreationInputTokens: usage.inputTokenDetails.cacheWriteTokens }
        : {}),
      ...(usage?.outputTokenDetails?.reasoningTokens !== undefined
        ? { reasoningOutputTokens: usage.outputTokenDetails.reasoningTokens }
        : {}),
      ...(step.finishReason ? { finishReason: step.finishReason } : {}),
      ...(step.text ? { text: step.text } : {}),
      ...(toolCallIds.length ? { toolCallIds } : {}),
    };
    return call;
  });
}

/** Errors thrown as-is; anything else (a streamed error part) wrapped. */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  // Keep a stream error part's `type`: it says the provider failed.
  const type = errorType(value);
  const error = new Error(errorText(value));
  return type !== undefined ? Object.assign(error, { type }) : error;
}

/** Skill loads and the ordered tool/skill event trace, when skills ran. */
function skillsTrace(
  toolCalls: LLMToolCall[],
  skills: ClientSkillsSession | null
): Pick<MstClientSimulationResult, 'skillLoads' | 'events'> {
  if (!skills) return {};
  const toolEvents: TraceEvent[] = toolCalls.map((call) => ({
    kind: 'tool_call',
    source: 'mcp',
    name: call.name,
    arguments: call.arguments,
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.isError !== undefined ? { isError: call.isError } : {}),
    ...(call.rawName !== undefined ? { rawName: call.rawName } : {}),
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.startedAt ? { startedAt: call.startedAt } : {}),
    ...(call.completedAt ? { completedAt: call.completedAt } : {}),
  }));
  return {
    skillLoads: skills.loads,
    events: withSkillEvents(toolEvents, skills.loads),
  };
}

/**
 * Creates a Vercel AI SDK-based client simulator.
 *
 * Uses generateText (streamText for streaming providers) with stopWhen (ai v6)
 * to handle multi-turn tool calling. Produces llmDurationMs and mcpDurationMs
 * for latency decomposition.
 */
export function createVercelOrchestrator(): MstClientSimulator {
  return {
    async simulate(
      mcp: MCPFixtureApi,
      input: string,
      config: MstClientConfig,
      signal?: AbortSignal
    ): Promise<MstClientSimulationResult> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortFromClient: (() => void) | undefined;
      const allToolCalls: LLMToolCall[] = [];
      // Whether the model has answered: what running out of context means.
      let stepsFinished = 0;
      let skills: ClientSkillsSession | null = null;
      let expired: Promise<never>;
      function withinDeadline<T>(promise: Promise<T>): Promise<T> {
        return Promise.race([promise, expired]);
      }
      try {
        SdkConfigSchema.parse(config);
        expired = new Promise<never>((_, reject) => {
          if (signal) {
            abortFromClient = function abortFromClient() {
              const reason: unknown = signal.reason;
              const error =
                reason instanceof Error
                  ? reason
                  : new Error(
                      typeof reason === 'string'
                        ? reason
                        : 'SDK client aborted.'
                    );
              controller.abort(error);
              reject(error);
            };
            signal.addEventListener('abort', abortFromClient, { once: true });
            if (signal.aborted) abortFromClient();
          } else if (config.timeout !== undefined)
            timer = setTimeout(() => {
              const error = new Error(
                `SDK client timed out after ${config.timeout} ms.`
              );
              controller.abort(error);
              reject(error);
            }, config.timeout);
        });
        const ai = await withinDeadline(import('ai'));
        const { stepCountIs } = ai;
        // jsonSchema from @ai-sdk/provider-utils creates a proper Schema object
        // (with .jsonSchema property) that ai's prepareToolsAndToolChoice can read.
        // Do NOT use jsonSchema from 'ai' — in v6 it produces the wrong shape.
        const { jsonSchema } = await withinDeadline(
          import('@ai-sdk/provider-utils')
        );

        if (!config.provider) {
          throw new Error('provider is required for SDK client type');
        }

        const modelId = config.model ?? defaultModel(config.provider);
        const { model, providerOptions, streams } = await withinDeadline(
          loadModel(config.provider, modelId, config)
        );

        // Get available MCP tools and wrap them for Vercel AI SDK
        const mcpTools = await withinDeadline(mcp.listTools());
        let mcpDurationMs = 0;
        let attemptedToolCalls = 0;
        // For each model request's span: when steps end and tools start.
        const stepEnds: number[] = [];
        const toolStarts: number[] = [];
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
              toolStarts.push(mcpStart);
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

        // Agent Skills (SEP-2640): built-in tools and system prompt, when enabled.
        skills = await withinDeadline(
          createClientSkillsSession(mcp, config.skills, {
            countToolCalls: () => allToolCalls.length,
          })
        );
        for (const [name, clientTool] of Object.entries(skills?.tools ?? {})) {
          if (tools[name]) {
            throw new Error(
              `MCP tool "${name}" collides with the client skills tool of the same name; set skills: 'off' for this server.`
            );
          }
          tools[name] = {
            description: clientTool.description,
            inputSchema: jsonSchema(clientTool.inputSchema),
            execute: async (args: Record<string, unknown>) => {
              if (controller.signal.aborted) throw controller.signal.reason;
              const mcpStart = Date.now();
              toolStarts.push(mcpStart);
              const output = await withinDeadline(clientTool.execute(args));
              mcpDurationMs += Date.now() - mcpStart;
              return output;
            },
          };
        }

        const maxSteps = config.maxToolCalls ?? 10;
        // The caller's instructions, then the skills catalog.
        const system = [config.systemPrompt, skills?.system]
          .filter((part): part is string => Boolean(part))
          .join('\n\n');
        const llmStart = Date.now();

        const result = await withinDeadline(
          runAgentLoop(
            ai,
            {
              model,
              ...(system ? { system } : {}),
              prompt: input,
              tools,
              stopWhen: stepCountIs(Math.max(1, maxSteps)),
              temperature: config.temperature ?? 0,
              maxOutputTokens: config.maxTokens,
              abortSignal: controller.signal,
              ...(providerOptions ? { providerOptions } : {}),
              onStepFinish: () => {
                stepsFinished++;
                stepEnds.push(Date.now());
              },
            },
            streams === true
          )
        );
        if (budgetError) throw budgetError;

        const totalDurationMs = Date.now() - llmStart;
        const llmDurationMs = totalDurationMs - mcpDurationMs;

        const usage = result.usage;
        const clientUsage: UsageMetrics | undefined = usage
          ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              // The SDK reports tokens, not cost.
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
            // Client skills tools are not MCP tool calls, so describe them inline.
            return (
              step.toolCalls as Array<{
                toolCallId?: string;
                toolName?: string;
                input?: unknown;
              }>
            ).map((tc) =>
              tc.toolName && HOST_SKILL_TOOL_NAMES.has(tc.toolName)
                ? {
                    role: 'tool' as const,
                    content: `[client] ${tc.toolName} ${JSON.stringify(tc.input ?? {})}`,
                  }
                : { role: 'tool' as const, toolCallId: tc.toolCallId }
            );
          }
          return step.text
            ? [{ role: 'assistant' as const, content: step.text as string }]
            : [];
        });

        const modelCalls = stepModelCalls(
          result.steps ?? [],
          llmStart,
          stepEnds,
          toolStarts
        );
        return {
          success: true,
          toolCalls: allToolCalls,
          ...(modelCalls.length ? { modelCalls } : {}),
          response: result.text as string,
          input,
          llmDurationMs,
          mcpDurationMs,
          conversationHistory,
          usage: clientUsage,
          ...skillsTrace(allToolCalls, skills),
        };
      } catch (err) {
        const failure = sdkFailure(
          err,
          config.provider ?? 'unknown',
          stepsFinished > 0 || allToolCalls.length > 0
        );
        return {
          success: false,
          toolCalls: allToolCalls,
          error: failure.message,
          ending: failure.ending,
          ...skillsTrace(allToolCalls, skills),
        };
      } finally {
        clearTimeout(timer);
        if (abortFromClient)
          signal?.removeEventListener('abort', abortFromClient);
        controller.abort();
      }
    },
  };
}
