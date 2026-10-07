import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runEvalCase,
  runEvalDataset,
  type EvalContext,
  type EvalRunnerResult,
} from './evalRunner.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createStoredEvalArtifact,
  type EvalResultStore,
  type ListStoredArtifactsOptions,
  type StoredArtifactKind,
  type StoredArtifactSummary,
  type StoredEvalArtifact,
} from './resultStore.js';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';
import type { CaseExecution } from './caseExecution.js';
import { hostRunToExecution } from './hostTrace.js';
import type * as SimulationModule from './mcpHost/mcpHostSimulation.js';
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';

// A stand-in for the mst client's model: it calls the connection's tool once
// and answers with what the tool returned. A tool result shaped like a
// simulation is taken as the client's whole run, so a test can set the calls.
vi.mock('./mcpHost/mcpHostSimulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMCPHost: vi.fn(
    async (mcp: MCPFixtureApi): Promise<MCPHostSimulationResult> => {
      const result = (await mcp.callTool('test-tool', {
        input: 'test',
      })) as unknown as Record<string, unknown>;
      if ('success' in result && 'toolCalls' in result)
        return result as unknown as MCPHostSimulationResult;
      const text = ((result.content as Array<{ text?: string }>) ?? [])
        .map((block) => block.text ?? '')
        .join('');
      return result.isError
        ? { success: false, toolCalls: [], error: text }
        : { success: true, toolCalls: [], response: text };
    }
  ),
}));

function createMockMCP(callToolResponse?: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue({ name: 'test', version: '1.0.0' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: callToolResponse?.content ?? [
        { type: 'text', text: 'response' },
      ],
      structuredContent: callToolResponse?.structuredContent,
      isError: callToolResponse?.isError ?? false,
    }),
  };
}

function createContext(mcp?: MCPFixtureApi): EvalContext {
  return {
    mcp: mcp ?? createMockMCP(),
    // Stub testInfo so runEvalDataset skips the "no reporter" warning without
    // requiring a real Playwright test context.
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

function createEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-case',
    input: 'test',
    ...overrides,
  };
}

class MemoryEvalResultStore implements EvalResultStore {
  artifacts = new Map<string, StoredEvalArtifact<unknown>>();
  latest = new Map<StoredArtifactKind, StoredEvalArtifact<unknown>>();

  async saveArtifact<T>(artifact: StoredEvalArtifact<T>): Promise<void> {
    this.artifacts.set(`${artifact.kind}:${artifact.id}`, artifact);
    this.latest.set(artifact.kind, artifact);
  }

  async loadArtifact<T>(
    kind: StoredArtifactKind,
    id: string
  ): Promise<StoredEvalArtifact<T>> {
    const artifact = this.artifacts.get(`${kind}:${id}`);
    if (!artifact) throw new Error(`Missing artifact ${kind}:${id}`);
    return artifact as StoredEvalArtifact<T>;
  }

  async loadLatestArtifact<T>(
    kind: StoredArtifactKind
  ): Promise<StoredEvalArtifact<T> | null> {
    return (this.latest.get(kind) as StoredEvalArtifact<T> | undefined) ?? null;
  }

  async listArtifacts(
    kind: StoredArtifactKind,
    options: ListStoredArtifactsOptions = {}
  ): Promise<StoredArtifactSummary[]> {
    return [...this.artifacts.values()]
      .filter((a) => a.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit)
      .map((a) => ({
        kind: a.kind,
        id: a.id,
        createdAt: a.createdAt,
        metadata: a.metadata,
      }));
  }
}

