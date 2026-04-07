import { describe, it, expect, vi } from 'vitest';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';

// Mock the Vercel orchestrator — it's the only runtime path now
vi.mock('./adapters/vercel.js', () => ({
  createVercelOrchestrator: vi.fn(() => ({
    simulate: vi.fn().mockResolvedValue({
      success: true,
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
      response: 'Found results',
      llmDurationMs: 100,
      mcpDurationMs: 20,
    }),
  })),
}));

import {
  simulateMCPHost,
  isProviderAvailable,
  getMissingDependencyMessage,
} from './mcpHostSimulation.js';

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    project: 'test-project',
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tool result' }],
    }),
  };
}

describe('simulateMCPHost', () => {
  it('routes all providers through the Vercel orchestrator', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'Find recent docs', {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('works for openai provider', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'scenario', {
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(result.success).toBe(true);
  });

  it('works for google provider', async () => {
    const mcp = createMockMCP();
    const result = await simulateMCPHost(mcp, 'scenario', {
      provider: 'google',
    });
    expect(result.success).toBe(true);
  });

  it('throws for unsupported provider', async () => {
    const mcp = createMockMCP();
    await expect(
      simulateMCPHost(mcp, 'scenario', {
        // @ts-expect-error - testing invalid provider
        provider: 'unknown-provider',
      })
    ).rejects.toThrow('Unsupported provider');
  });

  it('throws when provider is missing for sdk host type', async () => {
    const mcp = createMockMCP();
    await expect(simulateMCPHost(mcp, 'scenario', {})).rejects.toThrow(
      'mcpHostConfig.provider is required'
    );
  });
});

describe('isProviderAvailable', () => {
  const supportedProviders = [
    'openai',
    'anthropic',
    'google',
    'azure',
    'mistral',
    'deepseek',
    'openrouter',
    'xai',
  ] as const;

  for (const provider of supportedProviders) {
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
  it('returns install command for openai', () => {
    const msg = getMissingDependencyMessage('openai');
    expect(msg).toContain('@ai-sdk/openai');
    expect(msg).toContain('npm install');
  });

  it('returns install command for anthropic', () => {
    const msg = getMissingDependencyMessage('anthropic');
    expect(msg).toContain('@ai-sdk/anthropic');
  });

  it('returns install command for all providers', () => {
    const providers = [
      'openai',
      'anthropic',
      'google',
      'azure',
      'mistral',
      'deepseek',
      'openrouter',
      'xai',
    ] as const;

    for (const provider of providers) {
      const msg = getMissingDependencyMessage(provider);
      expect(msg).toContain('npm install');
    }
  });

  it('returns generic message for unknown provider', () => {
    // @ts-expect-error - testing invalid provider
    const msg = getMissingDependencyMessage('unknown');
    expect(msg).toContain('Unknown provider');
  });
});
