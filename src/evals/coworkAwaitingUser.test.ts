import { describe, expect, it } from 'vitest';
import { awaitingUserAnswer } from './externalHost/builtins/claudeTrace.js';

const ask = { name: 'AskUserQuestion', source: 'host' };

describe('awaitingUserAnswer', () => {
  it('detects a pending AskUserQuestion as the latest host call', () => {
    expect(
      awaitingUserAnswer({
        isComplete: false,
        toolCalls: [{ name: 'search', source: 'mcp', output: 'x' }, ask],
      })
    ).toBe(true);
  });
  it('ignores answered, completed, or earlier questions', () => {
    expect(
      awaitingUserAnswer({
        isComplete: false,
        toolCalls: [{ ...ask, output: 'answer' }],
      })
    ).toBe(false);
    expect(awaitingUserAnswer({ isComplete: true, toolCalls: [ask] })).toBe(
      false
    );
    expect(
      awaitingUserAnswer({
        isComplete: false,
        toolCalls: [ask, { name: 'search', source: 'mcp' }],
      })
    ).toBe(false);
    expect(awaitingUserAnswer({ isComplete: false, toolCalls: [] })).toBe(
      false
    );
  });
});