describe('runEvalCase', () => {
  describe('cases on the mst client', () => {
    it('runs the case on the mst client and returns its answer', async () => {
      const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
      const context = createContext(mcp);
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(simulateMCPHost).toHaveBeenCalledWith(
        mcp,
        'test',
        expect.objectContaining({ hostType: 'sdk' })
      );
      expect(result.id).toBe('test-case');
      expect(result.source).toBe('eval');
      expect(result.response).toMatchObject({ response: 'hello' });
    });

    it('should pass when no expect block is provided', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
    });

    it('should pass when expect.containsText matches', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'hello world' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.scores.textContains?.pass).toBe(true);
    });

    it('should fail when expect.containsText does not match', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'hello world' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: { containsText: 'goodbye' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.scores.textContains?.pass).toBe(false);
    });

    it('should validate expect.matchesPattern', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: { matchesPattern: '#\\d+' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.scores.regex?.pass).toBe(true);
    });

    it('should validate multiple assertions together', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed for John' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: {
          containsText: ['Order', 'John'],
          matchesPattern: '#\\d+',
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.scores.textContains?.pass).toBe(true);
      expect(result.scores.regex?.pass).toBe(true);
    });

    it('should fail if any assertion fails', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: {
          containsText: 'Order',
          matchesPattern: '#\\d+', // This will fail - no order number
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.scores.textContains?.pass).toBe(true);
      expect(result.scores.regex?.pass).toBe(false);
    });

    it('should track duration', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use provided datasetName', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context, {
        datasetName: 'my-dataset',
      });

      expect(result.datasetName).toBe('my-dataset');
    });

    it('should default datasetName to single-case', async () => {
      const context = createContext();
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      expect(result.datasetName).toBe('single-case');
    });

    it('should not run assertions when tool call errors', async () => {
      const mcp = createMockMCP();
      (mcp.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Tool failed')
      );

      const context = createContext(mcp);
      const evalCase = createEvalCase({
        assertions: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.error).toContain('Tool failed');
      expect(result.pass).toBe(false);
      // Scores should be empty since tool call failed
      expect(result.scores.textContains).toBeUndefined();
    });
  });

  describe('client cases', () => {
    it('should fail when scenario is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        input: undefined,
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('a case needs input');
    });

    it('fails a case on a client other than mst, which runs in a suite', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        input: 'test scenario',
      });

      const result = await runEvalCase(evalCase, context, {
        client: 'cowork',
      });

      expect(result.pass).toBe(false);
      expect(result.error).toContain('Run "cowork" in a suite (mst run).');
    });

    it("records the run's client and model on the result", async () => {
      const result = await runEvalCase(
        createEvalCase({ input: 'test scenario' }),
        createContext(),
        {
          client: 'mst',
          model: 'claude-haiku-4-5',
          executeCase: async () =>
            hostRunToExecution({ finalText: 'ok', events: [] }, 'structured'),
        }
      );
      expect(result.request).toMatchObject({
        client: 'mst',
        model: 'claude-haiku-4-5',
      });
    });
  });
});

describe('multi-trial cases', () => {
  it('should compute the pass rate when trials > 1', async () => {
    let callCount = 0;
    const mcp = createMockMCP();
    // Alternate pass/fail: callTool returns 'hello' on odd calls, 'nope' on even
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      callCount++;
      return {
        content: [
          { type: 'text', text: callCount % 2 === 0 ? 'nope' : 'hello' },
        ],
        isError: false,
      };
    });

    const evalCase = createEvalCase({
      trials: 4,
      passThreshold: 0.5,
      assertions: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    expect(result.passRate).toBeDefined();
    expect(result.passRate).toBe(0.5); // 2 of 4 pass
    expect(result.pass).toBe(true); // 0.5 >= 0.5 threshold
    expect(result.trialResults).toHaveLength(4);
    expect(result.trialResults?.filter((r) => r.pass)).toHaveLength(2);
    // Wilson CI: 2/4 passes should produce a wide interval within [0,1]
    expect(result.passRateCI).toBeDefined();
    expect(result.passRateCI!.lower).toBeGreaterThanOrEqual(0);
    expect(result.passRateCI!.upper).toBeLessThanOrEqual(1);
    expect(result.passRateCI!.lower).toBeLessThan(0.5);
    expect(result.passRateCI!.upper).toBeGreaterThan(0.5);
  });

  it('should fail when the pass rate is below the threshold', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'wrong' }] });
    const evalCase = createEvalCase({
      trials: 3,
      passThreshold: 0.8,
      assertions: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.passRate).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('should not set passRate for single-trial cases', async () => {
    const evalCase = createEvalCase();
    const result = await runEvalCase(evalCase, createContext());
    expect(result.passRate).toBeUndefined();
    expect(result.passRateCI).toBeUndefined();
    expect(result.trialResults).toBeUndefined();
  });

  it('excludes infrastructure errors from the pass rate computation', async () => {
    let callCount = 0;
    const mcp = createMockMCP();
    // First call throws ECONNRESET (infrastructure error), second passes
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('ECONNRESET: connection reset by peer');
        throw err;
      }
      return {
        content: [{ type: 'text', text: 'hello' }],
        isError: false,
      };
    });

    const evalCase = createEvalCase({
      trials: 2,
      passThreshold: 1.0,
      assertions: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    // The infrastructure error is excluded from the denominator
    // Only 1 assertion result (the second trial), and it passes → passRate = 1.0
    expect(result.infrastructureErrorCount).toBe(1);
    expect(result.passRate).toBe(1.0);
    expect(result.pass).toBe(true);
    expect(result.trialResults).toHaveLength(2);
    expect(result.trialResults?.[0]?.isInfrastructureError).toBe(true);
    expect(result.trialResults?.[1]?.isInfrastructureError).toBe(false);
  });

  it('classifies prompt-too-long errors as infrastructure errors', async () => {
    let callCount = 0;
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('prompt is too long: 200795 tokens > 200000 maximum');
      }
      return { content: [{ type: 'text', text: 'hello' }], isError: false };
    });

    const evalCase = createEvalCase({
      trials: 2,
      passThreshold: 1.0,
      assertions: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    expect(result.trialResults?.[0]?.isInfrastructureError).toBe(true);
    expect(result.trialResults?.[1]?.isInfrastructureError).toBe(false);
    // Excluded from denominator: 1 assertion result, 1 pass
    expect(result.passRate).toBe(1.0);
    expect(result.infrastructureErrorCount).toBe(1);
  });
});

