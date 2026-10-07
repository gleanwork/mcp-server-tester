import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createSuiteCaseExecutor,
  executeEvalCase,
  playwrightClientOf,
} from './caseExecution.js';
import { runEvalCase } from './evalRunner.js';
import type { EvalCase } from './datasetTypes.js';
import type {
  ClientDefinition,
  ClientRunResult,
} from './evalFrameworkTypes.js';
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
  input: 'query',
};
const evalConfig = { name: 'm', datasets: [] };

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

  it("runs on the run's mst client, with the case's own fields over it", async () => {
    vi.mocked(simulateMCPHost).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
    });
    await executeEvalCase(
      { ...hostCase, clientOptions: { systemPrompt: 'Case prompt.' } },
      mcp,
      {
        client: 'mst',
        model: 'gpt-5',
        clientOptions: { systemPrompt: 'Run prompt.', maxToolCalls: 9 },
      }
    );
    expect(simulateMCPHost).toHaveBeenCalledWith(
      mcp,
      'query',
      expect.objectContaining({
        hostType: 'sdk',
        provider: 'openai',
        model: 'gpt-5',
        systemPrompt: 'Case prompt.',
        maxToolCalls: 9,
      })
    );
  });

  it('fails a case on another client, which runs in a suite', async () => {
    await expect(
      executeEvalCase({ ...hostCase, client: 'claude-code' }, mcp)
    ).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('Run "claude-code" in a suite (mst run).'),
    });
    expect(simulateMCPHost).not.toHaveBeenCalled();
  });

  it("doesn't carry the run's options to a case's own client", () => {
    expect(
      playwrightClientOf(
        { ...hostCase, client: 'mst', model: 'claude-haiku-4-5' },
        { client: 'acme/other', model: 'x', clientOptions: { region: 'eu' } }
      )
    ).toEqual({ model: 'claude-haiku-4-5' });
  });

  it('reports a missing connection as a failed execution', async () => {
    await expect(
      executeEvalCase({ id: 'd', input: 'query' }, undefined)
    ).resolves.toMatchObject({
      kind: 'failed',
      error: 'The mst client requires an MCP connection.',
    });
  });
});

describe('custom executeCase results', () => {
  it('fails a pre-2.0 untyped result loudly', async () => {
    const result = await runEvalCase(
      {
        id: 'legacy',
        input: 'query',
        assertions: { toolsTriggered: { calls: [{ name: 'search' }] } },
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
      "executeCase must return a CaseExecution with kind 'host' or 'failed'"
    );
  });

  it("fails a 'direct' execution, which 2.0 removed", async () => {
    const result = await runEvalCase(
      { id: 'direct', input: 'query', assertions: { containsText: 'ok' } },
      {},
      {
        executeCase: (async () => ({
          kind: 'direct',
          response: { content: [{ type: 'text', text: 'ok' }] },
        })) as never,
      }
    );
    expect(result.pass).toBe(false);
    expect(result.error).toContain("kind 'host' or 'failed'");
  });
});

describe('createSuiteCaseExecutor', () => {
  const trace: ClientRunResult = { finalText: 'ok', events: [], durationMs: 7 };

  /** Install `host` as `test/<name>` and return that reference. */
  function installTestHost(name: string, host: ClientDefinition): string {
    installPlugins([
      {
        meta: { name: 'test-plugin', namespace: 'test' },
        clients: { [name]: host },
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
      evalConfig,
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
      evalConfig,
    });
    await expect(execute(hostCase)).resolves.toMatchObject({
      kind: 'host',
      evidence: 'observed',
    });
    expect(run).toHaveBeenCalledWith(
      { prompt: 'query', servers: [], env: undefined },
      { type },
      { evalConfig, variant: undefined, env: undefined }
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
    const variantConfig = {
      ...evalConfig,
      tools: { find_skills: { name: 'find_more' } },
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
        evalConfig: variantConfig,
        toolVariant: { id: 'renamed', proxy: async () => proxy },
      });
      const execution = await execute(hostCase);
      expect(execution).toMatchObject({ kind: 'host' });
      const [input, , context] = run.mock.calls[0] as unknown as [
        { servers: Array<{ serverUrl: string }> },
        unknown,
        { evalConfig: Record<string, unknown> },
      ];
      expect(input.servers[0]?.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:1\//);
      expect(context.evalConfig).not.toHaveProperty('tools');
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
        evalConfig: variantConfig,
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
        toolMetadata: true,
        run,
      });
      const proxy = vi.fn(async () => stubProxy(true));
      const execute = createSuiteCaseExecutor({
        servers,
        host: { type },
        evalConfig: variantConfig,
        toolVariant: { id: 'renamed', proxy },
      });
      await execute(hostCase);
      expect(proxy).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ servers }),
        { type },
        expect.objectContaining({ evalConfig: variantConfig })
      );
    });
  });
});
