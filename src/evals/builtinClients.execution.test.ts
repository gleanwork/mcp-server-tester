import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { runApiClient, runClaudeCodeClient } from './mstClient/run.js';
import { getBuiltinClientConfig } from './builtinClients.js';
import { getClient } from './builtinClients.js';
import type {
  ClientRunOptions,
  ClientDefinition,
} from './evalFrameworkTypes.js';
import { clientRunToExecution } from './clientTrace.js';
async function run(
  clientDefinition: ClientDefinition,
  options: ClientRunOptions
) {
  const trace = await clientDefinition.run!(
    { prompt: options.cases[0]!.input, servers: options.servers },
    options.client,
    { evalConfig: options.evalConfig, variant: options.variant }
  );
  return clientRunToExecution(
    trace,
    clientDefinition.evidence ?? 'none',
    options.servers
  );
}
vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mstClient/run.js', () => ({
  runApiClient: vi.fn(),
  runClaudeCodeClient: vi.fn(),
}));
const case_ = {
  id: 'one',
  input: 'Find documents',
};
function options(): ClientRunOptions {
  return {
    dataset: { name: 'test', cases: [case_] },
    cases: [case_],
    servers: [{ transport: 'http', serverUrl: 'https://example.com' }],
    client: { type: 'api', model: 'selected' },
    evalConfig: { name: 'test', datasets: [] },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createMCPClientForConfig).mockResolvedValue({
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: 'search',
          description: 'original',
          inputSchema: { type: 'object' },
        },
      ],
    })),
  } as unknown as Awaited<ReturnType<typeof createMCPClientForConfig>>);
  vi.mocked(runApiClient).mockResolvedValue({
    finalText: 'OK',
    events: [],
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('built-in client execution', () => {
  it('exposes different descriptions to SDK variants and retains the selected model', async () => {
    const descriptions: string[] = [];
    vi.mocked(runApiClient).mockImplementation(
      async (mcp, _scenario, config) => {
        descriptions.push((await mcp.listTools())[0]!.description!);
        expect(config.model).toBe('selected');
        return { finalText: 'OK', events: [] };
      }
    );
    const client = getClient('api');
    await run(client, options());
    await run(client, {
      ...options(),
      variant: {
        name: 'variant',
        tools: { search: { description: 'variant description' } },
      },
    });
    expect(descriptions).toEqual(['original', 'variant description']);
    expect(closeMCPClient).toHaveBeenCalledTimes(2);
  });
  it('allows zero servers and exposes all servers with labels in SDK execution', async () => {
    vi.mocked(runApiClient).mockImplementation(async (mcp) => ({
      finalText: (await mcp.listTools()).map((tool) => tool.name).join(','),
      events: [],
    }));
    const client = getClient('api');
    expect(
      (await run(client, { ...options(), servers: [] })).response
    ).toMatchObject({ response: '' });
    expect(
      (
        await run(client, {
          ...options(),
          servers: ['a', 'b'].map((label) => ({
            transport: 'http',
            label,
            serverUrl: 'https://example.com',
          })),
        })
      ).response
    ).toMatchObject({ response: 'a.search,b.search' });
  });
  it('restores qualified API names before attributing events to their servers', async () => {
    vi.mocked(runApiClient).mockImplementation(async (mcp) => {
      await mcp.listTools();
      return {
        finalText: 'found',
        events: [
          {
            kind: 'tool_call',
            source: 'mcp',
            name: 'a.find',
            arguments: { q: 'docs' },
          },
        ],
      };
    });
    const execution = await run(getClient('api'), {
      ...options(),
      servers: ['a', 'b'].map((label) => ({
        transport: 'http',
        label,
        serverUrl: 'https://example.com',
      })),
      variant: { name: 'renamed', tools: { 'a.search': { name: 'find' } } },
    });
    expect(execution.trace?.events).toMatchObject([
      {
        kind: 'tool_call',
        source: 'mcp',
        server: 'a',
        name: 'search',
        rawName: 'a.find',
      },
    ]);
    expect(execution.response.toolCalls).toMatchObject([{ name: 'a.search' }]);
  });

  it('retains a failed Claude Code run and its partial native evidence', async () => {
    const trace = {
      finalText: 'partial',
      events: [
        {
          kind: 'command' as const,
          source: 'builtin' as const,
          name: 'Bash',
          arguments: { command: 'true' },
        },
      ],
      error: 'process stopped',
      ending: {
        kind: 'infrastructure' as const,
        broke: 'client-app' as const,
        retryable: true,
        reason: 'process stopped',
      },
      diagnostics: { failureKind: 'startup' as const },
      modelCalls: [{ model: 'claude', inputTokens: 2, outputTokens: 3 }],
      usage: { inputTokens: 2, outputTokens: 3, durationMs: 4 },
      llmDurationMs: 4,
      telemetry: { content: { input: 'query', conversationHistory: [] } },
    };
    vi.mocked(runClaudeCodeClient).mockResolvedValue(trace);
    const execution = await run(getClient('claude-code'), {
      ...options(),
      client: { type: 'claude-code' },
      servers: [],
    });
    expect(execution).toMatchObject({
      kind: 'completed',
      error: trace.error,
      ending: trace.ending,
      diagnostics: trace.diagnostics,
      usage: trace.usage,
      telemetry: trace.telemetry,
      trace: { events: trace.events, modelCalls: trace.modelCalls },
      response: { success: false, llmDurationMs: 4 },
    });
    expect(runApiClient).not.toHaveBeenCalled();
  });

  it('keeps provider configuration in child env and removes its temporary credential file', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'do-not-change');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', 'original');
    const config = getBuiltinClientConfig('claude-code', {
      provider: 'vertex',
    });
    expect(config.cli?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe('do-not-change');
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBe('original');
    let file = '';
    vi.mocked(runClaudeCodeClient).mockImplementation(
      async (_scenario, cfg) => {
        file = cfg.cli!.args[cfg.cli!.args.indexOf('--mcp-config') + 1]!;
        const content: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(
          z
            .object({
              mcpServers: z.object({ first: z.unknown(), second: z.unknown() }),
            })
            .safeParse(content).success
        ).toBe(true);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        return { finalText: '', events: [] };
      }
    );
    await run(getClient('claude-code'), {
      ...options(),
      client: { type: 'claude-code' },
      servers: ['first', 'second'].map((label) => ({
        transport: 'http',
        label,
        serverUrl: 'https://example.com',
      })),
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(createMCPClientForConfig).not.toHaveBeenCalled();
  });
});
