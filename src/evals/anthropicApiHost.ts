import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
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
import { simulationToHostTrace } from './hostTrace.js';

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
  })
  .passthrough();

/** Execute a single scenario. Iterations, assertions and judges belong to the runner. */
async function runAnthropicApiHost(
  input: HostRunInput,
  host: HostConfig,
  context: HostRunContext
): Promise<HostRunResult> {
  const options = { ...input, ...context, host };
  const config = HostSchema.parse({ ...options.manifest, ...options.host });
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey)
    throw new Error(`Anthropic API key ${config.apiKeyEnv} is not set.`);
  const case_ = { scenario: input.scenario };
  if (!case_.scenario) {
    throw new Error(
      'Anthropic API host requires exactly one scenario per invocation.'
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
      for (const tool of listed.tools) {
        const name =
          options.servers.length > 1
            ? `${server.label}__${tool.name}`
            : tool.name;
        if (routing.has(name))
          throw new Error(`Duplicate host tool name: ${name}`);
        routing.set(name, { client, name: tool.name, label: server.label });
        const overrides =
          options.arm?.toolOverrides ?? options.manifest.toolOverrides;
        const override = overrides?.tools[tool.name];
        tools.push({
          name,
          description: override?.description ?? tool.description,
          input_schema: override?.inputSchema ?? tool.inputSchema,
        });
      }
    }
    const overrides =
      options.arm?.toolOverrides ?? options.manifest.toolOverrides;
    for (const name of Object.keys(overrides?.tools ?? {})) {
      if (![...routing.values()].some((route) => route.name === name))
        throw new Error(`Unknown tool override: ${name}`);
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
            max_tokens: 4096,
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
          route.client.callTool(
            { name: route.name, arguments: args },
            undefined,
            { signal: controller.signal }
          )
        );
        toolCalls.push({
          name:
            options.servers.length > 1
              ? `${route.label}.${route.name}`
              : route.name,
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
    totalCostUsd: 0,
    durationMs: Date.now() - started,
  };
  const response: MCPHostSimulationResult = {
    success: !error,
    response: text,
    toolCalls,
    usage,
    ...(error ? { error } : {}),
  };
  return simulationToHostTrace(response, input.servers);
}

export const ANTHROPIC_API_HOST: HostDefinition = {
  name: 'anthropic-api',
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
