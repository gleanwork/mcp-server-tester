import { describe, expect, it } from 'vitest';
import { formatSubmittedScenario, runExternalHostScenario } from './runtime.js';

describe('external host runtime', () => {
  it('adds an evaluator marker with an instruction not to mention it', () => {
    const submitted = formatSubmittedScenario(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123'
    );

    expect(submitted).toContain('Reply with exactly: acknowledged.');
    expect(submitted).toContain('[eval-run-marker:MCP_SERVER_TESTER_run_123]');
    expect(submitted).toContain('do not mention this marker');
  });

  it('leaves the submitted scenario unchanged when prompt correlation is disabled', () => {
    const submitted = formatSubmittedScenario(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123',
      { strategy: 'none' }
    );

    expect(submitted).toBe('Reply with exactly: acknowledged.');
  });

  it('keeps exact-prompt input byte-for-byte unchanged', () => {
    const scenario = '  snake_case\\value\nUnicode α  ';
    expect(
      formatSubmittedScenario(scenario, 'internal-id', {
        strategy: 'exact_prompt',
      })
    ).toBe(scenario);
  });

  it('supports prompt marker correlation without including it in the prompt', () => {
    const submitted = formatSubmittedScenario(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123',
      { strategy: 'prompt_marker', includeInPrompt: false }
    );

    expect(submitted).toBe('Reply with exactly: acknowledged.');
  });

  it('infers host type for unsupported driver failures', async () => {
    const result = await runExternalHostScenario(
      'hello',
      { driver: 'openai.chatgpt.chat.browser.web' },
      { runId: 'unsupported-browser' }
    );

    expect(result).toMatchObject({
      success: false,
      externalHost: {
        driverSlug: 'openai.chatgpt.chat.browser.web',
        hostType: 'browser',
        failureKind: 'unsupported_host',
        correlation: {
          strategy: 'none',
          includedInPrompt: false,
        },
      },
    });
  });
});
