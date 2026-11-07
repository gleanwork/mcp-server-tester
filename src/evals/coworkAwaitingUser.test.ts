import { describe, expect, it } from 'vitest';
import {
  awaitingUserAnswer,
  pendingUserQuestion,
} from './cowork/transcript.js';

const ask = { name: 'AskUserQuestion', source: 'builtin' };

describe('awaitingUserAnswer', () => {
  it('detects a pending AskUserQuestion as the latest client call', () => {
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

describe('pendingUserQuestion', () => {
  const asking = (questions: unknown) => ({
    isComplete: false,
    toolCalls: [
      {
        ...ask,
        id: 'toolu_1',
        arguments: { questions } as Record<string, unknown>,
      },
    ],
  });
  it("reads each question's option labels, in order, from the tool input", () => {
    expect(
      pendingUserQuestion(
        asking([
          {
            question: 'Format?',
            header: 'Format',
            options: [
              { label: 'Table', description: 'Rows and columns' },
              { label: 'Paragraph', description: 'Prose' },
            ],
            multiSelect: false,
          },
          {
            question: 'Channels?',
            options: [{ label: 'Email' }, { label: 'Slack' }],
            multiSelect: true,
          },
        ])
      )
    ).toEqual({
      id: 'toolu_1',
      questions: [
        { labels: ['Table', 'Paragraph'], multiSelect: false },
        { labels: ['Email', 'Slack'], multiSelect: true },
      ],
    });
  });
  it('has no usable questions when an option list is missing, blank, or repeats a label', () => {
    for (const questions of [
      undefined,
      [],
      [{ question: 'Q' }],
      [{ options: [] }],
      [{ options: [{ label: ' ' }] }],
      [{ options: [{ label: 'A' }, { label: 'A' }] }],
      [{ options: [{ label: 'A' }] }, 'not a question'],
    ])
      expect(pendingUserQuestion(asking(questions))).toEqual({
        id: 'toolu_1',
        questions: [],
      });
  });
  it('is undefined when nothing waits on an answer', () => {
    expect(
      pendingUserQuestion({
        isComplete: false,
        toolCalls: [{ ...ask, output: 'User answered' }],
      })
    ).toBeUndefined();
  });
});
