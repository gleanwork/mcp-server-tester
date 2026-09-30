import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  createLLMJudge,
  parseJudgeResponse,
  type JudgeCompletion,
  type JudgeCompletionAdapter,
  type JudgeCompletionRequest,
} from './llmJudge.js';
import { createJudge } from './judgeClient.js';
import type { ProviderKind } from './judgeTypes.js';

/** A completion adapter that records requests and answers with fixed text. */
function fakeCompletion(
  text: string,
  usage?: JudgeCompletion['usage']
): JudgeCompletionAdapter & { requests: JudgeCompletionRequest[] } {
  const requests: JudgeCompletionRequest[] = [];
  const complete = async (request: JudgeCompletionRequest) => {
    requests.push(request);
    return { text, usage };
  };
  return Object.assign(complete, { requests });
}

const verdict = JSON.stringify({ pass: true, score: 0.8, reasoning: 'ok' });

describe('createLLMJudge', () => {
  it('sends every provider the same system prompt and user prompt', async () => {
    const complete = fakeCompletion(verdict);
    await createLLMJudge(complete).evaluate({ a: 1 }, 'ref', 'Be accurate');
    expect(complete.requests).toEqual([
      {
        system: JUDGE_SYSTEM_PROMPT,
        prompt: buildJudgePrompt({ a: 1 }, 'ref', 'Be accurate'),
      },
    ]);
  });

  it('returns the parsed verdict with the candidate size', async () => {
    const result = await createLLMJudge(fakeCompletion(verdict)).evaluate(
      'candidate',
      null,
      'rubric'
    );
    expect(result).toMatchObject({
      pass: true,
      score: 0.8,
      reasoning: 'ok',
      candidateSizeBytes: 9,
      exceedsMaxToolOutputSize: false,
    });
  });

  it('fails without calling the provider when the candidate is too large', async () => {
    const complete = fakeCompletion(verdict);
    const result = await createLLMJudge(complete, {
      maxToolOutputSize: 4,
    }).evaluate('candidate', null, 'rubric');
    expect(result).toEqual({
      pass: false,
      score: 0,
      reasoning:
        'Tool output size (9 bytes) exceeds maximum allowed size (4 bytes)',
      candidateSizeBytes: 9,
      exceedsMaxToolOutputSize: true,
    });
    expect(complete.requests).toEqual([]);
  });

  it('defaults usage the provider does not report', async () => {
    const result = await createLLMJudge(
      fakeCompletion(verdict, { inputTokens: 12, outputTokens: undefined })
    ).evaluate('candidate', null, 'rubric');
    expect(result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 0,
      totalCostUsd: 0,
    });
    expect(result.usage?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps usage the provider reports, including its own duration', async () => {
    const result = await createLLMJudge(
      fakeCompletion(verdict, {
        inputTokens: 1,
        outputTokens: 2,
        totalCostUsd: 0.01,
        durationMs: 999,
        cacheReadInputTokens: 3,
      })
    ).evaluate('candidate', null, 'rubric');
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalCostUsd: 0.01,
      durationMs: 999,
      cacheReadInputTokens: 3,
    });
  });

  it('propagates provider errors', async () => {
    const judge = createLLMJudge(async () => {
      throw new Error('rate limited');
    });
    await expect(judge.evaluate('c', null, 'r')).rejects.toThrow(
      'rate limited'
    );
  });
});

describe('buildJudgePrompt', () => {
  it('serializes objects and marks a missing reference', () => {
    const prompt = buildJudgePrompt(
      { data: 'value' },
      undefined,
      'Rubric text'
    );
    expect(prompt).toContain('Rubric:\nRubric text');
    expect(prompt).toContain('"data": "value"');
    expect(prompt).toContain(
      '<reference_answer>\nNo reference provided.\n</reference_answer>'
    );
  });

  it('includes a string or object reference', () => {
    expect(buildJudgePrompt('c', 'expected', 'r')).toContain('expected');
    expect(buildJudgePrompt('c', { k: 1 }, 'r')).toContain('"k": 1');
  });
});

describe('parseJudgeResponse', () => {
  it('reads plain and fenced JSON', () => {
    expect(parseJudgeResponse(verdict).score).toBe(0.8);
    expect(parseJudgeResponse('```json\n' + verdict + '\n```').score).toBe(0.8);
    expect(parseJudgeResponse('```\n' + verdict + '\n```').score).toBe(0.8);
  });

  it('reads JSON embedded in prose', () => {
    expect(parseJudgeResponse(`Here you go: ${verdict} Thanks.`).pass).toBe(
      true
    );
  });

  it('rejects text with no JSON', () => {
    expect(() => parseJudgeResponse('looks good to me')).toThrow(
      'Failed to parse judge response as JSON: looks good to me'
    );
  });

  it('rejects embedded text that is not valid JSON', () => {
    expect(() => parseJudgeResponse('{ "pass": yes }')).toThrow(
      'Failed to parse judge response as JSON'
    );
  });

  it('rejects JSON without the verdict fields', () => {
    expect(() => parseJudgeResponse('{"pass": true}')).toThrow(
      'Judge returned invalid response'
    );
  });
});

describe('createJudge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a judge for every provider', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.stubEnv('GOOGLE_API_KEY', 'k');
    const providers: ProviderKind[] = [
      'anthropic',
      'vertex-anthropic',
      'anthropic-agent-sdk',
      'openai',
      'google',
    ];
    for (const provider of providers)
      expect(typeof createJudge({ provider }).evaluate).toBe('function');
  });

  it('names the valid providers for an unknown one', () => {
    expect(() => createJudge({ provider: 'mystery' as ProviderKind })).toThrow(
      "Unsupported LLM provider: mystery. Valid providers: 'anthropic', 'vertex-anthropic', 'anthropic-agent-sdk', 'openai', 'google'"
    );
  });

  it('applies maxToolOutputSize for every provider', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    const result = await createJudge({
      provider: 'openai',
      maxToolOutputSize: 1,
    }).evaluate('too long', null, 'rubric');
    expect(result.exceedsMaxToolOutputSize).toBe(true);
  });
});
