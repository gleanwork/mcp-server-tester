import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import { registerBuiltinHosts, getBuiltinHostConfig } from './builtinHosts.js';
import { getHost } from './frameworkRegistries.js';
import type { HostRunOptions, HostDefinition } from './evalFrameworkTypes.js';
import { hostTraceToExecution } from './hostTrace.js';
async function run(host: HostDefinition, options: HostRunOptions) {
  const trace = await host.run!(
    { scenario: options.cases[0]!.scenario!, servers: options.servers },
    options.host,
    {
      manifest: options.manifest,
      arm: options.arm,
      mcpHostConfig: options.cases[0]?.mcpHostConfig,
    }
  );
  return hostTraceToExecution(trace, host.evidence ?? 'none', options.servers);
}
vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(),
  closeMCPClient: vi.fn(async () => {}),
}));
vi.mock('./mcpHost/mcpHostSimulation.js', () => ({ simulateMCPHost: vi.fn() }));
const case_ = {
  id: 'one',
  scenario: 'Find documents',
  mode: 'mcp_host' as const,
};
function options(): HostRunOptions {
  return {
    dataset: { name: 'test', cases: [case_] },
    cases: [case_],
    servers: [{ transport: 'http', serverUrl: 'https://example.com' }],
    host: { type: 'vercel-sdk', model: 'selected' },
    manifest: { name: 'test', datasets: [] },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  registerBuiltinHosts();
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
  vi.mocked(simulateMCPHost).mockResolvedValue({
    success: true,
    response: 'OK',
    toolCalls: [],
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('built-in host execution', () => {
  it('exposes different descriptions to SDK arms and retains the selected model', async () => {
    const descriptions: string[] = [];
    vi.mocked(simulateMCPHost).mockImplementation(
      async (mcp, _scenario, config) => {
        descriptions.push((await mcp.listTools())[0]!.description!);
        expect(config.model).toBe('selected');
        return { success: true, response: 'OK', toolCalls: [] };
      }
    );
    const host = getHost('vercel-sdk');
    await run(host, options());
    await run(host, {
      ...options(),
      arm: {
        name: 'variant',
        toolOverrides: {
          id: 'changed',
          tools: { search: { description: 'variant description' } },
        },
      },
    });
    expect(descriptions).toEqual(['original', 'variant description']);
    expect(closeMCPClient).toHaveBeenCalledTimes(2);
  });
  it('allows zero servers and exposes all servers with labels in SDK execution', async () => {
    vi.mocked(simulateMCPHost).mockImplementation(async (mcp) => ({
      success: true,
      response: (await mcp.listTools()).map((tool) => tool.name).join(','),
      toolCalls: [],
    }));
    const host = getHost('vercel-sdk');
    expect(
      (await run(host, { ...options(), servers: [] })).response
    ).toMatchObject({ response: '' });
    expect(
      (
        await run(host, {
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
    const config = getBuiltinHostConfig('claude-cli', { provider: 'vertex' });
    expect(config.cli?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe('do-not-change');
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBe('original');
    let file = '';
    vi.mocked(simulateMCPHost).mockImplementation(
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
    await run(getHost('claude-cli'), {
      ...options(),
      host: { type: 'claude-cli' },
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
