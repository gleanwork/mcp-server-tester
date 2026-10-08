import { judgeNameOf } from '../assertions/validators/judge.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  gradeTrial,
  mergeEvalJudges,
  resolveJudges,
  toolEvidenceGap,
  type GradedExecution,
} from './grading.js';
import type { ClientResponse } from './caseExecution.js';
import type { ClientMetadata } from './externalClient/types.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

afterEach(() => resetPluginsForTests());

const clientResponse: ClientResponse = {
  success: true,
  response: 'It is sunny.',
  toolCalls: [
    { name: 'native_weather', arguments: { city: 'London' } },
    { name: 'search', arguments: {} },
  ],
};

/** The same response with native names mapped to MCP names, as the runner grades it. */
const mapped: ClientResponse = {
  ...clientResponse,
  toolCalls: [
    { name: 'get_weather', arguments: { city: 'London' } },
    { name: 'search', arguments: {} },
  ],
};

function external(overrides: Partial<ClientMetadata> = {}): ClientMetadata {
  return {
    traceSource: 'client-local-transcript',
    traceConfidence: 'high',
    ...overrides,
  } as ClientMetadata;
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
  it('accepts clients that report no evidence and structured evidence', () => {
    expect(toolEvidenceGap({})).toBeUndefined();
    expect(toolEvidenceGap({ evidence: 'structured' })).toBeUndefined();
  });

  it('explains observed and missing evidence', () => {
    expect(toolEvidenceGap({ evidence: 'observed' })).toBe(
      'Client evidence is observed; structured tool evidence is required.'
    );
    expect(toolEvidenceGap({ evidence: 'none' })).toBe(
      'Client evidence is none; structured tool evidence is required.'
    );
  });
});

