import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvalCaseResult } from '../../types/reporter.js';
import type { PairwiseComparisonResult } from '../pairwiseComparison.js';
import type { StoredRun } from '../runFormat.js';
import {
  createTraceExporter,
  trialTraceId,
  type OtlpSpan,
  type OtlpTraceRequest,
} from './otlp.js';
import { storedRunTraces } from './runTraces.js';

const finishedAt = '2026-10-22T13:00:00.000Z';

function caseResult(id: string, pass: boolean): EvalCaseResult {
  return {
    id,
    variant: 'glean',
    datasetName: 'set',
    tags: ['hard'],
    pass,
    durationMs: 9_000,
    request: { input: `Question ${id}?`, model: 'claude-x' },
    scores: {
      correctness: { pass, score: pass ? 1 : 0, reasoning: 'Checked.' },
    },
    trace: {
      finalText: 'An answer.',
      startedAt: '2026-10-22T12:00:00.000Z',
      completedAt: '2026-10-22T12:00:09.000Z',
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          name: 'search',
          server: 'glean',
          id: 'call-1',
          arguments: { query: id },
          output: 'results',
        },
      ],
      modelCalls: [{ id: 'req-1', model: 'claude-x', toolCallIds: ['call-1'] }],
    },
  } as unknown as EvalCaseResult;
}

const pairwise = {
  candidate: 'glean',
  baseline: 'official-mcp',
  cases: [
    {
      id: 'case-a',
      preferences: [
        {
          judge: 'multi-dimension',
          preference: 'candidate',
          strength: 0.8,
          consistent: true,
        },
      ],
    },
  ],
} as unknown as PairwiseComparisonResult;

function storedRun(overrides: Partial<StoredRun['run']> = {}): StoredRun {
  const cases = [caseResult('case-a', true), caseResult('case-b', false)];
  return {
    directory: '/runs/x',
    run: {
      runId: '20261022T120000Z-abc123',
      evalName: 'cortex-hard',
      finishedAt,
      variants: [{ name: 'glean', client: 'cowork' }],
      ...overrides,
    } as StoredRun['run'],
    summary: {
      results: cases,
      variants: [
        {
          name: 'glean',
          servers: [],
          result: { caseResults: cases },
          pairwise,
        },
      ],
    } as unknown as StoredRun['summary'],
  };
}

const spansOf = (requests: OtlpTraceRequest[]): OtlpSpan[] =>
  requests.flatMap((request) =>
    request.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans)
    )
  );
const bySpanId = (a: OtlpSpan, b: OtlpSpan) => a.spanId.localeCompare(b.spanId);

describe('storedRunTraces', () => {
  afterEach(() => vi.useRealTimers());

  it('gives the spans the run sent: each trial, its verdicts and the pairwise verdicts', async () => {
    const stored = storedRun();
    // What the run's exporter sent, with its clock at the run's end.
    vi.useFakeTimers({ now: Date.parse(finishedAt), toFake: ['Date'] });
    const sent: OtlpTraceRequest[] = [];
    const exporter = createTraceExporter(
      { endpoint: 'https://collector.example.com' },
      { eval: 'cortex-hard', runId: stored.run.runId, client: 'cowork' },
      {},
      async (_url, init) => {
        sent.push(JSON.parse(init.body as string) as OtlpTraceRequest);
        return { ok: true, status: 200 };
      }
    );
    for (const result of stored.summary.results) exporter.trial(result, 0);
    for (const result of stored.summary.results) exporter.graded(result);
    exporter.pairwise(pairwise);
    await exporter.flush();
    vi.useRealTimers();

    const requests = storedRunTraces(stored);
    expect(spansOf(requests).sort(bySpanId)).toEqual(
      spansOf(sent).sort(bySpanId)
    );
    // A trial's trace, then its case's verdicts, per case; then pairwise.
    expect(requests).toHaveLength(5);
    expect(requests[0]!.resourceSpans[0]!.resource.attributes).toContainEqual({
      key: 'mst.eval',
      value: { stringValue: 'cortex-hard' },
    });
  });

  it("puts a regrade's verdicts in the traces of the run it graded", () => {
    const requests = storedRunTraces(
      storedRun({
        runId: '20261022T120000Z-abc123.g2',
        gradedFrom: '20261022T120000Z-abc123',
      })
    );
    const spans = spansOf(requests);
    const traceId = trialTraceId({
      runId: '20261022T120000Z-abc123',
      variant: 'glean',
      caseId: 'case-a',
      trial: 0,
    });
    expect(spans.filter((span) => span.traceId === traceId).length).toBe(6);
    const verdict = spans.find((span) => span.name === 'evaluate mst.trial')!;
    expect(verdict.attributes).toContainEqual({
      key: 'mst.grading_run_id',
      value: { stringValue: '20261022T120000Z-abc123.g2' },
    });
  });

  it("sends content only when asked, and only the trials' traces with trialsOnly", () => {
    expect(JSON.stringify(storedRunTraces(storedRun()))).not.toContain(
      'Question case-a?'
    );
    expect(
      JSON.stringify(storedRunTraces(storedRun(), { content: true }))
    ).toContain('Question case-a?');
    const trials = spansOf(storedRunTraces(storedRun(), { trialsOnly: true }));
    expect(trials.some((span) => span.name.startsWith('evaluate'))).toBe(false);
    expect(trials.filter((span) => !span.parentSpanId)).toHaveLength(2);
  });
});
