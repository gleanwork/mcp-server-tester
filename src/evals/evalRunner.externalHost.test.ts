import { describe, expect, it, vi } from 'vitest';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type {
  ExternalHostRunResult,
  ExternalHostSimulationResult,
} from './externalHost/types.js';

const TEST_CORRELATION = {
  strategy: 'prompt_marker',
  marker: 'MCP_SERVER_TESTER_TEST',
  includedInPrompt: true,
} as const;

vi.mock('./externalHost/runtime.js', () => ({
  runExternalHostScenario: vi.fn(async () => {
    const result: ExternalHostSimulationResult = {
      success: true,
      response: 'external host trace acknowledged.',
      toolCalls: [{ name: 'search', arguments: { query: 'planning' } }],
      scenario: 'unused',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.01,
        durationMs: 1000,
      },
      externalHost: {
        driver: {
          provider: 'anthropic',
          product: 'claude',
          surface: 'cowork',
          runtime: 'desktop-app',
          platform: 'macos',
        },
        driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
        displayName: 'Claude Cowork Desktop',
        hostName: 'Claude Cowork Desktop',
        hostType: 'desktop',
        capabilitiesUsed: [
          'control',
          'input',
          'completion',
          'trace',
          'normalize',
        ],
        traceSource: 'host-local-transcript',
        traceConfidence: 'high',
        traceLimitations: ['fixture limitation'],
        artifacts: [
          {
            kind: 'audit',
            name: 'Claude audit log',
            path: '/tmp/audit.jsonl',
          },
        ],
        session: {
          id: 'local_123',
          runMarker: 'MCP_SERVER_TESTER_TEST',
          requestId: 'req_123',
        },
        correlation: TEST_CORRELATION,
        sources: {
          finalAnswer: 'host-local-transcript',
          toolCalls: 'host-local-transcript',
          usage: 'host-local-transcript',
          cost: 'host-local-transcript',
        },
        evidence: {
          finalAnswer: {
            source: 'host-local-transcript',
            confidence: 'high',
          },
          toolCalls: {
            source: 'host-local-transcript',
            confidence: 'high',
          },
          usage: { source: 'host-local-transcript', confidence: 'high' },
          cost: { source: 'host-local-transcript', confidence: 'high' },
        },
      },
    };
    return result;
  }),
}));

const { runEvalCase } = await import('./evalRunner.js');
const { runExternalHostScenario } = await import('./externalHost/runtime.js');

function makeContext(): { mcp: MCPFixtureApi } {
  return {
    mcp: {
      authType: 'none',
      project: 'external-host-test',
    } as MCPFixtureApi,
  };
}

