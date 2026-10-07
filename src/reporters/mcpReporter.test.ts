/**
 * Unit tests for MCPReporter.buildRunData()
 *
 * buildRunData() is a private method that aggregates all EvalCaseResult records
 * into the MCPEvalRunData structure. Tests access the private method via type
 * assertion to avoid the need for a full Playwright test harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MCPReporter from './mcpReporter.js';
import type { EvalCaseResult, MCPEvalRunData } from '../types/reporter.js';
import {
  createStoredEvalArtifact,
  type EvalResultStore,
  type ListStoredArtifactsOptions,
  type StoredArtifactKind,
  type StoredArtifactSummary,
  type StoredEvalArtifact,
} from '../evals/resultStore.js';

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
      graderBreakdown: Record<string, number>;
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
    scores: {},
    durationMs: 100,
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
      // Not NaN, which serialized as null in stored reports.
      expect(data.metrics.passRate).toBe(0);
    });
  });

  describe('external result store', () => {
    it('saves reporter run data to the configured store', async () => {
      const store = new MemoryEvalResultStore();
      reporter = makeReporter({
        resultStore: store,
        runId: 'reporter-run-1',
        runMetadata: { datasetName: 'reporter-suite' },
      });
      setResults(reporter, [makeResult({ pass: true })]);

      await reporter.onEnd({} as never);

      const artifact = await store.loadArtifact<MCPEvalRunData>(
        'reporter-run',
        'reporter-run-1'
      );
      expect(artifact.metadata.datasetName).toBe('reporter-suite');
      expect(artifact.data.metrics.passed).toBe(1);
    });

    it('loads historical summaries from the configured store', async () => {
      const store = new MemoryEvalResultStore();
      await store.saveArtifact(
        createStoredEvalArtifact({
          kind: 'reporter-run',
          id: 'previous-run',
          createdAt: '2026-05-22T12:00:00.000Z',
          data: {
            timestamp: '2026-05-22T12:00:00.000Z',
            durationMs: 10,
            environment: { ci: true, node: 'v22.0.0', platform: 'darwin' },
            metrics: {
              total: 2,
              passed: 1,
              failed: 1,
              passRate: 0.5,
              datasetBreakdown: { dataset: 2 },
              graderBreakdown: {
                exact: 0,
                schema: 0,
                textContains: 0,
                regex: 0,
                snapshot: 0,
                judge: 0,
                error: 0,
                size: 0,
                toolsTriggered: 0,
                toolCallCount: 0,
              },
            },
            results: [],
          } satisfies MCPEvalRunData,
        })
      );
      reporter = makeReporter({ resultStore: store });

      const historical = (await (
        reporter as unknown as {
          loadHistoricalData(): Promise<
            Array<{ total: number; passRate: number }>
          >;
        }
      ).loadHistoricalData()) as Array<{
        total: number;
        passRate: number;
      }>;

      expect(historical).toHaveLength(1);
      expect(historical[0]).toMatchObject({ total: 2, passRate: 0.5 });
    });
  });

  describe('grader counters', () => {
    it('counts exact assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { exact: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.exact).toBe(1);
    });

    it('counts schema assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { schema: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.schema).toBe(1);
    });

    it('counts textContains assertion', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          scores: { textContains: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.textContains).toBe(1);
    });

    it('counts regex assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { regex: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.regex).toBe(1);
    });

    it('counts snapshot assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { snapshot: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.snapshot).toBe(1);
    });

    it('counts judge assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { judge: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.judge).toBe(1);
    });

    it('counts error assertion', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { error: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.error).toBe(1);
    });

    it('counts size assertion (validates Issue 5 fix)', () => {
      setResults(reporter, [
        makeResult({ pass: true, scores: { size: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 100);

      // This test validates that the size assertion counter increments correctly.
      // If this fails with count=0, the Issue 5 fix is missing from buildRunData.
      expect(data.metrics.graderBreakdown.size).toBe(1);
    });

    it('counts toolsTriggered assertion', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          scores: { toolsTriggered: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.toolsTriggered).toBe(1);
    });

    it('counts toolCallCount assertion', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          scores: { toolCallCount: { pass: true } },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.toolCallCount).toBe(1);
    });

    it('counts multiple grader types from the same result', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          scores: {
            textContains: { pass: true },
            schema: { pass: false },
            judge: { pass: true },
          },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.metrics.graderBreakdown.textContains).toBe(1);
      expect(data.metrics.graderBreakdown.schema).toBe(1);
      expect(data.metrics.graderBreakdown.judge).toBe(1);
      expect(data.metrics.graderBreakdown.exact).toBe(0);
    });

    it('aggregates grader counts across multiple results', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          scores: { textContains: { pass: true } },
        }),
        makeResult({
          pass: true,
          scores: { textContains: { pass: true } },
        }),
        makeResult({
          pass: false,
          scores: { textContains: { pass: false } },
        }),
        makeResult({ pass: true, scores: { judge: { pass: true } } }),
      ]);

      const data = callBuildRunData(reporter, 400);

      expect(data.metrics.graderBreakdown.textContains).toBe(3);
      expect(data.metrics.graderBreakdown.judge).toBe(1);
    });

    it('initializes all grader counters to 0 when no assertions are set', () => {
      setResults(reporter, [makeResult({ pass: true, scores: {} })]);

      const data = callBuildRunData(reporter, 100);

      const breakdown = data.metrics.graderBreakdown;
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

  describe('external client metadata', () => {
    it('preserves external client trace metadata in run data', () => {
      setResults(reporter, [
        makeResult({
          pass: true,
          clientMetadata: {
            driver: {
              provider: 'anthropic',
              product: 'claude',
              surface: 'cowork',
              runtime: 'desktop-app',
              platform: 'macos',
            },
            driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
            displayName: 'Claude Cowork Desktop',
            clientName: 'Claude Cowork Desktop',
            clientType: 'desktop',
            capabilitiesUsed: [
              'control',
              'input',
              'completion',
              'trace',
              'normalize',
            ],
            traceSource: 'client-local-transcript',
            traceConfidence: 'high',
            traceLimitations: ['fixture limitation'],
            artifacts: [
              {
                kind: 'audit',
                name: 'Claude audit log',
                path: '/tmp/audit.jsonl',
              },
            ],
            session: {
              id: 'local_123',
              runMarker: 'MCP_SERVER_TESTER_TEST',
              requestId: 'req_123',
            },
            correlation: {
              strategy: 'prompt_marker',
              marker: 'MCP_SERVER_TESTER_TEST',
              includedInPrompt: true,
            },
            evidence: {
              finalAnswer: {
                source: 'client-local-transcript',
                confidence: 'high',
              },
              toolCalls: {
                source: 'client-local-transcript',
                confidence: 'high',
              },
            },
          },
        }),
      ]);

      const data = callBuildRunData(reporter, 100);

      expect(data.results[0]?.clientMetadata).toMatchObject({
        driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
        clientName: 'Claude Cowork Desktop',
        traceSource: 'client-local-transcript',
        traceConfidence: 'high',
        session: { id: 'local_123', requestId: 'req_123' },
      });
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

    it('collects every conformance attachment with its protocol and scope', async () => {
      const attach = (body: unknown) => ({
        name: 'mcp-conformance-checks',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(body)),
      });
      const protocol = {
        requested: '2026-07-28',
        negotiated: '2026-07-28',
        era: 'modern',
      };
      const test = { title: 'conformance' } as Parameters<
        MCPReporter['onTestEnd']
      >[0];
      const result = {
        attachments: [
          attach({
            operation: 'conformanceChecks',
            pass: true,
            checks: [
              {
                name: 'discover_succeeds',
                pass: true,
                message: 'ok',
                severity: 'must',
              },
            ],
            toolCount: 4,
            protocol,
          }),
          attach({
            operation: 'crossEraChecks',
            pass: false,
            checks: [
              { name: 'cross_era_tools_match', pass: false, message: 'x' },
            ],
            toolCount: 4,
            scope: 'Cross-era: legacy ↔ 2026-07-28',
          }),
        ],
      } as unknown as Parameters<MCPReporter['onTestEnd']>[1];

      await reporter.onTestEnd(test, result);
      const data = callBuildRunData(reporter, 100);

      expect(data.conformanceChecks).toEqual([
        expect.objectContaining({ pass: true, protocol }),
        expect.objectContaining({
          pass: false,
          scope: 'Cross-era: legacy ↔ 2026-07-28',
        }),
      ]);
    });
  });
});
