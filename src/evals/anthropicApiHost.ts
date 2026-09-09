import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { z } from 'zod';
import type { EvalCase } from './datasetTypes.js';
import type { HostRunOptions, HostDefinition } from './evalFrameworkTypes.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import type { UsageMetrics } from '../types/index.js';

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function hostConfig(options: Record<string, unknown>): MCPHostConfig {
  return {
    hostType: 'sdk',
    provider: 'anthropic',
    model:
      typeof options.model === 'string' ? options.model : 'claude-sonnet-4-6',
    maxToolCalls:
      typeof options.maxToolCalls === 'number' ? options.maxToolCalls : 20,
  };
}

function scenarioForCase(case_: EvalCase): string {
  const value = (case_ as unknown as Record<string, unknown>).scenario;
  if (typeof value !== 'string' || !value) {
    throw new Error(
      `Anthropic API host requires a scenario for case ${case_.id}.`
    );
  }
  return value;
}

function expectedToolsForCase(case_: EvalCase): string[] {
  const expect = (case_ as unknown as Record<string, unknown>).expect;
  if (!expect || typeof expect !== 'object') return [];
  const toolsTriggered = (expect as Record<string, unknown>).toolsTriggered;
  if (!toolsTriggered || typeof toolsTriggered !== 'object') return [];
  const calls = (toolsTriggered as Record<string, unknown>).calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const name = (call as Record<string, unknown>).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function textFromResponse(content: AnthropicContentBlock[]): string {
  return content
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    )
    .filter(Boolean)
    .join('\n');
}

async function postAnthropic(
  apiKey: string,
  model: string,
  messages: AnthropicMessage[],
  tools: Array<Record<string, unknown>>
): Promise<AnthropicResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages,
      tools,
    }),
  });
  const body = (await response.json()) as AnthropicResponse;
  if (!response.ok) {
    throw new Error(
      body.error?.message ?? `Anthropic API returned ${response.status}.`
    );
  }
  return body;
}

async function runCase(
  client: Awaited<ReturnType<typeof createMCPClientForConfig>>,
  apiKey: string,
  model: string,
  maxToolCalls: number,
  case_: EvalCase,
  tools: Array<Record<string, unknown>>,
  datasetName: string
): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const messages: AnthropicMessage[] = [
    { role: 'user', content: scenarioForCase(case_) },
  ];
  const toolCalls: Array<Record<string, unknown>> = [];
  let finalContent: AnthropicContentBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration <= maxToolCalls; iteration += 1) {
    const response = await postAnthropic(apiKey, model, messages, tools);
    finalContent = response.content ?? [];
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    const toolUses = finalContent.filter((block) => block.type === 'tool_use');
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: finalContent });
    const toolResults: AnthropicContentBlock[] = [];
    for (const toolUse of toolUses) {
      const name = typeof toolUse.name === 'string' ? toolUse.name : '';
      const id = typeof toolUse.id === 'string' ? toolUse.id : '';
      const input =
        toolUse.input && typeof toolUse.input === 'object'
          ? (toolUse.input as Record<string, unknown>)
          : {};
      if (!name || !id) continue;
      const result = await client.callTool({ name, arguments: input });
      toolCalls.push({ name, arguments: input, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        is_error: Boolean((result as { isError?: boolean }).isError),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  const expectedTools = expectedToolsForCase(case_);
  const calledNames = toolCalls.map((call) => String(call.name));
  const pass = expectedTools.every((name) => calledNames.includes(name));
  return {
    id: case_.id,
    datasetName,
    toolName: case_.toolName ?? '',
    source: 'eval',
    pass,
    durationMs: Date.now() - startedAt,
    response: {
      success: true,
      response: textFromResponse(finalContent),
      toolCalls,
    },
    hostUsage: {
      inputTokens,
      outputTokens,
      totalCostUsd: 0,
      durationMs: Date.now() - startedAt,
    },
    expectations: {
      toolsTriggered: {
        expected: expectedTools,
        actual: calledNames,
        pass,
      },
    },
  } as EvalCaseResult;
}

async function runAnthropicApiHost(
  options: HostRunOptions
): Promise<EvalRunnerResult> {
  const apiKeyEnv =
    typeof options.host.apiKeyEnv === 'string'
      ? options.host.apiKeyEnv
      : 'ANTHROPIC_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`Anthropic API key ${apiKeyEnv} is not set.`);
  const model =
    typeof options.host.model === 'string'
      ? options.host.model
      : (options.manifest.model ?? 'claude-sonnet-4-6');
  const maxToolCalls = options.manifest.maxToolCalls ?? 20;
  const server = options.servers[0];
  if (!server) throw new Error('Anthropic API host requires one MCP server.');

  const client = await createMCPClientForConfig(server);
  try {
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    const caseResults: EvalCaseResult[] = [];
    for (const case_ of options.cases) {
      caseResults.push(
        await runCase(
          client,
          apiKey,
          model,
          maxToolCalls,
          case_,
          tools,
          options.dataset.name
        )
      );
    }
    const durationMs = caseResults.reduce(
      (sum, result) => sum + result.durationMs,
      0
    );
    return {
      total: caseResults.length,
      passed: caseResults.filter((result) => result.pass).length,
      failed: caseResults.filter((result) => !result.pass).length,
      caseResults,
      durationMs,
      totalHostUsage: caseResults.reduce<UsageMetrics>(
        (usage, result) => ({
          inputTokens:
            (usage.inputTokens ?? 0) + (result.hostUsage?.inputTokens ?? 0),
          outputTokens:
            (usage.outputTokens ?? 0) + (result.hostUsage?.outputTokens ?? 0),
          totalCostUsd:
            (usage.totalCostUsd ?? 0) + (result.hostUsage?.totalCostUsd ?? 0),
          durationMs:
            (usage.durationMs ?? 0) + (result.hostUsage?.durationMs ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, durationMs: 0 }
      ),
    };
  } finally {
    await closeMCPClient(client);
  }
}

export const ANTHROPIC_API_HOST: HostDefinition = {
  name: 'anthropic-api',
  schema: z.object({ type: z.literal('anthropic-api') }).passthrough(),
  createConfig: hostConfig,
  run: runAnthropicApiHost,
};
