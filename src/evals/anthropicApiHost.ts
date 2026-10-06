import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { callToolNormalized } from '../mcp/callTool.js';
import { z } from 'zod';
import type {
  HostRunInput,
  HostRunContext,
  HostDefinition,
  HostRunResult,
} from './evalFrameworkTypes.js';
import type {
  MCPHostConfig,
  MCPHostSimulationResult,
} from './mcpHost/mcpHostTypes.js';

import type { HostConfig } from './evalManifest.js';
import { simulationToHostRun } from './hostTrace.js';
import { buildToolSurface, type ListedServerTools } from './toolSurface.js';
import {
  GenerationOptions,
  SystemPromptOption,
} from './mcpHost/hostOptions.js';

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}
interface ApiResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}
interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}
type Client = Awaited<ReturnType<typeof createMCPClientForConfig>>;

const HostSchema = z
  .object({
    type: z.literal('anthropic-api'),
    model: z.string().min(1).default('claude-sonnet-4-6'),
    apiKeyEnv: z.string().min(1).default('ANTHROPIC_API_KEY'),
    maxToolCalls: z.number().int().nonnegative().default(20),
    timeout: z.number().int().positive().default(180_000),
    temperature: GenerationOptions.temperature,
    maxTokens: GenerationOptions.maxTokens,
    systemPrompt: SystemPromptOption,
  })
  // An option this host doesn't use is an error, not silently dropped.
  .strict();

/** The settings a manifest or a legacy case config may default (a system prompt only from a case). */
function hostDefaults(
  source: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!source) return {};
  return Object.fromEntries(
    [
      'model',
      'maxToolCalls',
      'timeout',
      'temperature',
      'maxTokens',
      'systemPrompt',
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]])
  );
}

/** Execute a single scenario. Iterations, assertions and judges belong to the runner. */
async function runAnthropicApiHost(
  input: HostRunInput,
  host: HostConfig,
  context: HostRunContext
): Promise<HostRunResult> {
  const options = { ...input, ...context, host };
  // Manifest defaults, then the host, then a legacy case config.
  const config = HostSchema.parse({
    ...hostDefaults(options.manifest),
    ...options.host,
    ...hostDefaults(
      context.mcpHostConfig as Record<string, unknown> | undefined
    ),
  });
  const env = { ...process.env, ...context.env, ...input.env };
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey)
    throw new Error(`Anthropic API key ${config.apiKeyEnv} is not set.`);
  const case_ = { scenario: input.prompt };
  if (!case_.scenario) {
    throw new Error(
      'Anthropic API host requires exactly one input per invocation.'
    );
  }
  const started = Date.now();
  const controller = new AbortController();
  const clients: Client[] = [];
  const timeoutError = new Error(
    `Anthropic host timed out after ${config.timeout} ms.`
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, config.timeout);
  });
  const withinDeadline = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, expired]);
  const toolCalls: MCPHostSimulationResult['toolCalls'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';
  let error: string | undefined;
  try {
    const routing = new Map<
      string,
      { client: Client; name: string; label?: string }
    >();
    const tools: Array<Record<string, unknown>> = [];
    const listedTools: Array<ListedServerTools & { client: Client }> = [];
    for (const server of options.servers) {
      const client = await withinDeadline(
        createMCPClientForConfig(server).then(async (connected) => {
          // Connection setup itself may not support cancellation. Close late arrivals.
          if (controller.signal.aborted) {
            await closeMCPClient(connected);
            throw timeoutError;
          }
          clients.push(connected);
          return connected;
        })
      );
      const listed = await withinDeadline(
        client.listTools({}, { signal: controller.signal })
      );
      listedTools.push({ server: server.label, client, tools: listed.tools });
    }
    const surface = buildToolSurface(
      listedTools,
      options.arm?.toolOverrides ?? options.manifest.toolOverrides
    );
    for (const { server, originalName, tool } of surface.tools) {
      const name =
        options.servers.length > 1 ? `${server}__${tool.name}` : tool.name;
      if (routing.has(name))
        throw new Error(`Duplicate host tool name: ${name}`);
      routing.set(name, {
        client: listedTools.find((item) => item.server === server)!.client,
        name: originalName,
        label: server,
      });
      tools.push({
        name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }
    const messages: Message[] = [{ role: 'user', content: case_.scenario }];
    for (;;) {
      const response = await withinDeadline(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens ?? 4096,
            ...(config.systemPrompt ? { system: config.systemPrompt } : {}),
            temperature: config.temperature,
            messages,
            ...(tools.length ? { tools } : {}),
          }),
        })
      );
      const body = (await withinDeadline(response.json())) as ApiResponse;
      if (!response.ok)
        throw new Error(
          body.error?.message ?? `Anthropic API returned ${response.status}.`
        );
      const content = body.content ?? [];
      text = content
        .filter((block) => block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n');
      inputTokens += body.usage?.input_tokens ?? 0;
      outputTokens += body.usage?.output_tokens ?? 0;
      const calls = content.filter((block) => block.type === 'tool_use');
      if (calls.length === 0) break;
      messages.push({ role: 'assistant', content });
      const results: ContentBlock[] = [];
      for (const call of calls) {
        if (toolCalls.length >= config.maxToolCalls)
          throw new Error(
            `Tool call budget exhausted (${config.maxToolCalls}).`
          );
        if (typeof call.name !== 'string' || typeof call.id !== 'string')
          throw new Error('Malformed Anthropic tool use.');
        const route = routing.get(call.name);
        if (!route) throw new Error(`Unknown tool requested: ${call.name}`);
        const args =
          call.input &&
          typeof call.input === 'object' &&
          !Array.isArray(call.input)
            ? (call.input as Record<string, unknown>)
            : {};
        const result = await withinDeadline(
          callToolNormalized(
            route.client,
            { name: route.name, arguments: args },
            { signal: controller.signal }
          )
        );
        const recorded =
          options.servers.length > 1
            ? `${route.label}.${route.name}`
            : route.name;
        toolCalls.push({
          name: recorded,
          ...(call.name !== recorded ? { rawName: call.name } : {}),
          arguments: args,
          id: call.id,
          output: JSON.stringify(result),
        });
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
          is_error: Boolean(result.isError),
        });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // Session termination can itself issue an HTTP request. Keep teardown under
    // the same deadline, and force transport closure if it stalls.
    try {
      await withinDeadline(Promise.allSettled(clients.map(closeMCPClient)));
    } catch {
      error ??= timeoutError.message;
      controller.abort(timeoutError);
      await Promise.allSettled(clients.map((client) => client.close()));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  const usage = {
    inputTokens,
    outputTokens,
    // The Messages API reports tokens, not cost.
    durationMs: Date.now() - started,
  };
  const response: MCPHostSimulationResult = {
    success: !error,
    response: text,
    toolCalls,
    usage,
    ...(error ? { error } : {}),
  };
  return simulationToHostRun(response, input.servers);
}

export const ANTHROPIC_API_HOST: HostDefinition = {
  toolOverrides: true,
  schema: HostSchema,
  evidence: 'structured',
  createConfig(options = {}): MCPHostConfig {
    return {
      hostType: 'sdk',
      provider: 'anthropic',
      model:
        typeof options.model === 'string' ? options.model : 'claude-sonnet-4-6',
      maxToolCalls:
        typeof options.maxToolCalls === 'number' ? options.maxToolCalls : 20,
    };
  },
  run: runAnthropicApiHost,
};