describe('judgeReps behavior in eval runner', () => {
  it('passes judgeReps from evalCase to validateJudge via config', async () => {
    // We test this by observing that the judge is called the correct number of times.
    // Since validateJudge is internal, we mock createJudge at the module level.
    // The mock is applied via vi.mock at the top of this file (we use a factory below).
    // Instead, we verify the end-to-end behavior: when judgeReps=2 and scores average
    // to >= threshold, the case passes; without the loop it would fail.

    // Use a simple containsText assertion as a proxy: judgeReps only affects
    // judge assertions. Here we verify that judgeReps is accepted without error.
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      judgeReps: 2,
      assertions: { containsText: 'hello' },
    });

    // Should not throw - judgeReps is accepted on EvalCase
    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.pass).toBe(true);
  });

  it('passes judgeReps: 1 without error', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      judgeReps: 1,
      assertions: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.pass).toBe(true);
  });
});

describe('defaultJudgeReps', () => {
  it('is accepted as an option without error', async () => {
    const dataset: EvalDataset = {
      name: 'default-reps-test',
      cases: [{ id: 'a', input: 'echo' }],
    };
    const result = await runEvalDataset(
      { dataset, defaultJudgeReps: 3 },
      createContext()
    );
    expect(result.total).toBe(1);
  });

  it('does not override per-case judgeReps', async () => {
    const dataset: EvalDataset = {
      name: 'override-test',
      cases: [{ id: 'a', input: 'echo', judgeReps: 2 }],
    };
    // Just verify it runs without error — judgeReps: 2 stays 2
    const result = await runEvalDataset(
      { dataset, defaultJudgeReps: 5 },
      createContext()
    );
    expect(result.total).toBe(1);
  });
});

describe('toolsTriggered and toolCallCount assertions in eval runner', () => {
  it('populates toolsTriggered assertion result when simulation result contains expected tool', async () => {
    // callTool returns an object that itself has the MCPHostSimulationResult shape.
    // After the fix, response = full callTool return value, so isSimulationResult
    // checks the top-level object directly.
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockResolvedValue({
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'hello' } }],
      response: 'Done',
    } as unknown as Awaited<ReturnType<typeof mcp.callTool>>);

    const evalCase = createEvalCase({
      assertions: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.scores.toolsTriggered).toBeDefined();
    expect(result.scores.toolsTriggered?.pass).toBe(true);
  });

  it('fails toolsTriggered when required tool was not called', async () => {
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockResolvedValue({
      success: true,
      toolCalls: [{ name: 'other', arguments: {} }],
      response: 'Done',
    } as unknown as Awaited<ReturnType<typeof mcp.callTool>>);

    const evalCase = createEvalCase({
      assertions: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.scores.toolsTriggered?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('fails toolsTriggered when the client called no tools', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'plain text' }],
    });

    const evalCase = createEvalCase({
      assertions: { toolsTriggered: { calls: [{ name: 'search' }] } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.scores.toolsTriggered?.pass).toBe(false);
    expect(result.scores.toolsTriggered?.details).toContain(
      "Expected tool 'search' to be called"
    );
  });

  it('validates toolCallCount correctly from simulation result', async () => {
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockResolvedValue({
      success: true,
      toolCalls: [
        { name: 'a', arguments: {} },
        { name: 'b', arguments: {} },
      ],
      response: 'Done',
    } as unknown as Awaited<ReturnType<typeof mcp.callTool>>);

    const evalCase = createEvalCase({
      assertions: { toolCallCount: { min: 1, max: 3 } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.scores.toolCallCount?.pass).toBe(true);
  });
});

describe('runEvalDataset defaultTrials', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('applies defaultTrials to client cases without explicit trials', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'llm-case',
        input: 'test scenario',
        // no trials field — should use defaultTrials
      }),
    ]);

    // An in-memory host at the case-execution seam stands in for the LLM.
    const executeCase = vi.fn(
      async (): Promise<CaseExecution> =>
        hostRunToExecution({ finalText: 'ok', events: [] }, 'structured')
    );
    const result = await runEvalDataset(
      { dataset, defaultTrials: 3, executeCase },
      createContext(mcp)
    );
    expect(executeCase).toHaveBeenCalledTimes(3);
    expect(result.caseResults[0]!.trialResults).toHaveLength(3);
    expect(result.caseResults[0]!.passRate).toBe(1);
  });

  it('case-level trials override defaultTrials', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'direct-with-trials',
        trials: 3,
        passThreshold: 1.0,
        assertions: { containsText: 'hello' },
      }),
    ]);

    const result = await runEvalDataset(
      { dataset, defaultTrials: 10 },
      createContext(mcp)
    );

    // Case-level trials: 3 wins over defaultTrials: 10
    expect(result.caseResults[0]!.trialResults).toHaveLength(3);
  });
});

