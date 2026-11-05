import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import type { SkillLoad } from '../types/index.js';
import { clientRunToExecution } from './clientTrace.js';
import { runApiClient } from './mstClient/run.js';
import type * as ClientRunModule from './mstClient/run.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import {
  readyStdioServer,
  startReadinessHttpServer,
} from '../../tests/mocks/readyServers.js';

vi.mock('./mstClient/run.js', async (original) => ({
  ...(await original<typeof ClientRunModule>()),
  runApiClient: vi.fn(),
}));

const mcp = { authType: 'none' } as MCPFixtureApi;
const clientCase: EvalCase = {
  id: 'client',
  input: 'query',
};
const evalConfig = { name: 'm', datasets: [] };

beforeEach(() => vi.mocked(runApiClient).mockReset());

describe('executeEvalCase', () => {
  it('adapts a successful api run to a client execution', async () => {
    vi.mocked(runApiClient).mockResolvedValue({
      finalText: 'answer',
      events: [],
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    });
    await expect(executeEvalCase(clientCase, mcp)).resolves.toMatchObject({
      kind: 'completed',
      response: { success: true, response: 'answer' },
      usage: { inputTokens: 1 },
    });
  });

  it('fails an api failure without keeping its response', async () => {
    vi.mocked(runApiClient).mockResolvedValue({
      finalText: '',
      events: [],
      error: 'rejected',
    });
    await expect(executeEvalCase(clientCase, mcp)).resolves.toEqual({
      kind: 'failed',
      response: undefined,
      error: 'rejected',
      // Nothing names what broke: the client failed its trial.
      ending: { kind: 'trial' },
    });
  });

  it('keeps what a client failure says broke', async () => {
    // A CLI that didn't start says so with its failure kind (ADR 0010).
    vi.mocked(runApiClient).mockResolvedValue({
      finalText: '',
      events: [],
      error: 'CLI client process failed: exit 1',
      diagnostics: { failureKind: 'startup' },
    });
    await expect(executeEvalCase(clientCase, mcp)).resolves.toMatchObject({
      kind: 'failed',
      ending: {
        kind: 'infrastructure',
        broke: 'client-app',
        retryable: true,
        reason: 'CLI client process failed: exit 1',
      },
    });
  });

  it("runs on the run's api client, with the case's own fields over it", async () => {
    vi.mocked(runApiClient).mockResolvedValue({
      finalText: 'answer',
      events: [],
    });
    await executeEvalCase(
      { ...clientCase, clientOptions: { systemPrompt: 'Case prompt.' } },
      mcp,
      {
        client: 'api',
        model: 'gpt-5',
        clientOptions: { systemPrompt: 'Run prompt.', maxToolCalls: 9 },
      }
    );
    expect(runApiClient).toHaveBeenCalledWith(
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
    expect(runApiClient).not.toHaveBeenCalled();
  });

  it("doesn't carry the run's options to a case's own client", () => {
    expect(
      playwrightClientOf(
        { ...clientCase, client: 'api', model: 'claude-haiku-4-5' },
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
      error: 'The api client requires an MCP connection.',
    });
  });
});

describe('custom executeCase results', () => {
  it('derives a trace from the existing response view without changing provenance', async () => {
    const result = await runEvalCase(
      { id: 'custom', input: 'query' },
      {},
      {
        executeCase: async () => ({
          kind: 'completed',
          response: {
            success: true,
            response: 'answer',
            toolCalls: [
              { name: 'search', arguments: { q: 'query' }, output: 'found' },
              { name: 'Bash', source: 'builtin', arguments: {}, id: 'native' },
            ],
          },
        }),
      }
    );
    expect(result.pass).toBe(true);
    expect(result.trace).toMatchObject({
      finalText: 'answer',
      events: [
        { kind: 'tool_call', source: 'mcp', name: 'search', output: 'found' },
        { kind: 'tool_call', source: 'builtin', name: 'Bash', id: 'native' },
      ],
    });
    expect(result.traceEvidence).toBeUndefined();
  });

  it('keeps explicit native events instead of rebuilding them from toolCalls', async () => {
    const events: ClientRunResult['events'] = [
      { kind: 'skill', source: 'builtin', name: 'review' },
      {
        kind: 'tool_search',
        source: 'builtin',
        name: 'ToolSearch',
        results: [{ name: 'search', server: 'docs' }],
      },
    ];
    const result = await runEvalCase(
      { id: 'custom-events', input: 'query' },
      {},
      {
        executeCase: async () => ({
          kind: 'completed',
          response: {
            success: true,
            toolCalls: [],
            events,
            evidence: 'structured',
          },
        }),
      }
    );
    expect(result.trace?.events).toEqual(events);
    expect(result.traceEvidence).toBe('structured');
  });

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

describe('client skill loads at the result boundary', () => {
  const load: SkillLoad = {
    name: 'weather',
    uri: 'skill://weather/SKILL.md',
    server: 'weather',
    kind: 'skill',
    via: 'read_skill',
    verified: true,
    afterToolCalls: 0,
  };

  it('keeps skill loads per trial without requiring a stored response', async () => {
    vi.mocked(runApiClient)
      .mockResolvedValueOnce({
        finalText: 'answer',
        events: [],
        telemetry: { skillLoads: [load] },
      })
      .mockResolvedValueOnce({
        finalText: 'answer',
        events: [],
        telemetry: { skillLoads: [] },
      });
    const result = await runEvalCase({ ...clientCase, trials: 2 }, { mcp });
    expect(result.trialResults?.map((trial) => trial.skillLoads)).toEqual([
      [load],
      [],
    ]);
    expect(result.passRate).toBe(1);
  });

  it.each([
    undefined,
    null,
    {},
    [null],
    [{ name: 'incomplete' }],
    [{ ...load, problems: [5] }],
  ])('does not expose malformed telemetry.skillLoads: %j', (skillLoads) => {
    const execution = clientRunToExecution(
      { finalText: '', events: [], telemetry: { skillLoads } },
      'structured'
    );
    expect(execution.response).not.toHaveProperty('skillLoads');
  });

  it('preserves empty versus absent skill loads', () => {
    expect(
      clientRunToExecution(
        { finalText: '', events: [], telemetry: { skillLoads: [] } },
        'structured'
      ).response.skillLoads
    ).toEqual([]);
    expect(
      clientRunToExecution({ finalText: '', events: [] }, 'structured').response
    ).not.toHaveProperty('skillLoads');
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
    await expect(execute(clientCase)).resolves.toMatchObject({
      kind: 'failed',
      error: 'Batch trace already consumed or missing; refusing to resubmit.',
    });
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

  it("redacts every client's result before grading", async () => {
    const envKey = 'sk-env-0123456789';
    const fileSecret = 'file-secret-0123';
    const type = installTestClient('case-execution-redact', {
      schema: z.object({ type: z.string() }),
      run: async () => ({
        finalText: `answer with ${envKey}`,
        events: [],
        telemetry: { content: { history: fileSecret } },
      }),
    });
    const execute = createEvalCaseExecutor({
      servers: [],
      client: { type },
      evalConfig,
      env: { ACME_API_KEY: envKey },
      secrets: () => [fileSecret],
    });
    const execution = await execute(clientCase);
    expect(JSON.stringify(execution)).not.toContain(envKey);
    expect(JSON.stringify(execution)).not.toContain(fileSecret);
    expect(execution).toMatchObject({
      kind: 'completed',
      response: { response: 'answer with [REDACTED]' },
      telemetry: { content: { history: '[REDACTED]' } },
    });
  });

  it('redacts the error a run throws, after reading its ending', async () => {
    const envKey = 'sk-env-0123456789';
    const throwing = installTestClient('case-execution-redact-throw', {
      schema: z.object({ type: z.string() }),
      run: async () => {
        throw Object.assign(new Error(`connect failed for ${envKey}`), {
          code: 'ECONNRESET',
        });
      },
    });
    const failed = await createEvalCaseExecutor({
      servers: [],
      client: { type: throwing },
      evalConfig,
      env: { ACME_API_KEY: envKey },
    })(clientCase);
    // The ending is read from the error before its message is redacted.
    expect(failed).toMatchObject({
      kind: 'failed',
      error: 'connect failed for [REDACTED]',
      ending: { kind: 'infrastructure', broke: 'network' },
    });
    expect(JSON.stringify(failed)).not.toContain(envKey);
  });

  describe('with a tool variant', () => {
    const servers = [{ ...readyStdioServer(), label: 'agg' }];
    // Where the stub proxy's endpoints are: a server the readiness check
    // reaches.
    let proxied: { url: string; close: () => Promise<void> };
    beforeAll(async () => {
      proxied = await startReadinessHttpServer();
    });
    afterAll(() => proxied.close());
    function stubProxy(listedTools: boolean): ToolSurfaceProxy {
      return {
        serversFor: (scope) => [
          {
            transport: 'http',
            serverUrl: `${new URL(proxied.url).origin}/${scope}/0/mcp`,
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
      expect(
        input.servers[0]?.serverUrl.startsWith(new URL(proxied.url).origin)
      ).toBe(true);
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
