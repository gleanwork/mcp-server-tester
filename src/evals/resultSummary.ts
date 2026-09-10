import type { EvalCaseResult } from '../types/reporter.js';

export interface EvalSummaryResult {
  metrics: Record<string, unknown>;
  results: EvalCaseResult[];
  aggregatedMetrics?: Record<string, unknown>;
}

export type EvalSummaryCaller = (prompt: string) => Promise<string>;

function compactCase(result: EvalCaseResult): Record<string, unknown> {
  const response = result.response;
  const responseValue =
    response && typeof response === 'object' && 'response' in response
      ? (response as { response?: unknown }).response
      : undefined;
  const responseText = typeof responseValue === 'string' ? responseValue : '';
  const judge = result.expectations?.judge;
  return {
    id: result.id,
    dataset: result.datasetName,
    pass: result.pass,
    error: result.error,
    scenario: result.request?.scenario ?? '',
    judges: judge
      ? {
          pass: judge.pass,
          score: judge.score,
          details: judge.details,
          judgeResults: judge.judgeResults,
        }
      : undefined,
    response: responseText.slice(0, 500),
  };
}

/** Build the stable, compact prompt used for post-run eval analysis. */
export function buildEvalSummaryPrompt(result: EvalSummaryResult): string {
  const metrics = result.aggregatedMetrics ?? result.metrics;
  return `You are an eval analysis assistant. Analyze these MCP evaluation results and provide a concise summary.

METRICS:
${JSON.stringify(metrics, null, 2)}

CASES:
${JSON.stringify(result.results.map(compactCase), null, 2)}

Cover:
1. Overall quality assessment in 1-2 sentences.
2. If there are failures, group them by pattern and explain what went wrong.
3. Note passes with low judge scores.
4. Give actionable recommendations when appropriate.

Keep it concise and use plain text without markdown headers.`;
}

/** Generate an optional natural-language analysis through an application-supplied LLM. */
export async function summarizeEvalResults(
  result: EvalSummaryResult,
  callLLM: EvalSummaryCaller
): Promise<string | null> {
  if (result.results.length === 0) return null;
  return callLLM(buildEvalSummaryPrompt(result));
}
