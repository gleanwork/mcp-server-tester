import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createEvalCaseExecutor,
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
import { simulateMstClient } from './mstClient/simulation.js';
import type * as SimulationModule from './mstClient/simulation.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';

vi.mock('./mstClient/simulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMstClient: vi.fn(),
}));

const mcp = { authType: 'none' } as MCPFixtureApi;
const clientCase: EvalCase = {
  id: 'client',
  input: 'query',
};
const evalConfig = { name: 'm', datasets: [] };

beforeEach(() => vi.mocked(simulateMstClient).mockReset());

describe('executeEvalCase', () => {
  it('adapts a successful simulation to a client execution', async () => {
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    });
    await expect(executeEvalCase(clientCase, mcp)).resolves.toMatchObject({
      kind: 'completed',
      response: { success: true, response: 'answer' },
      usage: { inputTokens: 1 },
    });
  });

  it('fails a simulation failure without keeping its response', async () => {
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: false,
      toolCalls: [],
      error: 'rejected',
    });
    await expect(executeEvalCase(clientCase, mcp)).resolves.toEqual({
      kind: 'failed',
      response: undefined,
      error: 'rejected',
    });
  });

  it("runs on the run's mst client, with the case's own fields over it", async () => {
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
    });
    await executeEvalCase(
      { ...clientCase, clientOptions: { systemPrompt: 'Case prompt.' } },
      mcp,
      {
        client: 'mst',
        model: 'gpt-5',
        clientOptions: { systemPrompt: 'Run prompt.', maxToolCalls: 9 },
      }
    );
    expect(simulateMstClient).toHaveBeenCalledWith(
      mcp,
      'query',
      expect.objectContaining({
        clientType: 'sdk',
        provider: 'openai',
        model: 'gpt-5',
        systemPrompt: 'Case prompt.',
        maxToolCalls: 9,
      })
    );
  });

  it('fails a case on another client, which runs in an eval', async () => {
    await expect(
      executeEvalCase({ ...clientCase, client: 'claude-code' }, mcp)
    ).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('Run "claude-code" in an eval (mst run).'),
    });
    expect(simulateMstClient).not.toHaveBeenCalled();
  });

  it("doesn't carry the run's options to a case's own client", () => {
    expect(
      playwrightClientOf(
        { ...clientCase, client: 'mst', model: 'claude-haiku-4-5' },
        {
          client: 'acme/client/other',
          model: 'x',
          clientOptions: { region: 'eu' },
        }
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
      "executeCase must return a CaseExecution with kind 'completed' or 'failed'"
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
    expect(result.error).toContain("kind 'completed' or 'failed'");
  });
});

describe('createEvalCaseExecutor', () => {
  const trace: ClientRunResult = { finalText: 'ok', events: [], durationMs: 7 };

  /** Install `host` as `test/client/<name>` and return that reference. */
  function installTestClient(name: string, client: ClientDefinition): string {
    installPlugins([
      {
        meta: { name: 'test-plugin', namespace: 'test' },
        clients: { [name]: client },
      },
    ]);
    return `test/client/${name}`;
  }

  afterEach(() => resetPluginsForTests());

  it('consumes each batch trace once and never resubmits', async () => {
    const type = installTestClient('case-execution-batch-host', {
      schema: z.object({ type: z.string() }),
      evidence: 'structured',
      runBatch: async () => [],
    });
    const execute = createEvalCaseExecutor({
      servers: [],
      client: { type },
      evalConfig,
      batchTraces: new Map([['client', [trace]]]),
    });
    await expect(execute(clientCase)).resolves.toMatchObject({
      kind: 'completed',
      evidence: 'structured',
      preExecutionDurationMs: 7,
    });
    await expect(execute(clientCase)).rejects.toThrow(
      'Batch trace already consumed or missing; refusing to resubmit.'
    );
  });

  it('dispatches per case to run() with the declared evidence', async () => {
    const run = vi.fn(async () => trace);
    const type = installTestClient('case-execution-run-host', {
      schema: z.object({ type: z.string() }),
      evidence: 'observed',
      run,
    });
    const execute = createEvalCaseExecutor({
      servers: [],
      client: { type },
      evalConfig,
    });
    await expect(execute(clientCase)).resolves.toMatchObject({
      kind: 'completed',
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

    it('runs a proxied client on per-case proxy servers without the variant', async () => {
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
      const type = installTestClient('proxied-run-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        run,
      });
      const proxy = stubProxy(true);
      const execute = createEvalCaseExecutor({
        servers,
        client: { type },
        evalConfig: variantConfig,
        toolVariant: { id: 'renamed', proxy: async () => proxy },
      });
      const execution = await execute(clientCase);
      expect(execution).toMatchObject({ kind: 'completed' });
      const [input, , context] = run.mock.calls[0] as unknown as [
        { servers: Array<{ serverUrl: string }> },
        unknown,
        { evalConfig: Record<string, unknown> },
      ];
      expect(input.servers[0]?.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:1\//);
      expect(context.evalConfig).not.toHaveProperty('tools');
      expect(
        execution.kind === 'completed' ? execution.trace?.events : undefined
      ).toMatchObject([
        { name: 'find_skills', rawName: 'find_more', server: 'agg' },
      ]);
    });

    it('fails a case whose client never listed the proxied tools', async () => {
      const type = installTestClient('proxied-ignoring-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        run: async () => ({ finalText: 'ok', events: [] }),
      });
      const execute = createEvalCaseExecutor({
        servers,
        client: { type },
        evalConfig: variantConfig,
        toolVariant: { id: 'renamed', proxy: async () => stubProxy(false) },
      });
      await expect(execute(clientCase)).resolves.toMatchObject({
        error: expect.stringContaining(
          'the model didn\'t see tool variant "renamed"'
        ),
      });
    });

    it('leaves a client that applies variants itself on the real servers', async () => {
      const run = vi.fn(async () => trace);
      const type = installTestClient('native-variant-host', {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        toolMetadata: true,
        run,
      });
      const proxy = vi.fn(async () => stubProxy(true));
      const execute = createEvalCaseExecutor({
        servers,
        client: { type },
        evalConfig: variantConfig,
        toolVariant: { id: 'renamed', proxy },
      });
      await execute(clientCase);
      expect(proxy).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ servers }),
        { type },
        expect.objectContaining({ evalConfig: variantConfig })
      );
    });
  });
});
