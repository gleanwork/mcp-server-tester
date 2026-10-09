import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightJudge } from './judgeClient.js';
import { RUBRIC_JUDGE } from './rubricJudge.js';
import { anthropicMessageCompletion } from './anthropicJudge.js';

// Which optional SDKs are installed doesn't decide these tests.
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('openai', () => {
  throw new Error('Cannot find package openai');
});

describe('preflightJudge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes when the credential is set and the SDK loads, without calling a model', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    await expect(preflightJudge({})).resolves.toBeUndefined();
  });

  it('names the credential to set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(preflightJudge({ provider: 'anthropic' })).rejects.toThrow(
      'Anthropic judge requires an API key. Set the ANTHROPIC_API_KEY environment variable'
    );
  });

  it('names the package to install', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    await expect(preflightJudge({ provider: 'openai' })).rejects.toThrow(
      'OpenAI judge requires the `openai` package. Install it with: npm install openai'
    );
  });

  it('rejects an unknown provider', async () => {
    await expect(
      preflightJudge({ provider: 'mystery' as never })
    ).rejects.toThrow('Unsupported LLM provider: mystery');
  });

  it("is the rubric judge's preflight", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    await expect(
      RUBRIC_JUDGE.preflight!({ rubric: 'correctness', provider: 'openai' })
    ).rejects.toThrow('requires the `openai` package');
  });
});

describe('anthropicMessageCompletion', () => {
  it('marks an answer that stopped at max_tokens', () => {
    const content = [{ type: 'text', text: '{"pass"' }];
    expect(
      anthropicMessageCompletion({ content, stop_reason: 'max_tokens' })
        .truncated
    ).toBe(true);
    expect(
      anthropicMessageCompletion({ content, stop_reason: 'end_turn' }).truncated
    ).toBeUndefined();
  });
});
