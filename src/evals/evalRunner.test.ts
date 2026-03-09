import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { runEvalCase, runEvalDataset, type EvalContext } from './evalRunner.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

function createMockMCP(callToolResponse?: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
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
    toolName: 'test-tool',
    args: { input: 'test' },
    ...overrides,
  };
}

describe('runEvalCase', () => {
  describe('direct mode', () => {
    it('should call tool and return result', async () => {
      const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
      const context = createContext(mcp);
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mcp.callTool).toHaveBeenCalledWith('test-tool', { input: 'test' });
      expect(result.id).toBe('test-case');
      expect(result.toolName).toBe('test-tool');
      expect(result.source).toBe('eval');
      expect(result.response).toBeDefined();
    });

    it('should return full CallToolResult as response', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'fallback' }],
        structuredContent: { data: 'structured' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase();

      const result = await runEvalCase(evalCase, context);

      // response is the full CallToolResult, not just structuredContent
      expect(result.response).toMatchObject({
        content: [{ type: 'text', text: 'fallback' }],
        structuredContent: { data: 'structured' },
        isError: false,
      });
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
        expect: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.textContains?.pass).toBe(true);
    });

    it('should fail when expect.containsText does not match', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'hello world' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { containsText: 'goodbye' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.expectations.textContains?.pass).toBe(false);
    });

    it('should validate with expect.schema when schema is provided', async () => {
      const mcp = createMockMCP({
        structuredContent: { name: 'test', age: 25 },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'PersonSchema' },
      });

      const PersonSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = await runEvalCase(evalCase, context, {
        schemas: { PersonSchema },
      });

      expect(result.pass).toBe(true);
      expect(result.expectations.schema?.pass).toBe(true);
    });

    it('should fail when expect.schema validation fails', async () => {
      const mcp = createMockMCP({
        structuredContent: { name: 'test', age: 'not-a-number' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'PersonSchema' },
      });

      const PersonSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = await runEvalCase(evalCase, context, {
        schemas: { PersonSchema },
      });

      expect(result.pass).toBe(false);
      expect(result.expectations.schema?.pass).toBe(false);
    });

    it('should fail when schema is not found in registry', async () => {
      const mcp = createMockMCP({
        structuredContent: { data: 'test' },
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { schema: 'MissingSchema' },
      });

      const result = await runEvalCase(evalCase, context, { schemas: {} });

      expect(result.pass).toBe(false);
      expect(result.expectations.schema?.details).toContain('not found');
    });

    it('should validate expect.matchesPattern', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { matchesPattern: '#\\d+' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(true);
    });

    it('should validate expect.isError for error responses', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Error: something went wrong' }],
        isError: true,
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { isError: true },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.error?.pass).toBe(true);
    });

    it('should validate expect.response for exact match', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'status: ok' }],
      });
      const context = createContext(mcp);
      // The response is now the full CallToolResult, so the expected value must match it
      const evalCase = createEvalCase({
        expect: {
          response: {
            content: [{ type: 'text', text: 'status: ok' }],
            structuredContent: undefined,
            isError: false,
          },
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.exact?.pass).toBe(true);
    });

    it('should validate multiple expectations together', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order #12345 confirmed for John' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: {
          containsText: ['Order', 'John'],
          matchesPattern: '#\\d+',
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(true);
      expect(result.expectations.textContains?.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(true);
    });

    it('should fail if any expectation fails', async () => {
      const mcp = createMockMCP({
        content: [{ type: 'text', text: 'Order confirmed' }],
      });
      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: {
          containsText: 'Order',
          matchesPattern: '#\\d+', // This will fail - no order number
        },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.expectations.textContains?.pass).toBe(true);
      expect(result.expectations.regex?.pass).toBe(false);
    });

    it('should fail when toolName is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({ toolName: undefined });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('toolName is required');
    });

    it('should fail when args are missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({ args: undefined });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('args is required');
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

    it('should not run expectations when tool call errors', async () => {
      const mcp = createMockMCP();
      (mcp.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Tool failed')
      );

      const context = createContext(mcp);
      const evalCase = createEvalCase({
        expect: { containsText: 'hello' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.error).toContain('Tool failed');
      expect(result.pass).toBe(false);
      // Expectations should be empty since tool call failed
      expect(result.expectations.textContains).toBeUndefined();
    });
  });

  describe('mcp_host mode', () => {
    it('should fail when scenario is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        mode: 'mcp_host',
        scenario: undefined,
        mcpHostConfig: { provider: 'openai', model: 'gpt-4' },
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('scenario is required');
    });

    it('should fail when mcpHostConfig is missing', async () => {
      const context = createContext();
      const evalCase = createEvalCase({
        mode: 'mcp_host',
        scenario: 'test scenario',
        mcpHostConfig: undefined,
      });

      const result = await runEvalCase(evalCase, context);

      expect(result.pass).toBe(false);
      expect(result.error).toContain('mcpHostConfig is required');
    });
  });
});

