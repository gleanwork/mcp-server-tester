import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { simulateMstClient } from './mstClient/simulation.js';
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
vi.mock('./mstClient/simulation.js', () => ({ simulateMstClient: vi.fn() }));
const case_ = {
  id: 'one',
  input: 'Find documents',
};
function options(): ClientRunOptions {
  return {
    dataset: { name: 'test', cases: [case_] },
    cases: [case_],
    servers: [{ transport: 'http', serverUrl: 'https://example.com' }],
    client: { type: 'mst', model: 'selected' },
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
  vi.mocked(simulateMstClient).mockResolvedValue({
    success: true,
    response: 'OK',
    toolCalls: [],
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('built-in client execution', () => {
  it('exposes different descriptions to SDK variants and retains the selected model', async () => {
    const descriptions: string[] = [];
    vi.mocked(simulateMstClient).mockImplementation(
      async (mcp, _scenario, config) => {
        descriptions.push((await mcp.listTools())[0]!.description!);
        expect(config.model).toBe('selected');
        return { success: true, response: 'OK', toolCalls: [] };
      }
    );
    const client = getClient('mst');
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
    vi.mocked(simulateMstClient).mockImplementation(async (mcp) => ({
      success: true,
      response: (await mcp.listTools()).map((tool) => tool.name).join(','),
      toolCalls: [],
    }));
    const client = getClient('mst');
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
    vi.mocked(simulateMstClient).mockImplementation(
      async (_mcp, _scenario, cfg) => {
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
        return { success: true, toolCalls: [] };
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
