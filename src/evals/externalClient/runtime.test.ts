import { describe, expect, it } from 'vitest';
import { formatSubmittedInput, runExternalClientCase } from './runtime.js';

describe('external client runtime', () => {
  it('adds an evaluator marker with an instruction not to mention it', () => {
    const submitted = formatSubmittedInput(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123'
    );

    expect(submitted).toContain('Reply with exactly: acknowledged.');
    expect(submitted).toContain('[eval-run-marker:MCP_SERVER_TESTER_run_123]');
    expect(submitted).toContain('do not mention this marker');
  });

  it('leaves the submitted input unchanged when prompt correlation is disabled', () => {
    const submitted = formatSubmittedInput(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123',
      { strategy: 'none' }
    );

    expect(submitted).toBe('Reply with exactly: acknowledged.');
  });

  it('keeps exact-prompt input byte-for-byte unchanged', () => {
    const input = '  snake_case\\value\nUnicode α  ';
    expect(
      formatSubmittedInput(input, 'internal-id', {
        strategy: 'exact_prompt',
      })
    ).toBe(input);
  });

  it('supports prompt marker correlation without including it in the prompt', () => {
    const submitted = formatSubmittedInput(
      'Reply with exactly: acknowledged.',
      'MCP_SERVER_TESTER_run_123',
      { strategy: 'prompt_marker', includeInPrompt: false }
    );

    expect(submitted).toBe('Reply with exactly: acknowledged.');
  });

  it('infers client type for unsupported driver failures', async () => {
    const result = await runExternalClientCase(
      'hello',
      { driver: 'openai.chatgpt.chat.browser.web' },
      { runId: 'unsupported-browser' }
    );

    expect(result).toMatchObject({
      success: false,
      clientMetadata: {
        driverSlug: 'openai.chatgpt.chat.browser.web',
        clientType: 'browser',
        failureKind: 'unsupported_client',
        correlation: {
          strategy: 'none',
          includedInPrompt: false,
        },
      },
    });
  });
});