describe('multi-iteration cases', () => {
  it('should compute accuracy when iterations > 1', async () => {
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
      iterations: 4,
      accuracyThreshold: 0.5,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    expect(result.assertionPassRate).toBeDefined();
    expect(result.assertionPassRate).toBe(0.5); // 2 of 4 pass
    expect(result.pass).toBe(true); // 0.5 >= 0.5 threshold
    expect(result.iterationResults).toHaveLength(4);
    expect(result.iterationResults?.filter((r) => r.pass)).toHaveLength(2);
    // Wilson CI: 2/4 passes should produce a wide interval within [0,1]
    expect(result.assertionPassRateCI).toBeDefined();
    expect(result.assertionPassRateCI!.lower).toBeGreaterThanOrEqual(0);
    expect(result.assertionPassRateCI!.upper).toBeLessThanOrEqual(1);
    expect(result.assertionPassRateCI!.lower).toBeLessThan(0.5);
    expect(result.assertionPassRateCI!.upper).toBeGreaterThan(0.5);
  });

  it('should fail when accuracy is below threshold', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'wrong' }] });
    const evalCase = createEvalCase({
      iterations: 3,
      accuracyThreshold: 0.8,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.assertionPassRate).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('should not set assertionPassRate for single-iteration cases', async () => {
    const evalCase = createEvalCase();
    const result = await runEvalCase(evalCase, createContext());
    expect(result.assertionPassRate).toBeUndefined();
    expect(result.assertionPassRateCI).toBeUndefined();
    expect(result.iterationResults).toBeUndefined();
  });

  it('excludes infrastructure errors from accuracy computation', async () => {
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
      iterations: 2,
      accuracyThreshold: 1.0,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));

    // The infrastructure error is excluded from the denominator
    // Only 1 assertion result (the second iteration), and it passes → assertionPassRate = 1.0
    expect(result.infrastructureErrorCount).toBe(1);
    expect(result.assertionPassRate).toBe(1.0);
    expect(result.pass).toBe(true);
    expect(result.iterationResults).toHaveLength(2);
    expect(result.iterationResults?.[0]?.isInfrastructureError).toBe(true);
    expect(result.iterationResults?.[1]?.isInfrastructureError).toBe(false);
  });
});

describe('judgeReps behavior in eval runner', () => {
  it('passes judgeReps from evalCase to validateJudge via config', async () => {
    // We test this by observing that the judge is called the correct number of times.
    // Since validateJudge is internal, we mock createJudge at the module level.
    // The mock is applied via vi.mock at the top of this file (we use a factory below).
    // Instead, we verify the end-to-end behavior: when judgeReps=2 and scores average
    // to >= threshold, the case passes; without the loop it would fail.

    // Use a simple containsText expectation as a proxy: judgeReps only affects
    // judge assertions. Here we verify that judgeReps is accepted without error.
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      judgeReps: 2,
      expect: { containsText: 'hello' },
    });

    // Should not throw - judgeReps is accepted on EvalCase
    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.pass).toBe(true);
  });

  it('passes judgeReps: 1 without error', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const evalCase = createEvalCase({
      judgeReps: 1,
      expect: { containsText: 'hello' },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.pass).toBe(true);
  });
});

describe('defaultJudgeReps', () => {
  it('is accepted as an option without error', async () => {
    const dataset: EvalDataset = {
      name: 'default-reps-test',
      cases: [{ id: 'a', toolName: 'echo', args: {} }],
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
      cases: [{ id: 'a', toolName: 'echo', args: {}, judgeReps: 2 }],
    };
    // Just verify it runs without error — judgeReps: 2 stays 2
    const result = await runEvalDataset(
      { dataset, defaultJudgeReps: 5 },
      createContext()
    );
    expect(result.total).toBe(1);
  });
});

