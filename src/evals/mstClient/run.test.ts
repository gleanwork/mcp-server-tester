import { describe, it, expect, vi } from 'vitest';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';

vi.mock('./adapters/vercel.js', () => ({
  runVercelClient: vi.fn().mockResolvedValue({
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        arguments: { query: 'test' },
      },
    ],
    finalText: 'Found results',
    llmDurationMs: 100,
    telemetry: { mcpDurationMs: 20 },
  }),
}));
vi.mock('./adapters/cli/index.js', () => ({
  runCLIClient: vi
    .fn()
    .mockResolvedValue({ finalText: 'CLI answer', events: [] }),
}));

import {
  runApiClient,
  runClaudeCodeClient,
  isProviderAvailable,
  getMissingDependencyMessage,
} from './run.js';
import { runVercelClient } from './adapters/vercel.js';
import { runCLIClient } from './adapters/cli/index.js';
import { createFixtureExtensions } from '../../mcp/fixtures/fixtureExtensions.js';

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tool result' }],
    }),
  };
}

describe('runApiClient', () => {
  it.each(['anthropic', 'openai', 'google'] as const)(
    'runs %s through Vercel and returns its common result unchanged',
    async (provider) => {
      const mcp = createMockMCP();
      const config = { provider };
      const signal = new AbortController().signal;
      const result = await runApiClient(
        mcp,
        'Find recent docs',
        config,
        signal
      );
      expect(runVercelClient).toHaveBeenLastCalledWith(
        mcp,
        'Find recent docs',
        config,
        signal
      );
      expect(result.error).toBeUndefined();
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.name).toBe('search');
      expect(result.finalText).toBe('Found results');
      expect(result).toBe(
        await vi.mocked(runVercelClient).mock.results.at(-1)!.value
      );
    }
  );

  it('throws for unsupported provider', async () => {
    await expect(
      runApiClient(createMockMCP(), 'scenario', {
        // @ts-expect-error - testing invalid provider
        provider: 'unknown-provider',
      })
    ).rejects.toThrow('Unsupported provider');
  });

  it('throws when provider is missing', async () => {
    await expect(runApiClient(createMockMCP(), 'scenario', {})).rejects.toThrow(
      'provider is required for the api client'
    );
  });
});

describe('runClaudeCodeClient', () => {
  it('preserves timeout precedence, local environment, system prompt and abort signal', async () => {
    const signal = new AbortController().signal;
    const result = await runClaudeCodeClient(
      'request',
      {
        clientType: 'cli',
        timeout: 200,
        env: { FIRST: 'one', OVERRIDE: 'outer' },
        systemPrompt: 'Instructions.',
        cli: {
          command: 'claude',
          args: ['{{prompt}}', '{{systemPrompt}}'],
          timeout: 100,
          env: { OVERRIDE: 'inner' },
        },
      },
      signal
    );
    expect(runCLIClient).toHaveBeenLastCalledWith(
      {
        command: 'claude',
        args: ['{{prompt}}', '{{systemPrompt}}'],
        timeout: 200,
        env: { FIRST: 'one', OVERRIDE: 'inner' },
      },
      'request',
      signal,
      'Instructions.'
    );
    expect(result).toEqual({ finalText: 'CLI answer', events: [] });
  });

  it('requires CLI configuration', async () => {
    await expect(runClaudeCodeClient('x', {})).rejects.toThrow(
      'cli is required'
    );
  });

  it('rejects SDK-managed skills', async () => {
    await expect(
      runClaudeCodeClient('x', {
        skills: 'catalog',
        cli: { command: 'claude', args: [] },
      })
    ).rejects.toThrow('only supported for the api client');
  });

  it.each(['temperature', 'maxTokens', 'maxToolCalls'] as const)(
    'rejects the unsupported %s option',
    async (key) => {
      await expect(
        runClaudeCodeClient('x', {
          [key]: 1,
          cli: { command: 'claude', args: [] },
        })
      ).rejects.toThrow('CLI clients do not support');
    }
  );

  it('rejects a system prompt with no argument placeholder, and a placeholder with no prompt', async () => {
    await expect(
      runClaudeCodeClient('x', {
        clientType: 'cli',
        systemPrompt: 'Use find_skills first.',
        cli: { command: 'my-agent', args: ['{{scenario}}'] },
      })
    ).rejects.toThrow(
      /systemPrompt reaches a CLI client only through a \{\{systemPrompt\}\} placeholder/
    );
    await expect(
      runClaudeCodeClient('x', {
        clientType: 'cli',
        cli: {
          command: 'claude',
          args: ['--append-system-prompt', '{{systemPrompt}}'],
        },
      })
    ).rejects.toThrow(/placeholder but no systemPrompt is set/);
  });
});

describe('isProviderAvailable', () => {
  for (const provider of [
    'openai',
    'anthropic',
    'google',
    'azure',
    'mistral',
    'deepseek',
    'openrouter',
    'xai',
    'vertex-anthropic',
  ] as const) {
    it(`returns true for ${provider}`, () => {
      expect(isProviderAvailable(provider)).toBe(true);
    });
  }
  it('returns false for unknown provider', () => {
    // @ts-expect-error - testing invalid provider
    expect(isProviderAvailable('unknown')).toBe(false);
  });
});

describe('getMissingDependencyMessage', () => {
  it('returns install commands for providers', () => {
    for (const provider of [
      'openai',
      'anthropic',
      'google',
      'azure',
      'mistral',
      'deepseek',
      'openrouter',
      'xai',
      'vertex-anthropic',
    ] as const) {
      expect(getMissingDependencyMessage(provider)).toContain('npm install');
    }
    expect(getMissingDependencyMessage('openai')).toContain('@ai-sdk/openai');
    expect(getMissingDependencyMessage('anthropic')).toContain(
      '@ai-sdk/anthropic'
    );
  });
  it('returns a generic message for an unknown provider', () => {
    // @ts-expect-error - testing invalid provider
    expect(getMissingDependencyMessage('unknown')).toContain(
      'Unknown provider'
    );
  });
});
