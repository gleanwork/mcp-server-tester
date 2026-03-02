import { describe, it, expect, vi } from 'vitest';
import { createJudge } from './judgeClient.js';
import type { ProviderKind } from './judgeTypes.js';

describe('createJudge provider routing', () => {
  it('creates a judge without error for provider "anthropic"', () => {
    expect(() => createJudge({ provider: 'anthropic' })).not.toThrow();
  });

  it('creates a judge without error for provider "openai" when API key is set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(() => createJudge({ provider: 'openai' })).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws for "openai" when API key is missing', () => {
    // Delete env var to simulate missing
    delete process.env.OPENAI_API_KEY;
    expect(() => createJudge({ provider: 'openai' })).toThrow('API key');
    vi.unstubAllEnvs();
  });

  it('creates a judge without error for provider "google" when API key is set', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-key');
    expect(() => createJudge({ provider: 'google' })).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws for "google" when API key is missing', () => {
    delete process.env.GOOGLE_API_KEY;
    expect(() => createJudge({ provider: 'google' })).toThrow('API key');
  });

  it('throws for unknown provider', () => {
    expect(() => createJudge({ provider: 'unknown' as ProviderKind })).toThrow(
      'Unsupported'
    );
  });
});