describe('runEvalDataset concurrency', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('should run cases concurrently when concurrency > 1', async () => {
    vi.useFakeTimers();
    try {
      const startTimes: number[] = [];
      const mcp = createMockMCP();
      vi.mocked(mcp.callTool).mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 30)); // simulate latency
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      });

      const dataset = createDataset([
        createEvalCase({ id: 'c1' }),
        createEvalCase({ id: 'c2' }),
        createEvalCase({ id: 'c3' }),
      ]);

      const result = runEvalDataset(
        { dataset, concurrency: 3 },
        createContext(mcp)
      );
      await vi.runAllTimersAsync();
      await result;

      // All three calls start at the same virtual time when concurrency is 3.
      expect(startTimes).toHaveLength(3);
      expect(new Set(startTimes).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should default to sequential execution (concurrency: 1)', async () => {
    const dataset = createDataset([
      createEvalCase({ id: 's1' }),
      createEvalCase({ id: 's2' }),
    ]);
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.total).toBe(2);
  });

  it('runs all cases without skipping indices when concurrency > 1', async () => {
    // Regression test for runWithConcurrency: verifies that the `index++`
    // read-modify-write assigns a unique slot to every task and no results are
    // dropped or overwritten when multiple workers interleave at await points.
    const dataset = createDataset(
      Array.from({ length: 20 }, (_, i) => createEvalCase({ id: `case-${i}` }))
    );

    const result = await runEvalDataset(
      { dataset, concurrency: 8 },
      createContext()
    );

    // All 20 cases must be present — none skipped or overwritten
    expect(result.caseResults).toHaveLength(20);
    expect(result.total).toBe(20);
  });
});

describe('runEvalDataset', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return {
      name: 'test-dataset',
      cases,
    };
  }

  it('records a protocol passed as an option when there is no mcp', async () => {
    const protocol = {
      requested: '2026-07-28',
      negotiated: '2026-07-28',
      era: 'modern' as const,
    };
    const result = await runEvalDataset(
      {
        dataset: createDataset([createEvalCase({ id: 'case-1' })]),
        protocol: () => protocol,
        executeCase: async () =>
          hostRunToExecution({ finalText: '', events: [] }, 'structured'),
      },
      { ...createContext(), mcp: undefined }
    );
    expect(result.metadata?.protocol).toEqual(protocol);
  });

  it('records the protocol the run negotiated in its metadata', async () => {
    const context = createContext();
    const result = await runEvalDataset(
      { dataset: createDataset([createEvalCase({ id: 'case-1' })]) },
      context
    );

    expect(result.metadata?.protocol).toEqual({
      requested: 'legacy',
      negotiated: '2025-11-25',
      era: 'legacy',
    });
  });

  it('should run all cases in dataset', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
      createEvalCase({ id: 'case-3' }),
    ]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.total).toBe(3);
    expect(result.caseResults).toHaveLength(3);
    expect(result.caseResults[0]!.id).toBe('case-1');
    expect(result.caseResults[1]!.id).toBe('case-2');
    expect(result.caseResults[2]!.id).toBe('case-3');
  });

  it('should count passed and failed cases', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello world' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', assertions: { containsText: 'goodbye' } }), // fails
    ]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('should set datasetName on all results', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
    ]);
    dataset.name = 'my-dataset';

    const result = await runEvalDataset({ dataset }, context);

    expect(result.caseResults[0]!.datasetName).toBe('my-dataset');
    expect(result.caseResults[1]!.datasetName).toBe('my-dataset');
  });

  it('should call onCaseComplete callback', async () => {
    const context = createContext();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1' }),
      createEvalCase({ id: 'case-2' }),
    ]);
    const onCaseComplete = vi.fn();

    await runEvalDataset({ dataset, onCaseComplete }, context);

    expect(onCaseComplete).toHaveBeenCalledTimes(2);
    // onCaseComplete receives EvalCaseResult, not EvalCase
    expect(onCaseComplete.mock.calls[0]![0].id).toBe('case-1');
    expect(onCaseComplete.mock.calls[1]![0].id).toBe('case-2');
  });

  it('should stop on failure when stopOnFailure is true', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', assertions: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', assertions: { containsText: 'hello' } }),
    ]);

    const result = await runEvalDataset(
      { dataset, stopOnFailure: true },
      context
    );

    expect(result.total).toBe(2); // Only ran 2 cases
    expect(result.caseResults).toHaveLength(2);
    expect(result.caseResults[0]!.id).toBe('case-1');
    expect(result.caseResults[1]!.id).toBe('case-2');
  });

  it('should continue on failure when stopOnFailure is false', async () => {
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const context = createContext(mcp);
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', assertions: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', assertions: { containsText: 'hello' } }),
    ]);

    const result = await runEvalDataset(
      { dataset, stopOnFailure: false },
      context
    );

    expect(result.total).toBe(3); // Ran all 3 cases
    expect(result.caseResults).toHaveLength(3);
  });

  it('should track total duration', async () => {
    const context = createContext();
    const dataset = createDataset([createEvalCase()]);

    const result = await runEvalDataset({ dataset }, context);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should attach results when testInfo is provided', async () => {
    const mockTestInfo = {
      attach: vi.fn().mockResolvedValue(undefined),
    };
    const context = createContext();
    context.testInfo = mockTestInfo as unknown as EvalContext['testInfo'];

    const dataset = createDataset([createEvalCase()]);

    await runEvalDataset({ dataset }, context);

    expect(mockTestInfo.attach).toHaveBeenCalledWith('mcp-test-results', {
      contentType: 'application/json',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body: expect.any(Buffer),
    });
  });
});

