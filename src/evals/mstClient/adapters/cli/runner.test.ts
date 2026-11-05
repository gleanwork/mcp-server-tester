import { describe, it, expect } from 'vitest';
import { interpolateArgs, runCLIClient } from './runner.js';
import { validateCliOutput } from './parsers.js';

describe('interpolateArgs', () => {
  it('replaces {{prompt}} in args', () => {
    const result = interpolateArgs(
      ['-p', '{{prompt}}', '--verbose'],
      'Find recent docs'
    );
    expect(result).toEqual(['-p', 'Find recent docs', '--verbose']);
  });

  it('handles multiple occurrences of {{prompt}}', () => {
    const result = interpolateArgs(
      ['--prompt', '{{prompt}}', '--log', 'Running: {{prompt}}'],
      'hello'
    );
    expect(result).toEqual(['--prompt', 'hello', '--log', 'Running: hello']);
  });

  it('returns args unchanged when no placeholder is present', () => {
    const result = interpolateArgs(['--flag', 'value'], 'scenario text');
    expect(result).toEqual(['--flag', 'value']);
  });

  it('handles empty args array', () => {
    const result = interpolateArgs([], 'scenario');
    expect(result).toEqual([]);
  });
});

describe('validateCliOutput', () => {
  it('returns null for a valid wire result', () => {
    expect(
      validateCliOutput({
        success: true,
        toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
      })
    ).toBeNull();
  });

  it('returns null for a valid wire result with empty toolCalls', () => {
    expect(validateCliOutput({ success: false, toolCalls: [] })).toBeNull();
  });

  it.each([
    [{ toolCalls: [] }, '"success" must be a boolean'],
    [{ success: 'yes', toolCalls: [] }, '"success" must be a boolean'],
    [{ success: true }, '"toolCalls" must be an array'],
    [
      { success: true, toolCalls: 'not-an-array' },
      '"toolCalls" must be an array',
    ],
    [
      { success: true, toolCalls: [{ arguments: {} }] },
      'toolCalls[0].name must be a string',
    ],
    [
      { success: true, toolCalls: [{ name: 'tool', arguments: 'not-object' }] },
      'toolCalls[0].arguments must be an object',
    ],
    [
      { success: true, toolCalls: [{ name: 'tool', arguments: null }] },
      'toolCalls[0].arguments must be an object',
    ],
    [null, 'Expected object'],
    ['string', 'Expected object'],
  ])('rejects malformed wire fields %j', (value, error) => {
    expect(validateCliOutput(value)).toContain(error);
  });
});

describe('CLI wire validation before common results', () => {
  it.each(['stream-json', 'json'] as const)(
    'rejects invalid tool arguments from %s',
    async (outputFormat) => {
      const wire =
        outputFormat === 'json'
          ? {
              success: true,
              toolCalls: [{ name: 'search', arguments: 'invalid' }],
              response: 'answer',
            }
          : {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', name: 'search', input: 'invalid' },
                ],
              },
            };
      const result = await runCLIClient(
        {
          command: process.execPath,
          args: ['-e', `console.log(${JSON.stringify(JSON.stringify(wire))})`],
          outputFormat,
        },
        'request'
      );
      expect(result).toMatchObject({
        finalText: '',
        events: [],
        error:
          'CLI client returned invalid result: toolCalls[0].arguments must be an object, got string',
      });
    }
  );

  it('retains output failure classification for malformed Claude tool arguments', async () => {
    const wire = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'search', input: 'invalid' }],
      },
    };
    const result = await runCLIClient(
      {
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(JSON.stringify(wire))})`],
        claudeMcpServers: [],
      },
      'request'
    );
    expect(result.error).toContain('CLI client returned invalid result');
    expect(result.diagnostics?.failureKind).toBe('output');
  });

  it('maps an unsuccessful JSON wire result to a failed common result', async () => {
    const result = await runCLIClient(
      {
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({success:false, toolCalls:[], response:"partial"}))',
        ],
        outputFormat: 'json',
      },
      'request'
    );
    expect(result).toEqual({
      finalText: 'partial',
      events: [],
      error: 'Client execution failed.',
    });
  });
});

describe('interpolateArgs with a system prompt', () => {
  it('fills both placeholders in one pass, inserting values as-is', () => {
    expect(
      interpolateArgs(
        ['-p', '{{prompt}}', '--append-system-prompt', '{{systemPrompt}}'],
        'cost $& now',
        'Never expand {{prompt}}.'
      )
    ).toEqual([
      '-p',
      'cost $& now',
      '--append-system-prompt',
      'Never expand {{prompt}}.',
    ]);
  });
});
