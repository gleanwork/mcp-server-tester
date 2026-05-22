import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { runServerComparison } from './serverComparison.js';
import type { EvalDataset } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalContext } from './evalRunner.js';
import { FileEvalResultStore } from './resultStore.js';

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
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

// A dataset with 4 cases to exercise all outcome types
const dataset: EvalDataset = {
  name: 'comparison-test',
  cases: [
    { id: 'both-pass', toolName: 'echo', args: { msg: 'hello' } },
    { id: 'a-wins', toolName: 'echo', args: { msg: 'hello' } },
    { id: 'b-wins', toolName: 'echo', args: { msg: 'hello' } },
    { id: 'both-fail', toolName: 'echo', args: { msg: 'hello' } },
  ],
};

describe('runServerComparison', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-server-comparison-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns correct dataset name and totals when both servers are identical', async () => {
    // Both mocks return the same successful response — all cases should TIE
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });

    const result = await runServerComparison(
      { dataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.dataset).toBe('comparison-test');
    expect(result.total).toBe(4);
    // All cases have no expect block → all pass → all TIE
    expect(result.ties).toBe(4);
    expect(result.aWins).toBe(0);
    expect(result.bWins).toBe(0);
    expect(result.bothFail).toBe(0);
  });

  it('persists comparison output when comparisonStore is configured', async () => {
    const store = new FileEvalResultStore({ provider: 'file', dir: tmpDir });
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });

    await runServerComparison(
      {
        dataset,
        comparisonStore: store,
        comparisonId: 'sxs-1',
        comparisonMetadata: { labels: { serverA: 'a', serverB: 'b' } },
      },
      createContext(mockA),
      createContext(mockB)
    );

    const artifact = await store.loadArtifact<
      Awaited<ReturnType<typeof runServerComparison>>
    >('server-comparison', 'sxs-1');
    expect(artifact.metadata.datasetName).toBe('comparison-test');
    expect(artifact.metadata.labels).toEqual({ serverA: 'a', serverB: 'b' });
    expect(artifact.data.total).toBe(4);
  });

  it('returns A_WINS when server A passes a case that server B fails', async () => {
    // Dataset with one case that requires text 'hello'
    const partialDataset: EvalDataset = {
      name: 'partial-test',
      cases: [
        {
          id: 'contested',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'hello' },
        },
      ],
    };

    // A returns 'hello' (passes), B returns 'nope' (fails)
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'nope' }] });

    const result = await runServerComparison(
      { dataset: partialDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(1);
    expect(result.aWins).toBe(1);
    expect(result.bWins).toBe(0);
    expect(result.ties).toBe(0);
    expect(result.bothFail).toBe(0);
    expect(result.cases[0]!.outcome).toBe('A_WINS');
  });

  it('returns B_WINS when server B passes a case that server A fails', async () => {
    const partialDataset: EvalDataset = {
      name: 'partial-test',
      cases: [
        {
          id: 'contested',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'hello' },
        },
      ],
    };

    // A returns 'nope' (fails), B returns 'hello' (passes)
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'nope' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });

    const result = await runServerComparison(
      { dataset: partialDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(1);
    expect(result.bWins).toBe(1);
    expect(result.aWins).toBe(0);
    expect(result.cases[0]!.outcome).toBe('B_WINS');
  });

  it('returns BOTH_FAIL when both servers fail a case', async () => {
    const partialDataset: EvalDataset = {
      name: 'partial-test',
      cases: [
        {
          id: 'both-fail-case',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'hello' },
        },
      ],
    };

    // Both return 'nope' (fail)
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'nope' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'nope' }] });

    const result = await runServerComparison(
      { dataset: partialDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(1);
    expect(result.bothFail).toBe(1);
    expect(result.aWins).toBe(0);
    expect(result.bWins).toBe(0);
    expect(result.ties).toBe(0);
    expect(result.cases[0]!.outcome).toBe('BOTH_FAIL');
  });

  it('excludes BOTH_FAIL cases from win rate calculation so rates sum to 1.0', async () => {
    // All cases will fail on both servers (expect impossible text)
    const bothFailDataset: EvalDataset = {
      name: 'both-fail-rate-test',
      cases: [
        {
          id: 'both-fail-1',
          toolName: 'echo',
          args: { msg: 'hello' },
          expect: { containsText: 'IMPOSSIBLE_TEXT_XYZ' },
        },
        {
          id: 'both-fail-2',
          toolName: 'echo',
          args: { msg: 'world' },
          expect: { containsText: 'IMPOSSIBLE_TEXT_ABC' },
        },
      ],
    };

    // Both mocks return ordinary text that won't match the impossible strings
    const mockA = createMockMCP({
      content: [{ type: 'text', text: 'response' }],
    });
    const mockB = createMockMCP({
      content: [{ type: 'text', text: 'response' }],
    });

    const result = await runServerComparison(
      { dataset: bothFailDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(2);
    expect(result.bothFail).toBe(2);
    expect(result.aWins).toBe(0);
    expect(result.bWins).toBe(0);
    expect(result.ties).toBe(0);
    // decidedCases = 0, so all rates must be 0 (not 1/total)
    expect(result.aWinRate).toBe(0);
    expect(result.bWinRate).toBe(0);
    expect(result.tieRate).toBe(0);
    // Sum is 0 (not 1.0) when all cases are BOTH_FAIL — that's correct per spec
    expect(result.aWinRate + result.bWinRate + result.tieRate).toBe(0);
  });

  it('win rates sum to 1.0 when there is at least one decided case', async () => {
    // 1 A_WINS + 1 B_WINS + 1 BOTH_FAIL → decidedCases=2, rates should sum to 1.0
    const mixedDataset: EvalDataset = {
      name: 'mixed-rate-test',
      cases: [
        {
          id: 'a-wins-case',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'alpha' },
        },
        {
          id: 'b-wins-case',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'beta' },
        },
        {
          id: 'both-fail-case',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'IMPOSSIBLE_TEXT_XYZ' },
        },
      ],
    };

    // mockA always returns 'alpha': passes a-wins-case, fails b-wins-case and both-fail-case
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'alpha' }] });
    // mockB always returns 'beta': fails a-wins-case, passes b-wins-case, fails both-fail-case
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'beta' }] });

    const result = await runServerComparison(
      { dataset: mixedDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(3);
    expect(result.aWins).toBe(1);
    expect(result.bWins).toBe(1);
    expect(result.ties).toBe(0);
    expect(result.bothFail).toBe(1);
    // decidedCases=2, so each rate is 0.5, sum = 1.0
    expect(result.aWinRate).toBeCloseTo(0.5);
    expect(result.bWinRate).toBeCloseTo(0.5);
    expect(result.tieRate).toBe(0);
    expect(result.aWinRate + result.bWinRate + result.tieRate).toBeCloseTo(1.0);
  });

  it('win rates sum to <= 1.0', async () => {
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });

    const result = await runServerComparison(
      { dataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(
      result.aWinRate + result.bWinRate + result.tieRate
    ).toBeLessThanOrEqual(1.0 + Number.EPSILON);
  });

  it('cases array contains one entry per shared case ID', async () => {
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });

    const result = await runServerComparison(
      { dataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.cases).toHaveLength(result.total);
    for (const c of result.cases) {
      expect(['A_WINS', 'B_WINS', 'TIE', 'BOTH_FAIL']).toContain(c.outcome);
      expect(c.serverA).toBeDefined();
      expect(c.serverB).toBeDefined();
    }
  });

  it('result contains serverAResult and serverBResult with caseResults', async () => {
    const mockA = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'ok' }] });

    const result = await runServerComparison(
      { dataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.serverAResult.caseResults).toBeDefined();
    expect(result.serverBResult.caseResults).toBeDefined();
    expect(result.serverAResult.caseResults).toHaveLength(4);
    expect(result.serverBResult.caseResults).toHaveLength(4);
  });

  it('returns total=0 when dataset has no cases', async () => {
    const emptyDataset: EvalDataset = { name: 'empty', cases: [] };
    const mockA = createMockMCP();
    const mockB = createMockMCP();

    const result = await runServerComparison(
      { dataset: emptyDataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(0);
    expect(result.aWinRate).toBe(0);
    expect(result.bWinRate).toBe(0);
    expect(result.tieRate).toBe(0);
    expect(result.cases).toHaveLength(0);
  });

  it('computes correct win rates', async () => {
    // 2 cases: A wins one, B wins one → aWinRate=0.5, bWinRate=0.5
    const twoCase: EvalDataset = {
      name: 'two-case',
      cases: [
        {
          id: 'case-1',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'alpha' },
        },
        {
          id: 'case-2',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'beta' },
        },
      ],
    };

    // mockA always returns 'alpha' → passes case-1, fails case-2
    const mockA = createMockMCP({
      content: [{ type: 'text', text: 'alpha' }],
    });
    // mockB always returns 'beta' → fails case-1, passes case-2
    const mockB = createMockMCP({
      content: [{ type: 'text', text: 'beta' }],
    });

    const result = await runServerComparison(
      { dataset: twoCase },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.total).toBe(2);
    expect(result.aWins).toBe(1);
    expect(result.bWins).toBe(1);
    expect(result.ties).toBe(0);
    expect(result.bothFail).toBe(0);
    expect(result.aWinRate).toBeCloseTo(0.5);
    expect(result.bWinRate).toBeCloseTo(0.5);
    expect(result.tieRate).toBe(0);
  });

  it('includes durationMs in result', async () => {
    const mockA = createMockMCP();
    const mockB = createMockMCP();

    const result = await runServerComparison(
      { dataset },
      createContext(mockA),
      createContext(mockB)
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('case entries reference correct serverA and serverB results', async () => {
    const singleCase: EvalDataset = {
      name: 'single',
      cases: [
        {
          id: 'only-case',
          toolName: 'echo',
          args: {},
          expect: { containsText: 'hello' },
        },
      ],
    };

    const mockA = createMockMCP({ content: [{ type: 'text', text: 'hello' }] });
    const mockB = createMockMCP({ content: [{ type: 'text', text: 'nope' }] });

    const result = await runServerComparison(
      { dataset: singleCase },
      createContext(mockA),
      createContext(mockB)
    );

    const caseResult = result.cases[0]!;
    expect(caseResult.id).toBe('only-case');
    expect(caseResult.serverA.pass).toBe(true);
    expect(caseResult.serverB.pass).toBe(false);
  });
});
