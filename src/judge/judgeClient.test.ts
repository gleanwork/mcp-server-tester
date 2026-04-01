import { describe, it, expect, vi } from 'vitest';
import { createJudge } from './judgeClient.js';
import type { ProviderKind } from './judgeTypes.js';

describe('createJudge provider routing', () => {
  it('creates a judge without error for provider "anthropic" when API key is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    expect(() => createJudge({ provider: 'anthropic' })).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws for "anthropic" when API key is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createJudge({ provider: 'anthropic' })).toThrow('API key');
    vi.unstubAllEnvs();
  });

  it('creates a judge without error for provider "vertex-anthropic"', () => {
    vi.stubEnv('GOOGLE_VERTEX_PROJECT', 'test-project');
    expect(() => createJudge({ provider: 'vertex-anthropic' })).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('creates a judge without error for provider "anthropic-agent-sdk"', () => {
    expect(() =>
      createJudge({ provider: 'anthropic-agent-sdk' })
    ).not.toThrow();
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

  it('defaults to "anthropic" provider when none specified', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    expect(() => createJudge()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws for unknown provider', () => {
    expect(() => createJudge({ provider: 'unknown' as ProviderKind })).toThrow(
      'Unsupported'
    );
  });
});
