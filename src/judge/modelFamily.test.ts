import { describe, expect, it } from 'vitest';
import { modelFamily, sameModelFamily } from './modelFamily.js';

describe('modelFamily', () => {
  it.each([
    ['claude-haiku-4-5', 'anthropic'],
    ['us.anthropic.claude-sonnet-4-6', 'anthropic'],
    ['gpt-5-mini', 'openai'],
    ['openai/gpt-4.1', 'openai'],
    ['o3', 'openai'],
    ['o4-mini', 'openai'],
    ['gemini-2.5-pro', 'google'],
    ['mistral-large-latest', 'mistral'],
    ['grok-4', 'xai'],
    ['deepseek-chat', 'deepseek'],
    ['meta-llama/llama-3.3-70b', 'meta'],
    ['qwen3-coder', 'qwen'],
  ])('%s is %s', (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it("doesn't guess an unknown model, or match words that only contain a family's letters", () => {
    expect(modelFamily('my-house-model')).toBeUndefined();
    expect(modelFamily('photo-model')).toBeUndefined();
    expect(modelFamily(undefined)).toBeUndefined();
  });

  it('compares families, never matching unknown models', () => {
    expect(sameModelFamily('claude-haiku-4-5', 'claude-sonnet-4-6')).toBe(true);
    expect(sameModelFamily('claude-haiku-4-5', 'gpt-5-mini')).toBe(false);
    expect(sameModelFamily('house-a', 'house-a')).toBe(false);
  });
});
