import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  evaluateExpectations,
  mergeSuiteJudges,
  resolveJudges,
  toolEvidenceGap,
  type GradedExecution,
} from './expectations.js';
import type { ClientResponse } from './caseExecution.js';
import type { ExternalHostMetadata } from './externalHost/types.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

afterEach(() => resetPluginsForTests());

const hostResponse: ClientResponse = {
  success: true,
  response: 'It is sunny.',
  toolCalls: [
    { name: 'native_weather', arguments: { city: 'London' } },
    { name: 'search', arguments: {} },
  ],
};

/** The same response with native names mapped to MCP names, as the runner grades it. */
const mapped: ClientResponse = {
  ...hostResponse,
  toolCalls: [
    { name: 'get_weather', arguments: { city: 'London' } },
    { name: 'search', arguments: {} },
  ],
};

function external(
  overrides: Partial<ExternalHostMetadata> = {}
): ExternalHostMetadata {
  return {
    traceSource: 'host-local-transcript',
    traceConfidence: 'high',
    ...overrides,
  } as ExternalHostMetadata;
}

const toolExpect = {
  toolsTriggered: {
    calls: [
      { name: 'get_weather', required: true },
      { name: 'forecast', required: true },
    ],
  },
  toolCallCount: { min: 1 },
};

describe('toolEvidenceGap', () => {
  it('accepts hosts that report no evidence and structured evidence', () => {
    expect(toolEvidenceGap({})).toBeUndefined();
    expect(toolEvidenceGap({ evidence: 'structured' })).toBeUndefined();
  });

  it('explains observed and missing evidence', () => {
    expect(toolEvidenceGap({ evidence: 'observed' })).toBe(
      'Host evidence is observed; structured tool evidence is required.'
    );
    expect(toolEvidenceGap({ evidence: 'none' })).toBe(
      'Host evidence is none; structured tool evidence is required.'
    );
  });
});

describe('evaluateExpectations', () => {
  const graded: GradedExecution = {
    response: mapped,
    hostResponse,
    evidence: 'structured',
  };

  it('grades tool calls, metrics and the trace view on structured evidence', async () => {
    const outcome = await evaluateExpectations(
      { assertions: toolExpect },
      graded
    );
    expect(outcome.expectations.toolsTriggered?.pass).toBe(false);
    expect(outcome.expectations.toolCallCount?.pass).toBe(true);
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.toolRecall).toBe(0.5);
    // Matched on mapped names, shown with the host's own names.
    expect(outcome.mcpHostTrace).toEqual({
      calls: [
        {
          name: 'native_weather',
          arguments: { city: 'London' },
          status: 'expected',
        },
        { name: 'search', arguments: {}, status: 'unexpected' },
      ],
      missed: [{ name: 'forecast' }],
    });
  });

  it('fails every tool expectation with the gap and grades the rest', async () => {
    const outcome = await evaluateExpectations(
      {
        assertions: { ...toolExpect, containsText: 'sunny' },
      },
      { ...graded, evidence: 'observed' }
    );
    const details =
      'Host evidence is observed; structured tool evidence is required.';
    expect(outcome.expectations.toolsTriggered).toEqual({
      pass: false,
      details,
    });
    expect(outcome.expectations.toolCallCount).toEqual({
      pass: false,
      details,
    });
    expect(outcome.expectations.textContains?.pass).toBe(true);
    expect(outcome.toolPrecision).toBeUndefined();
    expect(outcome.toolRecall).toBeUndefined();
    expect(outcome.mcpHostTrace).toBeUndefined();
  });

  it('lists a required call made with the wrong arguments as missed', async () => {
    const outcome = await evaluateExpectations(
      {
        assertions: {
          toolsTriggered: {
            calls: [
              {
                name: 'get_weather',
                arguments: { city: 'Paris' },
                required: true,
              },
            ],
          },
        },
      },
      graded
    );
    expect(outcome.expectations.toolsTriggered?.pass).toBe(false);
    expect(outcome.toolRecall).toBe(0);
    // Precision counts the call by identity; recall misses it on arguments.
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.mcpHostTrace).toEqual({
      calls: [
        {
          name: 'native_weather',
          arguments: { city: 'London' },
          status: 'expected',
        },
        { name: 'search', arguments: {}, status: 'unexpected' },
      ],
      missed: [{ name: 'get_weather' }],
    });
  });

  it('fails a lone toolCallCount expectation on an evidence gap', async () => {
    const outcome = await evaluateExpectations(
      { assertions: { toolCallCount: { max: 5 } } },
      { ...graded, evidence: 'observed' }
    );
    expect(outcome.expectations).toEqual({
      toolCallCount: {
        pass: false,
        details:
          'Host evidence is observed; structured tool evidence is required.',
      },
    });
  });

  it("grades on the client's evidence, not external trace metadata", async () => {
    const outcome = await evaluateExpectations(
      { assertions: toolExpect },
      { ...graded, externalHost: external({ traceConfidence: 'low' }) }
    );
    expect(outcome.expectations.toolCallCount?.pass).toBe(true);
    expect(outcome.toolPrecision).toBe(0.5);
  });

  it('reports an empty judge list as 0/0 judges passed', async () => {
    const outcome = await evaluateExpectations(
      { assertions: { passesJudge: [] } },
      { response: 'x' }
    );
    expect(outcome.expectations.judge).toEqual({
      pass: true,
      details: '0/0 judges passed',
      judgeResults: [],
    });
  });

  it('passes resolved judge settings to the judge', async () => {
    const seen: unknown[] = [];
    const plugin: Plugin = {
      meta: { name: 'test-plugin', namespace: 'test' },
      judges: {
        'expectations-test-judge': {
          schema: z.object({}).passthrough(),
          evaluate: async ({ case: evalCase, trial }) => {
            seen.push({
              candidate: trial.response,
              reference: evalCase.expected.answer,
            });
            return { score: 1 };
          },
        },
      },
    };
    installPlugins([plugin]);
    const outcome = await evaluateExpectations(
      {
        expected: { answer: 'canonical' },
        assertions: { passesJudge: { judge: 'test/expectations-test-judge' } },
      },
      { response: 'answer' }
    );
    expect(outcome.expectations.judge).toMatchObject({
      pass: true,
      judgeName: 'test/expectations-test-judge',
    });
    expect(seen).toEqual([{ candidate: 'answer', reference: 'canonical' }]);
  });
});

