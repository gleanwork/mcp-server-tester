import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSuiteCaseExecutor, executeEvalCase } from './caseExecution.js';
import { runEvalCase } from './evalRunner.js';
import type { EvalCase } from './datasetTypes.js';
import type { HostDefinition, HostRunResult } from './evalFrameworkTypes.js';
import type { ToolSurfaceProxy } from './toolSurfaceProxy.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type * as SimulationModule from './mcpHost/mcpHostSimulation.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';

vi.mock('./mcpHost/mcpHostSimulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMCPHost: vi.fn(),
}));

const mcp = { authType: 'none' } as MCPFixtureApi;
const hostCase: EvalCase = {
  id: 'host',
  mode: 'mcp_host',
  scenario: 'query',
  mcpHostConfig: { provider: 'anthropic' },
};
const manifest = { name: 'm', datasets: [] };

beforeEach(() => vi.mocked(simulateMCPHost).mockReset());

describe('executeEvalCase', () => {
  it('adapts a successful simulation to a host execution', async () => {
    vi.mocked(simulateMCPHost).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    });
    await expect(executeEvalCase(hostCase, mcp)).resolves.toMatchObject({
      kind: 'host',
      response: { success: true, response: 'answer' },
      usage: { inputTokens: 1 },
    });
  });

  it('fails a simulation failure without keeping its response', async () => {
    vi.mocked(simulateMCPHost).mockResolvedValue({
      success: false,
      toolCalls: [],
      error: 'rejected',
    });
    await expect(executeEvalCase(hostCase, mcp)).resolves.toEqual({
      kind: 'failed',
      response: undefined,
      error: 'rejected',
    });
  });

  it('keeps Claude CLI startup diagnostics on failure', async () => {
    const diagnostics = { failureKind: 'startup' as const };
    vi.mocked(simulateMCPHost).mockResolvedValue({
      success: false,
      toolCalls: [],
      error: 'MCP connection failed',
      diagnostics,
    });
    const execution = await executeEvalCase(
      {
        ...hostCase,
        mcpHostConfig: {
          hostType: 'cli',
          cli: { command: 'claude', args: [], claudeMcpServers: ['acme'] },
        },
      },
      mcp
    );
    expect(execution).toMatchObject({
      kind: 'host',
      error: 'MCP connection failed',
      diagnostics,
      response: { success: false },
    });
  });

  it('reports a missing connection as a failed execution', async () => {
    await expect(
      executeEvalCase({ id: 'd', toolName: 't', args: {} }, undefined)
    ).resolves.toMatchObject({
      kind: 'failed',
      error: 'Direct tool calls require an MCP connection.',
    });
  });
});

describe('custom executeCase results', () => {
  it('fails a pre-2.0 untyped result loudly instead of reading it as direct', async () => {
    const result = await runEvalCase(
      {
        id: 'legacy',
        mode: 'host',
        scenario: 'query',
        expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
      },
      {},
      {
        // A 1.x-style executor: no kind, observed evidence.
        executeCase: (async () => ({
          evidence: 'observed',
          response: { success: true, toolCalls: [{ name: 'search' }] },
        })) as never,
      }
    );
    expect(result.pass).toBe(false);
    expect(result.error).toContain(
      "executeCase must return a CaseExecution with kind 'direct', 'host', or 'failed'"
    );
  });
});

