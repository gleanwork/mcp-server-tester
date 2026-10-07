import { describe, expect, it } from 'vitest';
import { getBuiltinClientConfig } from './builtinClients.js';

describe('getBuiltinClientConfig', () => {
  it('passes the configured model to the Claude CLI', () => {
    const config = getBuiltinClientConfig('claude-code', {
      model: 'claude-sonnet-4-6',
      server: {
        transport: 'http',
        serverUrl: 'https://example.com/mcp',
      },
    });

    expect(config.cli?.args).toContain('--model');
    expect(config.cli?.args).toContain('claude-sonnet-4-6');
  });
});