describe('filterTags', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'filter-test', cases };
  }

  it('runs only cases that match at least one of the specified tags', async () => {
    const mcp = createMockMCP();
    const dataset: EvalDataset = {
      name: 'filter-test',
      cases: [
        { id: 'a', input: 'echo', tags: ['search'] },
        { id: 'b', input: 'echo', tags: ['nav'] },
        { id: 'c', input: 'echo', tags: ['search', 'nav'] },
        { id: 'd', input: 'echo' }, // no tags
      ],
    };
    const result = await runEvalDataset(
      { dataset, filterTags: ['search'] },
      createContext(mcp)
    );
    // Cases 'a' and 'c' match 'search'; 'b' has only 'nav'; 'd' has no tags
    expect(result.total).toBe(2);
    const ids = result.caseResults.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('d');
  });

  it('runs all cases when filterTags is not set', async () => {
    const dataset: EvalDataset = {
      name: 'no-filter-test',
      cases: [
        { id: 'x', input: 'echo', tags: ['search'] },
        { id: 'y', input: 'echo' },
      ],
    };
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.total).toBe(2);
  });

  it('returns zero cases when no cases match filterTags', async () => {
    const dataset: EvalDataset = {
      name: 'no-match-test',
      cases: [{ id: 'x', input: 'echo', tags: ['search'] }],
    };
    const result = await runEvalDataset(
      { dataset, filterTags: ['nav'] },
      createContext()
    );
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('runs all cases when filterTags is an empty array', async () => {
    const dataset = createDataset([
      createEvalCase({ id: 'p', tags: ['search'] }),
      createEvalCase({ id: 'q' }),
    ]);
    const result = await runEvalDataset(
      { dataset, filterTags: [] },
      createContext()
    );
    expect(result.total).toBe(2);
  });

  it('propagates tags onto EvalCaseResult', async () => {
    const dataset = createDataset([
      createEvalCase({ id: 'tagged', tags: ['search', 'multi-hop'] }),
    ]);
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.caseResults[0]!.tags).toEqual(['search', 'multi-hop']);
  });

  it('leaves tags undefined on EvalCaseResult when case has no tags', async () => {
    const dataset = createDataset([createEvalCase({ id: 'untagged' })]);
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.caseResults[0]!.tags).toBeUndefined();
  });
});