describe('runEvalCase external_host mode', () => {
  it('runs an external host case through existing expectations and preserves trace metadata', async () => {
    const result = await runEvalCase(
      {
        id: 'external-host-case',
        mode: 'external_host',
        scenario: 'Say hello and search.',
        externalHost: {
          driver: 'anthropic.claude.cowork.desktop-app.macos',
          name: 'Claude Cowork Desktop',
        },
        expect: {
          containsText: 'trace acknowledged',
          toolsTriggered: {
            calls: [{ name: 'search', arguments: { query: 'planning' } }],
          },
        },
      },
      makeContext()
    );

    expect(runExternalHostScenario).toHaveBeenCalledWith(
      'Say hello and search.',
      {
        driver: 'anthropic.claude.cowork.desktop-app.macos',
        name: 'Claude Cowork Desktop',
      },
      { caseId: 'external-host-case' }
    );
    expect(result.pass).toBe(true);
    expect(result.toolName).toBe('external_host');
    expect(result.hostUsage).toMatchObject({ totalCostUsd: 0.01 });
    expect(result.externalHost).toMatchObject({
      hostName: 'Claude Cowork Desktop',
      traceSource: 'host-local-transcript',
      traceConfidence: 'high',
      session: { id: 'local_123', requestId: 'req_123' },
    });
    expect(result.request?.externalHost).toEqual({
      driver: 'anthropic.claude.cowork.desktop-app.macos',
      driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
      name: 'Claude Cowork Desktop',
      hostType: undefined,
      variant: undefined,
      timeoutMs: undefined,
      usesBuiltInDefaults: true,
      correlation: {
        strategy: 'prompt_marker',
        includeInPrompt: true,
      },
      options: undefined,
      capabilities: {
        control: [
          { uses: 'builtin:platform.macos' },
          {
            uses: 'builtin:anthropic.claude.activateCoworkSurface',
            with: { appName: 'Claude' },
          },
          {
            uses: 'builtin:desktop.macos.wakeAccessibility',
            with: { appName: 'Claude' },
          },
        ],
        input: [
          {
            uses: 'builtin:desktop.macos.accessibilitySubmit',
            with: { appName: 'Claude', createNewConversation: false },
          },
        ],
        completion: [
          {
            uses: 'builtin:anthropic.claude.localAgentTrace',
            provides: ['trace'],
          },
        ],
        normalize: [{ uses: 'builtin:anthropic.claude.localAgentNormalize' }],
      },
    });
    expect(result.mcpHostTrace?.calls).toEqual([
      {
        name: 'search',
        arguments: { query: 'planning' },
        status: 'expected',
      },
    ]);
  });

  it('fails tool assertions as trace insufficiency when external host evidence is low confidence', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'external host trace acknowledged.',
      toolCalls: [{ name: 'search', arguments: { query: 'planning' } }],
      externalHost: {
        driver: {
          provider: 'anthropic',
          product: 'claude',
          surface: 'chat',
          runtime: 'desktop-app',
          platform: 'macos',
        },
        driverSlug: 'anthropic.claude.chat.desktop-app.macos',
        displayName: 'Claude Chat Desktop',
        hostName: 'Claude Chat Desktop',
        hostType: 'desktop',
        capabilitiesUsed: [
          'control',
          'input',
          'completion',
          'trace',
          'normalize',
        ],
        traceSource: 'accessibility',
        traceConfidence: 'low',
        artifacts: [],
        session: { runMarker: 'MCP_SERVER_TESTER_TEST' },
        correlation: TEST_CORRELATION,
        sources: {
          finalAnswer: 'accessibility',
          toolCalls: 'none',
          usage: 'none',
          cost: 'none',
        },
        evidence: {
          finalAnswer: { source: 'accessibility', confidence: 'low' },
          toolCalls: { source: 'none', confidence: 'unknown' },
        },
      },
    });

    const result = await runEvalCase(
      {
        id: 'external-host-low-confidence',
        mode: 'external_host',
        scenario: 'Say hello and search.',
        externalHost: {
          driver: 'anthropic.claude.chat.desktop-app.macos',
        },
        expect: {
          containsText: 'trace acknowledged',
          toolsTriggered: {
            calls: [{ name: 'search' }],
          },
        },
      },
      makeContext()
    );

    expect(result.pass).toBe(false);
    expect(result.mcpHostTrace).toBeUndefined();
    expect(result.expectations.toolsTriggered?.details).toContain(
      'cannot support tool-call assertions'
    );
  });

  it('requires high-confidence structured evidence for tool assertions when per-field evidence is absent', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValueOnce({
      success: true,
      response: 'external host trace acknowledged.',
      toolCalls: [{ name: 'search', arguments: { query: 'planning' } }],
      externalHost: {
        driver: {
          provider: 'anthropic',
          product: 'claude',
          surface: 'cowork',
          runtime: 'desktop-app',
          platform: 'macos',
        },
        driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
        displayName: 'Claude Cowork Desktop',
        hostName: 'Claude Cowork Desktop',
        hostType: 'desktop',
        capabilitiesUsed: [
          'control',
          'input',
          'completion',
          'trace',
          'normalize',
        ],
        traceSource: 'host-local-transcript',
        traceConfidence: 'medium',
        artifacts: [],
        session: { runMarker: 'MCP_SERVER_TESTER_TEST' },
        correlation: TEST_CORRELATION,
        sources: {
          finalAnswer: 'host-local-transcript',
          toolCalls: 'host-local-transcript',
        },
      },
    });

    const result = await runEvalCase(
      {
        id: 'external-host-medium-confidence',
        mode: 'external_host',
        scenario: 'Say hello and search.',
        externalHost: {
          driver: 'anthropic.claude.cowork.desktop-app.macos',
        },
        expect: {
          toolsTriggered: {
            calls: [{ name: 'search' }],
          },
        },
      },
      makeContext()
    );

    expect(result.pass).toBe(false);
    expect(result.mcpHostTrace).toBeUndefined();
    expect(result.expectations.toolsTriggered?.details).toContain(
      'cannot support tool-call assertions'
    );
  });

  it('counts external host driver failures as infrastructure failures across iterations', async () => {
    const failure: ExternalHostRunResult = {
      success: false,
      error: 'Failed to submit prompt to Claude: automation permission denied',
      toolCalls: [],
      externalHost: {
        driver: {
          provider: 'anthropic',
          product: 'claude',
          surface: 'cowork',
          runtime: 'desktop-app',
          platform: 'macos',
        },
        driverSlug: 'anthropic.claude.cowork.desktop-app.macos',
        displayName: 'Claude Cowork Desktop',
        hostName: 'Claude Cowork Desktop',
        hostType: 'desktop',
        capabilitiesUsed: [],
        traceSource: 'none',
        traceConfidence: 'unknown',
        artifacts: [],
        session: { runMarker: 'MCP_SERVER_TESTER_TEST' },
        correlation: TEST_CORRELATION,
        failureKind: 'automation_permission_denied',
      },
    };
    const deniedAgain: ExternalHostRunResult = {
      ...failure,
      error: 'Failed to submit prompt to Claude: still denied',
    };
    vi.mocked(runExternalHostScenario)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(deniedAgain);

    const result = await runEvalCase(
      {
        id: 'external-host-driver-failure',
        mode: 'external_host',
        scenario: 'Say hello.',
        externalHost: {
          driver: 'anthropic.claude.cowork.desktop-app.macos',
        },
        iterations: 2,
        expect: {
          containsText: 'hello',
        },
      },
      makeContext()
    );

    expect(result.pass).toBe(false);
    expect(result.infrastructureErrorCount).toBe(2);
    expect(result.infrastructureErrorRate).toBe(1);
    expect(result.iterationResults?.every((r) => r.isInfrastructureError)).toBe(
      true
    );
  });
});