describe('gradeTrial', () => {
  const graded: GradedExecution = {
    response: mapped,
    clientResponse: clientResponse,
    evidence: 'structured',
  };

  it('grades tool calls, metrics and the trace view on structured evidence', async () => {
    const outcome = await gradeTrial({ assertions: toolExpect }, graded);
    expect(outcome.scores.toolsTriggered?.pass).toBe(false);
    expect(outcome.scores.toolCallCount?.pass).toBe(true);
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.toolRecall).toBe(0.5);
    // Matched on mapped names, shown with the client's own names.
    expect(outcome.toolCallTrace).toEqual({
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

  it('fails every tool assertion with the gap and grades the rest', async () => {
    const outcome = await gradeTrial(
      {
        assertions: { ...toolExpect, containsText: 'sunny' },
      },
      { ...graded, evidence: 'observed' }
    );
    const details =
      'Client evidence is observed; structured tool evidence is required.';
    expect(outcome.scores.toolsTriggered).toEqual({
      pass: false,
      details,
    });
    expect(outcome.scores.toolCallCount).toEqual({
      pass: false,
      details,
    });
    expect(outcome.scores.textContains?.pass).toBe(true);
    expect(outcome.toolPrecision).toBeUndefined();
    expect(outcome.toolRecall).toBeUndefined();
    expect(outcome.toolCallTrace).toBeUndefined();
  });

  it('lists a required call made with the wrong arguments as missed', async () => {
    const outcome = await gradeTrial(
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
    expect(outcome.scores.toolsTriggered?.pass).toBe(false);
    expect(outcome.toolRecall).toBe(0);
    // Precision counts the call by identity; recall misses it on arguments.
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.toolCallTrace).toEqual({
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

  it('fails a lone toolCallCount assertion on an evidence gap', async () => {
    const outcome = await gradeTrial(
      { assertions: { toolCallCount: { max: 5 } } },
      { ...graded, evidence: 'observed' }
    );
    expect(outcome.scores).toEqual({
      toolCallCount: {
        pass: false,
        details:
          'Client evidence is observed; structured tool evidence is required.',
      },
    });
  });

  it("grades on the client's evidence, not external trace metadata", async () => {
    const outcome = await gradeTrial(
      { assertions: toolExpect },
      { ...graded, clientMetadata: external({ traceConfidence: 'low' }) }
    );
    expect(outcome.scores.toolCallCount?.pass).toBe(true);
    expect(outcome.toolPrecision).toBe(0.5);
  });

  it('grades no judge for an empty judges list', async () => {
    const outcome = await gradeTrial({ judges: [] }, { response: 'x' });
    expect(outcome.scores.judge).toBeUndefined();
  });

  it('grades judges on a case without assertions', async () => {
    installPlugins([
      {
        meta: { name: 'only-judges', namespace: 'only' },
        judges: {
          j: {
            schema: z.object({}).passthrough(),
            evaluate: async () => ({ score: 1 }),
          },
        },
      },
    ]);
    const outcome = await gradeTrial(
      { judges: ['only/judge/j'] },
      { response: 'x' }
    );
    expect(outcome.scores.judge).toMatchObject({
      pass: true,
      judgeName: 'only/judge/j',
    });
  });

  it('passes resolved judge settings to the judge', async () => {
    const seen: unknown[] = [];
    const plugin: Plugin = {
      meta: { name: 'test-plugin', namespace: 'test' },
      judges: {
        'grading-test-judge': {
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
    const outcome = await gradeTrial(
      {
        expected: { answer: 'canonical' },
        judges: [{ type: 'test/judge/grading-test-judge' }],
      },
      { response: 'answer' }
    );
    expect(outcome.scores.judge).toMatchObject({
      pass: true,
      judgeName: 'test/judge/grading-test-judge',
    });
    expect(seen).toEqual([{ candidate: 'answer', reference: 'canonical' }]);
  });
});

describe('resolveJudges', () => {
  it("keeps a rubric judge's flat rubric when it also has options", () => {
    const [judge] = resolveJudges({
      judges: [
        {
          type: 'rubric',
          rubric: 'correctness',
          threshold: 0.8,
          options: { temperature: 0 },
        },
      ],
    });
    expect(judge).toMatchObject({
      rubric: 'correctness',
      threshold: 0.8,
      options: { temperature: 0 },
    });
    expect(judge).not.toHaveProperty('judge');
    expect(judgeNameOf(judge!)).toBe('correctness');
  });

  it('applies judge reps, then case reps, then 1', () => {
    const judges = resolveJudges({
      judgeReps: 3,
      judges: [{ type: 'a', reps: 5 }, { type: 'b' }],
    });
    expect(judges.map((judge) => judge.reps)).toEqual([5, 3]);
    expect(resolveJudges({ judges: [{ type: 'c' }] })[0]?.reps).toBe(1);
  });

  it('uses expected.answer only when no reference is set', () => {
    const judges = resolveJudges({
      expected: { answer: 'canonical' },
      judges: [
        { type: 'a', reference: 'explicit' },
        { type: 'b', reference: '' },
        { type: 'c' },
      ],
    });
    expect(judges.map((judge) => judge.reference)).toEqual([
      'explicit',
      '',
      'canonical',
    ]);
  });

  it('returns nothing when no judge is configured', () => {
    expect(resolveJudges({})).toEqual([]);
  });
});

describe('mergeEvalJudges', () => {
  it('lets a case override an eval config judge and keeps its other judges', () => {
    const merged = mergeEvalJudges(
      {
        expected: { answer: 'canonical' },
        judges: [
          { type: 'config', reference: 'case', options: { count: 3 } },
          { type: 'case-only', threshold: 0.5 },
        ],
      },
      [{ type: 'config', reference: 'suite', count: 2 }],
      [{ type: 'config', reference: 'suite', count: 2, raw: true }]
    );
    expect(merged).toEqual([
      { type: 'case-only', threshold: 0.5 },
      {
        type: 'config',
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
    const merged = mergeEvalJudges(
      {
        judges: [
          { type: 'rubric', rubric: 'correctness', threshold: 0.9 },
          { type: 'case-only' },
        ],
      },
      raw,
      raw
    );
    expect(merged).toEqual([
      { type: 'case-only' },
      {
        type: 'rubric',
        rubric: 'correctness',
        threshold: 0.9,
        options: { rubric: 'correctness' },
        reference: undefined,
      },
      {
        type: 'rubric',
        rubric: 'conciseness',
        threshold: 0.6,
        options: { rubric: 'conciseness' },
        reference: undefined,
      },
    ]);
  });

  it('falls back from the eval config reference to expected.answer', () => {
    const [withEvalRef] = mergeEvalJudges(
      { expected: { answer: 'canonical' } },
      [{ type: 'j', reference: 'suite' }],
      []
    );
    const [withoutRef] = mergeEvalJudges(
      { expected: { answer: 'canonical' } },
      [{ type: 'j' }],
      []
    );
    expect(withEvalRef?.reference).toBe('suite');
    expect(withoutRef?.reference).toBe('canonical');
  });
});