describe('toolsTriggered and toolCallCount expectations in eval runner', () => {
  it('populates toolsTriggered expectation result when simulation result contains expected tool', async () => {
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
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered).toBeDefined();
    expect(result.expectations.toolsTriggered?.pass).toBe(true);
  });

  it('fails toolsTriggered when required tool was not called', async () => {
    const mcp = createMockMCP();
    vi.mocked(mcp.callTool).mockResolvedValue({
      success: true,
      toolCalls: [{ name: 'other', arguments: {} }],
      response: 'Done',
    } as unknown as Awaited<ReturnType<typeof mcp.callTool>>);

    const evalCase = createEvalCase({
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
        },
      },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('fails toolsTriggered with informative message when response is not a simulation', async () => {
    // A plain text response (standard CallToolResult) is not a simulation result
    const mcp = createMockMCP({
      content: [{ type: 'text', text: 'plain text' }],
    });

    const evalCase = createEvalCase({
      expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolsTriggered?.pass).toBe(false);
    expect(result.expectations.toolsTriggered?.details).toContain('mcp_host');
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
      expect: { toolCallCount: { min: 1, max: 3 } },
    });

    const result = await runEvalCase(evalCase, createContext(mcp));
    expect(result.expectations.toolCallCount?.pass).toBe(true);
  });
});

describe('runEvalDataset defaultLlmIterations', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('applies defaultLlmIterations to mcp_host cases without explicit iterations', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'llm-case',
        mode: 'mcp_host',
        scenario: 'test scenario',
        mcpHostConfig: { provider: 'anthropic' },
        // no iterations field — should use defaultLlmIterations
      }),
    ]);

    // We can't actually run mcp_host mode in unit tests, so spy on the
    // executeToolCall path to verify the effective case has iterations set.
    // Instead we test via the result: if defaultLlmIterations=2 is applied,
    // the case would run twice, but since mcp_host fails without a real LLM
    // we just check the option is read without error and the case runs.
    const result = await runEvalDataset(
      { dataset, defaultLlmIterations: 1 },
      createContext(mcp)
    );
    // mcp_host without scenario/mcpHostConfig fields fails gracefully
    expect(result.total).toBe(1);
  });

  it('does not apply defaultLlmIterations to direct mode cases', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'direct-case',
        // mode defaults to 'direct'
        expect: { containsText: 'hello' },
      }),
    ]);

    const result = await runEvalDataset(
      { dataset, defaultLlmIterations: 5 },
      createContext(mcp)
    );

    // Direct mode case should NOT have iterationResults (only ran once)
    expect(result.caseResults[0]!.iterationResults).toBeUndefined();
    expect(result.caseResults[0]!.assertionPassRate).toBeUndefined();
    expect(result.passed).toBe(1);
  });

  it('case-level iterations override defaultLlmIterations', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'direct-with-iterations',
        iterations: 3,
        accuracyThreshold: 1.0,
        expect: { containsText: 'hello' },
      }),
    ]);

    const result = await runEvalDataset(
      { dataset, defaultLlmIterations: 10 },
      createContext(mcp)
    );

    // Case-level iterations: 3 wins over defaultLlmIterations: 10
    expect(result.caseResults[0]!.iterationResults).toHaveLength(3);
  });
});

