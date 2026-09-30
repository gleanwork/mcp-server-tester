import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSuiteCaseExecutor, executeEvalCase } from './caseExecution.js';
import { runEvalCase } from './evalRunner.js';
import type { EvalCase } from './datasetTypes.js';
import type { HostRunResult } from './evalFrameworkTypes.js';
import { registerHost } from './frameworkRegistries.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type * as SimulationModule from './mcpHost/mcpHostSimulation.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';

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
          cli: { command: 'claude', args: [], claudeMcpServers: ['glean'] },
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

  it('consumes each batch trace once and never resubmits', async () => {
    const type = 'case-execution-batch-host';
    registerHost({
      name: type,
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
    const type = 'case-execution-run-host';
    const run = vi.fn(async () => trace);
    registerHost({
      name: type,
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
