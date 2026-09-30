import { describe, expect, it } from 'vitest';
import {
  hostSecretValues,
  redactHostError,
  redactHostSecrets,
} from './hostSecrets.js';

describe('hostSecretValues', () => {
  it('collects credential-like env values and resolved MCP credentials', () => {
    const secrets = hostSecretValues(
      {
        OPENAI_API_KEY: 'env-api-key',
        GLEAN_TOKEN: 'stdio-token',
        HOME: '/Users/someone',
      },
      [
        {
          transport: 'http',
          serverUrl: 'https://example.test/mcp',
          auth: { accessToken: 'http-token' },
          headers: { 'X-Api-Key': 'header-value' },
        },
        {
          transport: 'stdio',
          command: 'server',
          auth: { accessTokenEnv: 'GLEAN_TOKEN' },
        },
      ],
      ['extra-secret']
    );
    expect(new Set(secrets)).toEqual(
      new Set([
        'env-api-key',
        'stdio-token',
        'http-token',
        'header-value',
        'extra-secret',
      ])
    );
  });

  it('ignores empty and trivially short values that would garble messages', () => {
    expect(
      hostSecretValues({ SOME_TOKEN: '', FLAG_KEY: '1' }, [], ['ab'])
    ).toEqual([]);
  });
});

describe('redactHostSecrets', () => {
  it('replaces every occurrence, longest secret first', () => {
    expect(
      redactHostSecrets('a abcdef b abcd c abcdef', ['abcd', 'abcdef'])
    ).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });
});

describe('redactHostError', () => {
  it('redacts Error messages and uses the fallback otherwise', () => {
    expect(
      redactHostError(new Error('bad token-value'), ['token-value'], 'x')
    ).toBe('bad [REDACTED]');
    expect(redactHostError('token-value', ['token-value'], 'fallback')).toBe(
      'fallback'
    );
  });
});