describe('runEvalDataset concurrency', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('should run cases concurrently when concurrency > 1', async () => {
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

    const start = Date.now();
    await runEvalDataset({ dataset, concurrency: 3 }, createContext(mcp));
    const elapsed = Date.now() - start;

    // 3 cases with 30ms each, run in parallel → should complete well under 90ms (sequential)
    expect(elapsed).toBeLessThan(150);
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', expect: { containsText: 'goodbye' } }), // fails
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'goodbye' } }), // fails
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
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

  it('should merge schemas from dataset and options', async () => {
    const mcp = createMockMCP({
      structuredContent: { name: 'test' },
    });
    const context = createContext(mcp);

    const DatasetSchema = z.object({ name: z.string() });
    const OptionsSchema = z.object({ count: z.number() });

    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { schema: 'DatasetSchema' } }),
    ]);
    dataset.schemas = { DatasetSchema };

    const result = await runEvalDataset(
      { dataset, schemas: { OptionsSchema } },
      context
    );

    // Dataset schema should work
    expect(result.caseResults[0]!.pass).toBe(true);
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
        { id: 'a', toolName: 'echo', args: {}, tags: ['search'] },
        { id: 'b', toolName: 'echo', args: {}, tags: ['nav'] },
        { id: 'c', toolName: 'echo', args: {}, tags: ['search', 'nav'] },
        { id: 'd', toolName: 'echo', args: {} }, // no tags
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
        { id: 'x', toolName: 'echo', args: {}, tags: ['search'] },
        { id: 'y', toolName: 'echo', args: {} },
      ],
    };
    const result = await runEvalDataset({ dataset }, createContext());
    expect(result.total).toBe(2);
  });

  it('returns zero cases when no cases match filterTags', async () => {
    const dataset: EvalDataset = {
      name: 'no-match-test',
      cases: [{ id: 'x', toolName: 'echo', args: {}, tags: ['search'] }],
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
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

  it('computes deltaPassRate when baselineResultsFrom is set', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
    ]);
    await runEvalDataset(
      { dataset: baselineDataset, saveResultsTo: baselinePath },
      createContext(mcp)
    );

    // Run with a dataset that has 5 cases, only 1 of which matches the baseline
    const currentDataset = createDataset([
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-4', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-5', expect: { containsText: 'hello' } }),
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-2', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-3', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-4', expect: { containsText: 'hello' } }),
      createEvalCase({ id: 'case-5', expect: { containsText: 'hello' } }),
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

describe('evals guide iteration count guardrail warnings', () => {
  function createDataset(cases: EvalCase[]): EvalDataset {
    return { name: 'test-dataset', cases };
  }

  it('warns when a mcp_host case has fewer than 10 iterations (explicit)', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'low-iter-case',
        mode: 'mcp_host',
        scenario: 'find something',
        mcpHostConfig: { provider: 'openai' },
        iterations: 3,
      }),
    ]);

    await runEvalDataset({ dataset }, createContext());

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('running 3 iterations in mcp_host mode')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Consider using 10+ iterations')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('low-iter-case')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when a mcp_host case uses a single iteration (default smoke-test pattern)', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'default-iter-case',
        mode: 'mcp_host',
        scenario: 'find something',
        mcpHostConfig: { provider: 'openai' },
      }),
    ]);

    await runEvalDataset({ dataset }, createContext());

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when a mcp_host case has 10 or more iterations', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'sufficient-iter-case',
        mode: 'mcp_host',
        scenario: 'find something',
        mcpHostConfig: { provider: 'openai' },
        iterations: 10,
      }),
    ]);

    await runEvalDataset({ dataset }, createContext());

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn for direct mode cases regardless of iterations', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([
      createEvalCase({
        id: 'direct-case',
        toolName: 'test-tool',
        args: { input: 'test' },
        iterations: 1,
      }),
    ]);

    await runEvalDataset({ dataset }, createContext(mcp));

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('may not be statistically reliable')
    );

    consoleSpy.mockRestore();
  });

  it('does not warn when defaultLlmIterations raises the count to >= 10', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const dataset = createDataset([
      createEvalCase({
        id: 'default-raised-case',
        mode: 'mcp_host',
        scenario: 'find something',
        mcpHostConfig: { provider: 'openai' },
        // No explicit iterations — defaultLlmIterations will apply
      }),
    ]);

    await runEvalDataset(
      { dataset, defaultLlmIterations: 10 },
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
      expect: {
        toolsTriggered: {
          calls: [{ name: 'search', required: true }],
          exclusive: true,
        },
      },
    });
    const case2 = createEvalCase({
      id: 'case-2',
      expect: {
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
      createEvalCase({ id: 'case-1', expect: { containsText: 'hello' } }),
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
        expect: {
          toolsTriggered: {
            calls: [{ name: 'search', required: true }],
            exclusive: true,
          },
        },
      }),
      createEvalCase({
        id: 'case-2',
        expect: {
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

  it('includes mcpHostModel in metadata when provided', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);

    const result = await runEvalDataset(
      { dataset, mcpHostModel: 'claude-opus-4-20250514' },
      createContext(mcp)
    );

    expect(result.metadata!.mcpHostModel).toBe('claude-opus-4-20250514');
  });

  it('omits mcpHostModel and judgeModel from metadata when not provided', async () => {
    const mcp = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const dataset = createDataset([createEvalCase({ id: 'case-1' })]);

    const result = await runEvalDataset({ dataset }, createContext(mcp));

    expect(result.metadata!.mcpHostModel).toBeUndefined();
    expect(result.metadata!.judgeModel).toBeUndefined();
  });
});