describe('resolveJudges', () => {
  it('applies judge reps, then case reps, then 1', () => {
    const judges = resolveJudges({
      judgeReps: 3,
      assertions: {
        passesJudge: [{ judge: 'a', reps: 5 }, { judge: 'b' }],
      },
    });
    expect(judges.map((judge) => judge.reps)).toEqual([5, 3]);
    expect(
      resolveJudges({ assertions: { passesJudge: { judge: 'c' } } })[0]?.reps
    ).toBe(1);
  });

  it('uses expected.answer only when no reference is set', () => {
    const judges = resolveJudges({
      expected: { answer: 'canonical' },
      assertions: {
        passesJudge: [
          { judge: 'a', reference: 'explicit' },
          { judge: 'b', reference: '' },
          { judge: 'c' },
        ],
      },
    });
    expect(judges.map((judge) => judge.reference)).toEqual([
      'explicit',
      '',
      'canonical',
    ]);
  });

  it('returns nothing when no judge is configured', () => {
    expect(resolveJudges({ assertions: {} })).toEqual([]);
  });
});

describe('mergeSuiteJudges', () => {
  it('lets a case override an eval config judge and keeps its other judges', () => {
    const merged = mergeSuiteJudges(
      {
        expected: { answer: 'canonical' },
        assertions: {
          passesJudge: [
            { judge: 'config', reference: 'case', options: { count: 3 } },
            { judge: 'case-only', threshold: 0.5 },
          ],
        },
      },
      [{ type: 'config', reference: 'suite', count: 2 }],
      [{ type: 'config', reference: 'suite', count: 2, raw: true }]
    );
    expect(merged).toEqual([
      { judge: 'case-only', threshold: 0.5 },
      {
        type: 'config',
        judge: 'config',
        count: 2,
        reference: 'case',
        // Only the judge's own options: no routing or assertion keys.
        options: { count: 3, raw: true },
      },
    ]);
  });

  it('keeps two eval config rubric judges distinct and overrides only the one a case names', () => {
    const raw = [
      { type: 'rubric', rubric: 'correctness' },
      { type: 'rubric', rubric: 'conciseness', threshold: 0.6 },
    ];
    const merged = mergeSuiteJudges(
      {
        assertions: {
          passesJudge: [
            { rubric: 'correctness', threshold: 0.9 },
            { judge: 'case-only' },
          ],
        },
      },
      raw,
      raw
    );
    expect(merged).toEqual([
      { judge: 'case-only' },
      {
        type: 'rubric',
        judge: 'rubric',
        rubric: 'correctness',
        threshold: 0.9,
        options: { rubric: 'correctness' },
        reference: undefined,
      },
      {
        type: 'rubric',
        judge: 'rubric',
        rubric: 'conciseness',
        threshold: 0.6,
        options: { rubric: 'conciseness' },
        reference: undefined,
      },
    ]);
  });

  it('falls back from the eval config reference to expected.answer', () => {
    const [withSuiteRef] = mergeSuiteJudges(
      { expected: { answer: 'canonical' }, assertions: {} },
      [{ type: 'j', reference: 'suite' }],
      []
    );
    const [withoutRef] = mergeSuiteJudges(
      { expected: { answer: 'canonical' }, assertions: {} },
      [{ type: 'j' }],
      []
    );
    expect(withSuiteRef?.reference).toBe('suite');
    expect(withoutRef?.reference).toBe('canonical');
  });
});
