import { describe, expect, it } from 'vitest';
import { runExternalHostScenario } from '../runtime.js';

describe('Claude external host integrations', () => {
  it('drives Claude Chat Desktop and captures low-confidence visible response evidence', async () => {
    const result = await runExternalHostScenario(
      'Please reply with exactly: external host integration acknowledged.',
      {
        driver: 'anthropic.claude.chat.desktop-app.macos',
        name: 'Claude Chat Desktop',
        timeoutMs: 30_000,
      },
      { caseId: 'claude-chat-desktop-integration' }
    );

    if (!result.success) {
      throw new Error(
        `${result.externalHost.failureKind ?? 'unknown'}: ${result.error}`
      );
    }

    expect(result.response?.toLowerCase()).toContain(
      'external host integration acknowledged'
    );
    expect(result.externalHost.driverSlug).toBe(
      'anthropic.claude.chat.desktop-app.macos'
    );
    expect(result.externalHost.traceSource).toBe('accessibility');
    expect(result.externalHost.traceConfidence).toBe('low');
    expect(result.externalHost.artifacts.length).toBeGreaterThan(0);
    expect(result.externalHost.session.runMarker).toContain(
      'MCP_SERVER_TESTER_'
    );
  }, 150_000);

  it('drives the active Claude Cowork Desktop surface and captures high-confidence local-agent trace evidence', async () => {
    const result = await runExternalHostScenario(
      'Please reply with exactly: external host integration acknowledged.',
      {
        driver: 'anthropic.claude.cowork.desktop-app.macos',
        name: 'Claude Cowork Desktop',
        timeoutMs: 60_000,
        options: {
          newConversationShortcut: 'none',
        },
      },
      { caseId: 'claude-cowork-desktop-integration' }
    );

    if (!result.success) {
      throw new Error(
        `${result.externalHost.failureKind ?? 'unknown'}: ${result.error}`
      );
    }

    expect(result.response?.toLowerCase()).toContain(
      'external host integration acknowledged'
    );
    expect(result.externalHost.driverSlug).toBe(
      'anthropic.claude.cowork.desktop-app.macos'
    );
    expect(result.externalHost.traceSource).toBe('host-local-transcript');
    expect(result.externalHost.traceConfidence).toBe('high');
    expect(result.externalHost.artifacts.length).toBeGreaterThan(0);
    expect(result.externalHost.session.id).toBeDefined();
    expect(result.externalHost.session.runMarker).toContain(
      'MCP_SERVER_TESTER_'
    );
  }, 150_000);
});