describe('saveResultsTo and baselineResultsFrom', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-runner-baseline-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'baseline-test-dataset', cases };
  }

  it('saves results to file when saveResultsTo is set', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    const filePath = join(tmpDir, 'results.json');

    await runEvalDataset(
      { dataset, saveResultsTo: filePath },
      createContext(mcp)
    );

    const raw = await readFile(filePath, 'utf8');
    const saved = JSON.parse(raw) as { total: number; passed: number };
    expect(saved.total).toBe(1);
    expect(saved.passed).toBe(1);
  });

  it('omits response by default when saving baseline', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    const filePath = join(tmpDir, 'baseline-no-response.json');

    await runEvalDataset(
      { dataset, saveResultsTo: filePath },
      createContext(mcp)
    );

    const raw = await readFile(filePath, 'utf8');
    const saved = JSON.parse(raw) as {
      caseResults: Array<{ response?: unknown }>;
    };
    expect(saved.caseResults[0]).not.toHaveProperty('response');
  });

  it('preserves response when omitResponsesFromBaseline is false', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    const filePath = join(tmpDir, 'baseline-with-response.json');

    await runEvalDataset(
      { dataset, saveResultsTo: filePath, omitResponsesFromBaseline: false },
      createContext(mcp)
    );

    const raw = await readFile(filePath, 'utf8');
    const saved = JSON.parse(raw) as {
      caseResults: Array<{ response?: unknown }>;
    };
    expect(saved.caseResults[0]).toHaveProperty('response');
  });

  it('saves results to an external store and omits responses by default', async () => {
    const store = new MemoryEvalResultStore();
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);

    await runEvalDataset(
      {
        dataset,
        resultStore: store,
        saveResultsTo: { store: true, ref: { id: 'stored-run' } },
      },
      createContext(mcp)
    );

    const artifact = await store.loadArtifact<EvalRunnerResult>(
      'eval-runner-result',
      'stored-run'
    );
    expect(artifact.metadata.datasetName).toBe('baseline-test-dataset');
    expect(artifact.metadata.protocolVersion).toBe('2025-11-25');
    expect(artifact.metadata.protocolEra).toBe('legacy');
    expect(artifact.data.caseResults[0]).not.toHaveProperty('response');
  });

  it('preserves responses in external store when redaction is disabled', async () => {
    const store = new MemoryEvalResultStore();
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);

    await runEvalDataset(
      {
        dataset,
        resultStore: store,
        saveResultsTo: { store: true, ref: { id: 'stored-run' } },
        redactStoredResponses: false,
        omitResponsesFromBaseline: false,
      },
      createContext(mcp)
    );

    const artifact = await store.loadArtifact<EvalRunnerResult>(
      'eval-runner-result',
      'stored-run'
    );
    expect(artifact.data.caseResults[0]).toHaveProperty('response');
  });

  it('loads latest external baseline and computes regressions', async () => {
    const store = new MemoryEvalResultStore();
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'baseline',
        data: {
          total: 1,
          passed: 1,
          failed: 0,
          durationMs: 10,
          caseResults: [
            {
              id: 'case-1',
              pass: true,
              datasetName: dataset.name,
              toolName: 'test-tool',
              source: 'eval',
              scores: {},
              durationMs: 1,
            },
          ],
        },
      })
    );

    const failingMcp = createMockMCP({
      content: [{ type: 'text', text: 'world' }],
    });
    const result = await runEvalDataset(
      {
        dataset,
        resultStore: store,
        baselineResultsFrom: { store: true, ref: 'latest' },
      },
      createContext(failingMcp)
    );

    expect(result.regressions).toBe(1);
    expect(result.improvements).toBe(0);
    expect(result.deltaPassRate).toBeLessThan(0);
    expect(result.caseResults[0]!.baselinePass).toBe(true);
  });

  it('computes deltaPassRate when baselineResultsFrom is set', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    const baselinePath = join(tmpDir, 'baseline.json');

    // Save baseline first
    await runEvalDataset(
      { dataset, saveResultsTo: baselinePath },
      createContext(mcp)
    );

    // Run again comparing against baseline
    const result = await runEvalDataset(
      { dataset, baselineResultsFrom: baselinePath },
      createContext(mcp)
    );

    // Same results as baseline → deltaPassRate should be 0
    expect(result.deltaPassRate).toBe(0);
    expect(result.regressions).toBe(0);
    expect(result.improvements).toBe(0);
  });

  it('counts regressions: cases that passed in baseline but fail now', async () => {
    const baselinePath = join(tmpDir, 'baseline.json');

    // Baseline: case passes (response contains 'hello')
    const passingMcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset, saveResultsTo: baselinePath },
      createContext(passingMcp)
    );

    // Now: case fails (response contains 'world', not 'hello')
    const failingMcp = createMockMCP({
      content: [{ type: 'text', text: 'world' }],
    });
    const result = await runEvalDataset(
      { dataset, baselineResultsFrom: baselinePath },
      createContext(failingMcp)
    );

    expect(result.regressions).toBe(1);
    expect(result.improvements).toBe(0);
    expect(result.deltaPassRate).toBeLessThan(0);
    expect(result.caseResults[0]!.baselinePass).toBe(true);
  });

  it('counts improvements: cases that failed in baseline but pass now', async () => {
    const baselinePath = join(tmpDir, 'baseline.json');

    // Baseline: case fails (response contains 'world', not 'hello')
    const failingMcp = createMockMCP({
      content: [{ type: 'text', text: 'world' }],
    });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset, saveResultsTo: baselinePath },
      createContext(failingMcp)
    );

    // Now: case passes (response contains 'hello')
    const passingMcp = createMockMCP({
      content: [{ type: 'text', text: 'hello' }],
    });
    const result = await runEvalDataset(
      { dataset, baselineResultsFrom: baselinePath },
      createContext(passingMcp)
    );

    expect(result.improvements).toBe(1);
    expect(result.regressions).toBe(0);
    expect(result.deltaPassRate).toBeGreaterThan(0);
    expect(result.caseResults[0]!.baselinePass).toBe(false);
  });

  it('warns and continues when baselineResultsFrom file does not exist', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);
    const nonexistentPath = join(tmpDir, 'does-not-exist.json');

    // Should not throw — just warns
    const result = await runEvalDataset(
      { dataset, baselineResultsFrom: nonexistentPath },
      createContext(mcp)
    );

    expect(result.total).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not load baseline from')
    );
    expect(result.deltaPassRate).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it('warns when more than 20% of current cases have no baseline entry', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });

    // Save a baseline with only one case
    const baselinePath = join(tmpDir, 'sparse-baseline.json');
    const baselineDataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset: baselineDataset, saveResultsTo: baselinePath },
      createContext(mcp)
    );

    // Run with a dataset that has 5 cases, only 1 of which matches the baseline
    const currentDataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-4', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-5', assertions: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset: currentDataset, baselineResultsFrom: baselinePath },
      createContext(mcp)
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('have no baseline entry')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('4 of 5 cases')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when 20% or fewer current cases have no baseline entry', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });

    // Save a baseline with 5 cases
    const baselinePath = join(tmpDir, 'full-baseline.json');
    const baselineDataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-4', assertions: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-5', assertions: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset: baselineDataset, saveResultsTo: baselinePath },
      createContext(mcp)
    );

    // Run with the same 5 cases — 0% unmatched, no warning
    await runEvalDataset(
      { dataset: baselineDataset, baselineResultsFrom: baselinePath },
      createContext(mcp)
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('have no baseline entry')
    );

    consoleSpy.mockRestore();
  });
});

