/**
 * Unit tests for MCPReporter.buildRunData()
 *
 * buildRunData() is a private method that aggregates all EvalCaseResult records
 * into the MCPEvalRunData structure. Tests access the private method via type
 * assertion to avoid the need for a full Playwright test harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MCPReporter from './mcpReporter.js';
import type { EvalCaseResult } from '../types/reporter.js';

// Suppress file-system side effects (mkdir, writeFile, etc.) in onEnd/onBegin
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue('{}'),
  unlink: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
}));

// Suppress open (auto-open browser)
vi.mock('open', () => ({ default: vi.fn() }));

function makeReporter(options: Record<string, unknown> = {}): MCPReporter {
  return new MCPReporter({ quiet: true, autoOpen: false, ...options });
}

function callBuildRunData(reporter: MCPReporter, durationMs: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (reporter as any).buildRunData(durationMs) as {
    timestamp: string;
    durationMs: number;
    environment: { ci: boolean; node: string; platform: string };
    metrics: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
      datasetBreakdown: Record<string, number>;
      expectationBreakdown: Record<string, number>;
    };
    results: EvalCaseResult[];
    conformanceChecks?: unknown[];
    serverCapabilities?: unknown[];
  };
}

function setResults(reporter: MCPReporter, results: EvalCaseResult[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (reporter as any).allResults = results;
}

function makeResult(
  overrides: Partial<EvalCaseResult> & { pass: boolean }
): EvalCaseResult {
  return {
    id: 'case-1',
    datasetName: 'test-dataset',
    toolName: 'search',
    source: 'eval',
    expectations: {},
    durationMs: 100,
    ...overrides,
  };
}

describe('MCPReporter.buildRunData()', () => {
  let reporter: MCPReporter;

  beforeEach(() => {
    reporter = makeReporter();
  });

  describe('pass/fail totals', () => {
    it('computes pass and fail counts correctly', () => {
      setResults(reporter, [
        makeResult({ pass: true }),
        makeResult({ pass: true }),
        makeResult({ pass: false }),
      ]);

      const data = callBuildRunData(reporter, 500);

      expect(data.metrics.total).toBe(3);
      expect(data.metrics.passed).toBe(2);
      expect(data.metrics.failed).toBe(1);
    });

    it('computes pass rate correctly', () => {
      setResults(reporter, [
        makeResult({ pass: true }),
        makeResult({ pass: false }),
        makeResult({ pass: false }),
        makeResult({ pass: false }),
      ]);

      const data = callBuildRunData(reporter, 1000);

      expect(data.metrics.passRate).toBe(0.25);
    });

    it('handles 100% pass rate', () => {
      setResults(reporter, [
        makeResult({ pass: true }),
        makeResult({ pass: true }),
      ]);

      const data = callBuildRunData(reporter, 200);

      expect(data.metrics.passed).toBe(2);
      expect(data.metrics.failed).toBe(0);
      expect(data.metrics.passRate).toBe(1);
    });

    it('handles 0% pass rate', () => {
      setResults(reporter, [
        makeResult({ pass: false }),
        makeResult({ pass: false }),
      ]);

      const data = callBuildRunData(reporter, 200);

      expect(data.metrics.passed).toBe(0);
      expect(data.metrics.failed).toBe(2);
      expect(data.metrics.passRate).toBe(0);
    });
  });

  describe('empty results', () => {
    it('handles empty results array without crashing', () => {
      setResults(reporter, []);

      expect(() => callBuildRunData(reporter, 0)).not.toThrow();
    });

    it('returns zero totals for empty results', () => {
      setResults(reporter, []);

      const data = callBuildRunData(reporter, 0);

      expect(data.metrics.total).toBe(0);
      expect(data.metrics.passed).toBe(0);
      expect(data.metrics.failed).toBe(0);
    });
  });

  describe('expectation counters', () => {
    it('counts exact expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { exact: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.exact).toBe(1);
    });

    it('counts schema expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { schema: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.schema).toBe(1);
    });

    it('counts textContains expectation', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          expectations: { textContains: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.textContains).toBe(1);
    });

    it('counts regex expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { regex: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.regex).toBe(1);
    });

    it('counts snapshot expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { snapshot: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.snapshot).toBe(1);
    });

    it('counts judge expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { judge: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.judge).toBe(1);
    });

    it('counts error expectation', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { error: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.error).toBe(1);
    });

    it('counts size expectation (validates Issue 5 fix)', () => {
      setResults(reporter, [
        makeResult({ pass: true, expectations: { size: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      // This test validates that the size expectation counter increments correctly.
      // If this fails with count=0, the Issue 5 fix is missing from buildRunData.
      expect(data.metrics.expectationBreakdown.size).toBe(1);
    });

    it('counts toolsTriggered expectation', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          expectations: { toolsTriggered: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.toolsTriggered).toBe(1);
    });

    it('counts toolCallCount expectation', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          expectations: { toolCallCount: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.toolCallCount).toBe(1);
    });

    it('counts multiple expectation types from the same result', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          expectations: {
            textContains: { pass: true },
            schema: { pass: false },
            judge: { pass: true },
          },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.expectationBreakdown.textContains).toBe(1);
      expect(data.metrics.expectationBreakdown.schema).toBe(1);
      expect(data.metrics.expectationBreakdown.judge).toBe(1);
      expect(data.metrics.expectationBreakdown.exact).toBe(0);
    });

    it('aggregates expectation counts across multiple results', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          expectations: { textContains: { pass: true } },
        }),
        makeResult({
          pass: true,
          expectations: { textContains: { pass: true } },
        }),
        makeResult({
          pass: false,
          expectations: { textContains: { pass: false } },
        }),
        makeResult({ pass: true, expectations: { judge: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 400);

      expect(data.metrics.expectationBreakdown.textContains).toBe(3);
      expect(data.metrics.expectationBreakdown.judge).toBe(1);
    });

    it('initializes all expectation counters to 0 when no expectations are set', () => {
      setResults(reporter, [makeResult({ pass: true, expectations: {} })]);

      const data = callBuildRunData(reporter, 100);

      const breakdown = data.metrics.expectationBreakdown;
      expect(breakdown.exact).toBe(0);
      expect(breakdown.schema).toBe(0);
      expect(breakdown.textContains).toBe(0);
      expect(breakdown.regex).toBe(0);
      expect(breakdown.snapshot).toBe(0);
      expect(breakdown.judge).toBe(0);
      expect(breakdown.error).toBe(0);
      expect(breakdown.size).toBe(0);
      expect(breakdown.toolsTriggered).toBe(0);
      expect(breakdown.toolCallCount).toBe(0);
    });
  });

  describe('dataset breakdown', () => {
    it('groups results by dataset name', () => {
      setResults(reporter, [
        makeResult({ pass: true, datasetName: 'dataset-a' }),
        makeResult({ pass: true, datasetName: 'dataset-a' }),
        makeResult({ pass: false, datasetName: 'dataset-b' }),
      ]);

      const data = callBuildRunData(reporter, 300);

      expect(data.metrics.datasetBreakdown['dataset-a']).toBe(2);
      expect(data.metrics.datasetBreakdown['dataset-b']).toBe(1);
    });

    it('uses "Unknown Dataset" when datasetName is missing', () => {
      const result = makeResult({ pass: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (result as any).datasetName;
      setResults(reporter, [result]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.datasetBreakdown['Unknown Dataset']).toBe(1);
    });
  });

  describe('sourceCounts (direct vs mcp_host)', () => {
    it('includes all results regardless of source type', () => {
      setResults(reporter, [
        makeResult({ pass: true, source: 'eval' }),
        makeResult({ pass: true, source: 'test' }),
        makeResult({ pass: false, source: 'eval' }),
      ]);

      const data = callBuildRunData(reporter, 300);

      expect(data.results.length).toBe(3);
      expect(data.metrics.total).toBe(3);
    });

    it('preserves source field on each result', () => {
      setResults(reporter, [
        makeResult({ pass: true, source: 'eval' }),
        makeResult({ pass: false, source: 'test' }),
      ]);

      const data = callBuildRunData(reporter, 200);

      expect(data.results[0]?.source).toBe('eval');
      expect(data.results[1]?.source).toBe('test');
    });
  });

  describe('durationMs', () => {
    it('includes the provided durationMs in run data', () => {
      setResults(reporter, [makeResult({ pass: true })]);

      const data = callBuildRunData(reporter, 12345);

      expect(data.durationMs).toBe(12345);
    });
  });

  describe('conformanceChecks and serverCapabilities', () => {
    it('returns undefined conformanceChecks when none are recorded', () => {
      setResults(reporter, [makeResult({ pass: true })]);

      const data = callBuildRunData(reporter, 100);

      expect(data.conformanceChecks).toBeUndefined();
    });

    it('returns undefined serverCapabilities when none are recorded', () => {
      setResults(reporter, [makeResult({ pass: true })]);

      const data = callBuildRunData(reporter, 100);

      expect(data.serverCapabilities).toBeUndefined();
    });
  });
});
