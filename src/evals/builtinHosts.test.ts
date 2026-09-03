import { describe, expect, it } from 'vitest';
import { getBuiltinHostConfig } from './builtinHosts.js';

describe('getBuiltinHostConfig', () => {
  it('passes the configured model to the Claude CLI', () => {
    const config = getBuiltinHostConfig('claude-cli', {
      model: 'claude-sonnet-4-6',
      mcpUrl: 'https://example.com/mcp',
    });

    expect(config.cli?.args).toContain('--model');
    expect(config.cli?.args).toContain('claude-sonnet-4-6');
  });
});