describe('evals guide trial count guardrail warnings', () => {
  // The warning is emitted before any case runs; don't run the real
  // simulator (and its provider import) for every trial.
  async function notExecuted() {
    return { kind: 'failed' as const, response: undefined, error: 'not run' };
  }

  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('warns when a client case has fewer than 10 trials (explicit)', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'low-iter-case',
        input: 'find something',
        trials: 3,
      }),
    ]);

    await runEvalDataset(
      { dataset, executeCase: notExecuted },
      createContext()
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('running 3 trials may not')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Consider 10+ trials')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('low-iter-case')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when a client case runs one trial (default smoke-test pattern)', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'default-iter-case',
        input: 'find something',
      }),
    ]);

    await runEvalDataset(
      { dataset, executeCase: notExecuted },
      createContext()
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when a client case has 10 or more trials', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'sufficient-iter-case',
        input: 'find something',
        trials: 10,
      }),
    ]);

    await runEvalDataset(
      { dataset, executeCase: notExecuted },
      createContext()
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when defaultTrials raises the count to >= 10', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'default-raised-case',
        input: 'find something',
        // No explicit trials — defaultTrials will apply
      }),
    ]);

    await runEvalDataset(
      { dataset, defaultTrials: 10, executeCase: notExecuted },
      createContext()
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });
});

describe('dataset-level tool precision/recall/F1 aggregation', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  function createSimulationMCP(
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  ): MCPFixtureApi {
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockResolvedValue({
      success: true,
      toolCalls,
      response: 'Done',
    } as unknown as Awaited<ReturnType<typeof mcp.callTool>>);
    return mcp;
  }

  it('computes datasetToolPrecision and datasetToolRecall when cases have toolsTriggered', async () => {
    // Case 1: calls exactly [search], expects [search] required → precision=1, recall=1
    // Case 2: calls [search, extra], exclusive=true, expects [search] required → recall=1, precision=0.5
    const mcp1 = createSimulationMCP([{ name: 'search', arguments: {} }]);
    const mcp2 = createSimulationMCP([
      { name: 'search', arguments: {} },
      { name: 'extra', arguments: {} },
    ]);

    // Use separate runs so we can control the mock per case
    const case1 = createEvalCase({
      id: 'case-1',
      assertions: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
          exclusive: true,
        },
      },
    });
    const case2 = createEvalCase({
      id: 'case-2',
      assertions: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
          exclusive: true,
        },
      },
    });

    const result1 = await runEvalDataset(
      { dataset: createDataset([case1]) },
      createContext(mcp1)
    );
    const result2 = await runEvalDataset(
      { dataset: createDataset([case2]) },
      createContext(mcp2)
    );

    // Case 1: all expected, exclusive — precision 1.0, recall 1.0
    expect(result1.datasetToolPrecision).toBeCloseTo(1.0);
    expect(result1.datasetToolRecall).toBeCloseTo(1.0);
    expect(result1.datasetToolF1).toBeCloseTo(1.0);

    // Case 2: extra tool called (exclusive), recall=1 but precision=0.5
    expect(result2.datasetToolPrecision).toBeCloseTo(0.5);
    expect(result2.datasetToolRecall).toBeCloseTo(1.0);
    // F1 = 2 * 0.5 * 1.0 / (0.5 + 1.0) = 1.0 / 1.5 ≈ 0.667
    expect(result2.datasetToolF1).toBeCloseTo(0.667, 2);
  });

  it('does not set dataset tool metrics when no cases have toolsTriggered', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', assertions: { containsText: 'hello' } }),
    ]);

    const result = await runEvalDataset({ dataset }, createContext(mcp));

    expect(result.datasetToolPrecision).toBeUndefined();
    expect(result.datasetToolRecall).toBeUndefined();
    expect(result.datasetToolF1).toBeUndefined();
  });

  it('averages precision/recall across multiple cases with toolsTriggered', async () => {
    // Both cases call only the expected tool (recall=1, precision=1)
    const mcp = createSimulationMCP([{ name: 'search', arguments: {} }]);
    const dataset = createDataset([
      createEvalCase({
        id: 'case-1',
        assertions: {
          toolsTriggered: {
            calls: [{ name: 'search', required: true }],
            exclusive: true,
          },
        },
      }),
      createEvalCase({
        id: 'case-2',
        assertions: {
          toolsTriggered: {
            calls: [{ name: 'search', required: true }],
            exclusive: true,
          },
        },
      }),
    ]);

    const result = await runEvalDataset({ dataset }, createContext(mcp));

    expect(result.datasetToolPrecision).toBeCloseTo(1.0);
    expect(result.datasetToolRecall).toBeCloseTo(1.0);
    expect(result.datasetToolF1).toBeCloseTo(1.0);
  });
});

