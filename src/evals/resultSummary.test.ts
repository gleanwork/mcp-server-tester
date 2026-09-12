import { describe, expect, it, vi } from 'vitest';
import {
  buildEvalSummaryPrompt,
  summarizeEvalResults,
} from './resultSummary.js';
import type { EvalCaseResult } from '../types/reporter.js';

const caseResult: EvalCaseResult = {
  id: 'case-1',
  datasetName: 'demo',
  toolName: 'search',
  source: 'eval',
  pass: false,
  request: { scenario: 'Find the design doc' },
  response: { response: 'I could not find it' },
  expectations: {
    judge: { pass: false, score: 0.2, details: 'score 0.2: incomplete' },
  },
  authType: 'none',
  durationMs: 10,
};

describe('result summary', () => {
  it('builds a compact analysis prompt with metrics and case context', () => {
    const prompt = buildEvalSummaryPrompt({
      metrics: { total: 1, passed: 0 },
      results: [caseResult],
    });
    expect(prompt).toContain('Find the design doc');
    expect(prompt).toContain('score 0.2');
    expect(prompt).toContain('total');
  });

  it('delegates summary generation to the supplied caller', async () => {
    const callLLM = vi
      .fn()
      .mockResolvedValue('One failure: incomplete answer.');
    const summary = await summarizeEvalResults(
      { metrics: {}, results: [caseResult] },
      callLLM
    );
    expect(summary).toBe('One failure: incomplete answer.');
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it('does not call the LLM for an empty run', async () => {
    const callLLM = vi.fn();
    expect(
      await summarizeEvalResults({ metrics: {}, results: [] }, callLLM)
    ).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
  });
});