describe('createSuiteCaseExecutor', () => {
  const trace: HostRunResult = { finalText: 'ok', events: [], durationMs: 7 };

  /** Install `host` as `test/<name>` and return that reference. */
  function installTestHost(name: string, host: HostDefinition): string {
    installPlugins([
      {
        meta: { name: 'test-plugin', namespace: 'test' },
        hosts: { [name]: host },
      },
    ]);
    return `test/${name}`;
  }

  afterEach(() => resetPluginsForTests());

  it('consumes each batch trace once and never resubmits', async () => {
    const type = installTestHost('case-execution-batch-host', {
      schema: z.object({ type: z.string() }),
      evidence: 'structured',
      runBatch: async () => [],
    });
    const execute = createSuiteCaseExecutor({
      servers: [],
      host: { type },
      manifest,
      batchTraces: new Map([['host', [trace]]]),
    });
    await expect(execute(hostCase)).resolves.toMatchObject({
      kind: 'host',
      evidence: 'structured',
      preExecutionDurationMs: 7,
    });
    await expect(execute(hostCase)).rejects.toThrow(
      'Batch trace already consumed or missing; refusing to resubmit.'
    );
  });

  it('dispatches per case to run() with the declared evidence', async () => {
    const run = vi.fn(async () => trace);
    const type = installTestHost('case-execution-run-host', {
      schema: z.object({ type: z.string() }),
      evidence: 'observed',
      run,
    });
    const execute = createSuiteCaseExecutor({
      servers: [],
      host: { type },
      manifest,
    });
    await expect(execute(hostCase)).resolves.toMatchObject({
      kind: 'host',
      evidence: 'observed',
    });
    expect(run).toHaveBeenCalledWith(
      { scenario: 'query', servers: [], env: undefined },
      { type },
      expect.objectContaining({ mcpHostConfig: hostCase.mcpHostConfig })
    );
  });

  describe('with a tool variant', () => {
    const servers = [
      { transport: 'stdio' as const, command: 'agg', label: 'agg' },
    ];
    function stubProxy(listedTools: boolean): ToolSurfaceProxy {
      return {
        serversFor: (scope) => [
          {
            transport: 'http',
            serverUrl: `http://127.0.0.1:1/${scope}/0/mcp`,
            label: 'agg',
          },
        ],
        activity: () => ({ listedTools, calls: [] }),
        endScope: () => ({ listedTools, calls: [] }),
        originalName: (name) => (name === 'find_more' ? 'find_skills' : name),
        close: async () => {},
      };
    }
    const variantManifest = {
      ...manifest,
      toolOverrides: {
        id: 'renamed',
        tools: { find_skills: { name: 'find_more' } },
      },
    };

    it('runs a proxied host on per-case proxy servers without the variant', async () => {
      const run = vi.fn(async () => ({
        finalText: 'ok',
        events: [
          {
            kind: 'tool_call' as const,
            source: 'mcp' as const,
            name: 'find_more',
            arguments: {},
          },
        ],
      }));
      const type = installTestHost('proxied-run-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        run,
      });
      const proxy = stubProxy(true);
      const execute = createSuiteCaseExecutor({
        servers,
        host: { type },
        manifest: variantManifest,
        toolVariant: { id: 'renamed', proxy: async () => proxy },
      });
      const execution = await execute(hostCase);
      expect(execution).toMatchObject({ kind: 'host' });
      const [input, , context] = run.mock.calls[0] as unknown as [
        { servers: Array<{ serverUrl: string }> },
        unknown,
        { manifest: Record<string, unknown> },
      ];
      expect(input.servers[0]?.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:1\//);
      expect(context.manifest).not.toHaveProperty('toolOverrides');
      expect(
        execution.kind === 'host' ? execution.trace?.events : undefined
      ).toMatchObject([
        { name: 'find_skills', rawName: 'find_more', server: 'agg' },
      ]);
    });

    it('fails a case whose host never listed the proxied tools', async () => {
      const type = installTestHost('proxied-ignoring-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        run: async () => ({ finalText: 'ok', events: [] }),
      });
      const execute = createSuiteCaseExecutor({
        servers,
        host: { type },
        manifest: variantManifest,
        toolVariant: { id: 'renamed', proxy: async () => stubProxy(false) },
      });
      await expect(execute(hostCase)).resolves.toMatchObject({
        error: expect.stringContaining(
          'the model didn\'t see tool variant "renamed"'
        ),
      });
    });

    it('leaves a host that applies variants itself on the real servers', async () => {
      const run = vi.fn(async () => trace);
      const type = installTestHost('native-variant-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        toolOverrides: true,
        run,
      });
      const proxy = vi.fn(async () => stubProxy(true));
      const execute = createSuiteCaseExecutor({
        servers,
        host: { type },
        manifest: variantManifest,
        toolVariant: { id: 'renamed', proxy },
      });
      await execute(hostCase);
      expect(proxy).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ servers }),
        { type },
        expect.objectContaining({ manifest: variantManifest })
      );
    });
  });

  it('requires a routable server for direct cases', async () => {
    const execute = createSuiteCaseExecutor({
      servers: [
        { transport: 'stdio', command: 'a', label: 'a' },
        { transport: 'stdio', command: 'b', label: 'b' },
      ],
      host: { type: 'unused' },
      manifest,
    });
    await expect(
      execute({ id: 'd', toolName: 'unqualified', args: {} })
    ).rejects.toThrow(
      'Direct cases require one server, a label-qualified tool name, or request.server.'
    );
  });
});