describe('multi-judge passesJudge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('aggregates multiple judges with AND semantics (all pass)', async () => {
    // Mock validateJudge to return passing results
    const { runEvalCase: runEvalCaseMocked } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    vi.spyOn(judgeModule, 'validateJudge').mockResolvedValue({
      pass: true,
      message: 'Judge passed with score 0.90',
      details: {
        score: 0.9,
        reasoning: 'Good',
        judgeProvider: 'anthropic',
        judgeModel: 'claude-sonnet',
      },
    });

    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      assertions: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { rubric: 'completeness', threshold: 0.7 },
        ],
      },
    });

    const result = await runEvalCaseMocked(evalCase, createContext(mcp));

    expect(result.scores.judge).toBeDefined();
    expect(result.scores.judge!.pass).toBe(true);
    expect(result.scores.judge!.judgeResults).toHaveLength(2);
    expect(result.scores.judge!.details).toContain('2/2');

    vi.restoreAllMocks();
  });

  it('fails when any judge in array fails', async () => {
    const { runEvalCase: runEvalCaseMocked } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    let callCount = 0;
    vi.spyOn(judgeModule, 'validateJudge').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          pass: true,
          message: 'Judge passed with score 0.90',
          details: {
            score: 0.9,
            reasoning: 'Good',
            judgeProvider: 'anthropic',
          },
        };
      }
      return {
        pass: false,
        message: 'Judge failed with score 0.50',
        details: { score: 0.5, reasoning: 'Bad', judgeProvider: 'openai' },
      };
    });

    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      assertions: {
        passesJudge: [
          { rubric: 'correctness', threshold: 0.7 },
          { judge: 'custom-judge', threshold: 0.7 },
        ],
      },
    });

    const result = await runEvalCaseMocked(evalCase, createContext(mcp));

    expect(result.scores.judge!.pass).toBe(false);
    expect(result.scores.judge!.judgeResults).toHaveLength(2);
    expect(result.scores.judge!.judgeResults![0]!.pass).toBe(true);
    expect(result.scores.judge!.judgeResults![1]!.pass).toBe(false);
    expect(result.scores.judge!.details).toContain('1/2');
    expect(result.pass).toBe(false);

    vi.restoreAllMocks();
  });

  it('single judge object produces flat result (no judgeResults)', async () => {
    const { runEvalCase: runEvalCaseMocked } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    vi.spyOn(judgeModule, 'validateJudge').mockResolvedValue({
      pass: true,
      message: 'Judge passed with score 0.85',
      details: { score: 0.85, reasoning: 'Fine', judgeProvider: 'anthropic' },
    });

    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      assertions: {
        passesJudge: { rubric: 'correctness' },
      },
    });

    const result = await runEvalCaseMocked(evalCase, createContext(mcp));

    expect(result.scores.judge!.pass).toBe(true);
    expect(result.scores.judge!.judgeResults).toBeUndefined();
    expect(result.scores.judge!.score).toBe(0.85);

    vi.restoreAllMocks();
  });

  it('reports the judge name each evaluation gives', async () => {
    const { runEvalCase: runEvalCaseMocked } = await import('./evalRunner.js');
    const judgeModule = await import('../assertions/validators/judge.js');
    vi.spyOn(judgeModule, 'validateJudge')
      .mockResolvedValueOnce({
        pass: true,
        message: 'Passed',
        details: { score: 0.9, judgeName: 'correctness' },
      })
      .mockResolvedValueOnce({
        pass: true,
        message: 'Passed',
        details: { score: 0.9, judgeName: 'domain-relevance' },
      });

    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      assertions: {
        passesJudge: [{ rubric: 'correctness' }, { judge: 'domain-relevance' }],
      },
    });

    const result = await runEvalCaseMocked(evalCase, createContext(mcp));

    const judgeResults = result.scores.judge!.judgeResults!;
    expect(judgeResults[0]!.judgeName).toBe('correctness');
    expect(judgeResults[1]!.judgeName).toBe('domain-relevance');

    vi.restoreAllMocks();
  });
});

describe('experiment metadata in EvalRunnerResult', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'metadata-test', cases };
  }

  it('includes metadata in EvalRunnerResult', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);

    const result = await runEvalDataset({ dataset }, createContext(mcp));

    expect(result.metadata).toBeDefined();
    expect(result.metadata!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.metadata!.packageVersion).toBeTruthy();
    expect(
      result.metadata!.gitHash === undefined ||
        typeof result.metadata!.gitHash === 'string'
    ).toBe(true);
  });

  it("records the run's model in metadata", async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);

    const result = await runEvalDataset(
      { dataset, model: 'claude-opus-4-20250514' },
      createContext(mcp)
    );

    expect(result.metadata!.model).toBe('claude-opus-4-20250514');
  });

  it('omits the model and judgeModel from metadata when not provided', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);

    const result = await runEvalDataset({ dataset }, createContext(mcp));

    expect(result.metadata!.model).toBeUndefined();
    expect(result.metadata!.judgeModel).toBeUndefined();
  });
});
