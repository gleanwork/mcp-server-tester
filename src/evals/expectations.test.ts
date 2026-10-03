import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Expect } from '@playwright/test';
import {
  evaluateExpectations,
  mergeSuiteJudges,
  resolveJudges,
  toolEvidenceGap,
  type GradedExecution,
} from './expectations.js';
import type { HostResponse } from './caseExecution.js';
import type { ExternalHostMetadata } from './externalHost/types.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';

afterEach(() => resetPluginsForTests());

const hostResponse: HostResponse = {
  success: true,
  response: 'It is sunny.',
  toolCalls: [
    { name: 'native_weather', arguments: { city: 'London' } },
    { name: 'search', arguments: {} },
  ],
};

/** The same response with native names mapped to MCP names, as the runner grades it. */
const mapped: HostResponse = {
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
    expect(toolEvidenceGap({ mode: 'mcp_host' }, {})).toBeUndefined();
    expect(
      toolEvidenceGap({ mode: 'mcp_host' }, { evidence: 'structured' })
    ).toBeUndefined();
  });

  it('explains observed and missing evidence', () => {
    expect(toolEvidenceGap({ mode: 'host' }, { evidence: 'observed' })).toBe(
      'Host evidence is observed; structured tool evidence is required.'
    );
    expect(toolEvidenceGap({ mode: 'host' }, { evidence: 'none' })).toBe(
      'Host evidence is none; structured tool evidence is required.'
    );
  });

  it('prefers the external trace-source explanation over host evidence', () => {
    const gap = toolEvidenceGap(
      { mode: 'external_host' },
      {
        evidence: 'observed',
        externalHost: external({
          traceSource: 'screenshot',
          traceConfidence: 'low',
        }),
      }
    );
    expect(gap).toMatch(/^External host trace source screenshot \(low/);
  });

  it('judges external trace quality only for external_host cases', () => {
    const lowTrace = external({ traceConfidence: 'low' });
    expect(
      toolEvidenceGap({ mode: 'mcp_host' }, { externalHost: lowTrace })
    ).toBeUndefined();
  });

  it('uses per-field tool evidence when the host reports it', () => {
    const graded = {
      externalHost: external({
        traceSource: 'screenshot',
        traceConfidence: 'low',
        evidence: {
          toolCalls: { source: 'mcp-proxy', confidence: 'high' },
        },
      } as Partial<ExternalHostMetadata>),
    };
    expect(toolEvidenceGap({ mode: 'external_host' }, graded)).toBeUndefined();
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
      { mode: 'mcp_host', expect: toolExpect },
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

  it('keeps metrics for a failing external_host assertion on structured evidence', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'external_host', expect: toolExpect },
      { ...graded, externalHost: external() }
    );
    expect(outcome.expectations.toolsTriggered?.pass).toBe(false);
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.mcpHostTrace).toBeDefined();
  });

  it('fails every tool expectation with the gap and grades the rest', async () => {
    const outcome = await evaluateExpectations(
      {
        mode: 'host',
        expect: { ...toolExpect, containsText: 'sunny' },
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
        mode: 'mcp_host',
        expect: {
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

  it('applies the external trace explanation to both tool expectations', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'external_host', expect: toolExpect },
      {
        ...graded,
        evidence: 'observed',
        externalHost: external({
          traceSource: 'screenshot',
          traceConfidence: 'low',
        }),
      }
    );
    for (const key of ['toolsTriggered', 'toolCallCount'] as const) {
      expect(outcome.expectations[key]?.pass).toBe(false);
      expect(outcome.expectations[key]?.details).toMatch(
        /^External host trace source screenshot \(low confidence\)/
      );
    }
    expect(outcome.toolPrecision).toBeUndefined();
    expect(outcome.toolRecall).toBeUndefined();
    expect(outcome.mcpHostTrace).toBeUndefined();
  });

  it('applies host evidence when the external trace is structured', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'external_host', expect: toolExpect },
      { ...graded, evidence: 'none', externalHost: external() }
    );
    expect(outcome.expectations.toolsTriggered?.details).toBe(
      'Host evidence is none; structured tool evidence is required.'
    );
    expect(outcome.mcpHostTrace).toBeUndefined();
  });

  it('fails a lone toolCallCount expectation on an evidence gap', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'host', expect: { toolCallCount: { max: 5 } } },
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

  it('ignores external trace quality outside external_host mode', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'mcp_host', expect: toolExpect },
      { ...graded, externalHost: external({ traceConfidence: 'low' }) }
    );
    expect(outcome.expectations.toolCallCount?.pass).toBe(true);
    expect(outcome.toolPrecision).toBe(0.5);
  });

  it('grades an external_host case without trace metadata on host evidence alone', async () => {
    // Not produced by the runtime (metadata is required); pinned so the
    // behaviour can't change silently.
    const outcome = await evaluateExpectations(
      { mode: 'external_host', expect: toolExpect },
      graded
    );
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.mcpHostTrace).toBeDefined();
  });

  it('builds no trace view for direct responses', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'direct', expect: { toolsTriggered: toolExpect.toolsTriggered } },
      { response: mapped }
    );
    expect(outcome.toolPrecision).toBe(0.5);
    expect(outcome.mcpHostTrace).toBeUndefined();
  });

  it('reports a schema that is not registered', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'direct', expect: { schema: 'Missing' } },
      { response: {} }
    );
    expect(outcome.expectations.schema).toEqual({
      pass: false,
      details: 'Schema "Missing" not found in schemas registry',
    });
  });

  it('reports an empty judge list as 0/0 judges passed', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'direct', expect: { passesJudge: [] } },
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
        mode: 'direct',
        canonicalAnswer: 'canonical',
        expect: { passesJudge: { judge: 'test/expectations-test-judge' } },
      },
      { response: 'answer' }
    );
    expect(outcome.expectations.judge).toMatchObject({
      pass: true,
      judgeName: 'test/expectations-test-judge',
    });
    expect(seen).toEqual([{ candidate: 'answer', reference: 'canonical' }]);
  });

  /** A Playwright-like expect whose toMatchSnapshot compares with saved text. */
  function snapshotExpect(saved: Record<string, string>): Expect {
    function stub(content: unknown) {
      return {
        async toMatchSnapshot(name: string) {
          if (saved[name] !== content)
            throw new Error(
              `Snapshot "${name}" mismatched: ${String(content)}`
            );
        },
      };
    }
    return stub as unknown as Expect;
  }

  it('grades a snapshot expectation through the Playwright store', async () => {
    const playwrightExpect = snapshotExpect({ weather: 'id [UUID]' });
    const response = 'id 123e4567-e89b-12d3-a456-426614174000';
    const matches = await evaluateExpectations(
      {
        mode: 'direct',
        expect: { snapshot: 'weather', snapshotSanitizers: ['uuid'] },
      },
      { response },
      { playwrightExpect }
    );
    expect(matches.expectations.snapshot).toEqual({
      pass: true,
      details: 'Matches snapshot "weather"',
    });
    const differs = await evaluateExpectations(
      { mode: 'direct', expect: { snapshot: 'weather' } },
      { response },
      { playwrightExpect }
    );
    expect(differs.expectations.snapshot).toEqual({
      pass: false,
      details: `Snapshot "weather" mismatched: ${response}`,
    });
  });

  it('reports an invalid snapshot sanitizer on the expectation', async () => {
    const outcome = await evaluateExpectations(
      {
        mode: 'direct',
        expect: { snapshot: 'weather', snapshotSanitizers: [{ pattern: '(' }] },
      },
      { response: 'x' },
      { playwrightExpect: snapshotExpect({}) }
    );
    expect(outcome.expectations.snapshot).toEqual({
      pass: false,
      details: 'invalid regex pattern "(" in snapshot sanitizer',
    });
  });

  it('fails a snapshot expectation without Playwright expect', async () => {
    const outcome = await evaluateExpectations(
      { mode: 'direct', expect: { snapshot: 'weather' } },
      { response: 'x' }
    );
    expect(outcome.expectations.snapshot).toEqual({
      pass: false,
      details: 'Snapshot testing requires expect in context',
    });
  });
});

describe('resolveJudges', () => {
  it('applies judge reps, then case reps, then 1', () => {
    const judges = resolveJudges({
      judgeReps: 3,
      expect: {
        passesJudge: [{ judge: 'a', reps: 5 }, { judge: 'b' }],
      },
    });
    expect(judges.map((judge) => judge.reps)).toEqual([5, 3]);
    expect(
      resolveJudges({ expect: { passesJudge: { judge: 'c' } } })[0]?.reps
    ).toBe(1);
  });

  it('uses the canonical answer only when no reference is set', () => {
    const judges = resolveJudges({
      canonicalAnswer: 'canonical',
      expect: {
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
    expect(resolveJudges({ expect: {} })).toEqual([]);
  });
});

describe('mergeSuiteJudges', () => {
  it('lets a case override a manifest judge and keeps its other judges', () => {
    const merged = mergeSuiteJudges(
      {
        canonicalAnswer: 'canonical',
        expect: {
          passesJudge: [
            { judge: 'manifest', reference: 'case', options: { count: 3 } },
            { judge: 'case-only', threshold: 0.5 },
          ],
        },
      },
      [{ type: 'manifest', reference: 'suite', count: 2 }],
      [{ type: 'manifest', reference: 'suite', count: 2, raw: true }]
    );
    expect(merged).toEqual([
      { judge: 'case-only', threshold: 0.5 },
      {
        type: 'manifest',
        judge: 'manifest',
        count: 2,
        reference: 'case',
        // Only the judge's own options: no routing or assertion keys.
        options: { count: 3, raw: true },
      },
    ]);
  });

  it('keeps two manifest rubric judges distinct and overrides only the one a case names', () => {
    const raw = [
      { type: 'rubric', rubric: 'correctness' },
      { type: 'rubric', rubric: 'conciseness', threshold: 0.6 },
    ];
    const merged = mergeSuiteJudges(
      {
        expect: {
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

  it('falls back from the manifest reference to the canonical answer', () => {
    const [withSuiteRef] = mergeSuiteJudges(
      { canonicalAnswer: 'canonical', expect: {} },
      [{ type: 'j', reference: 'suite' }],
      []
    );
    const [withoutRef] = mergeSuiteJudges(
      { canonicalAnswer: 'canonical', expect: {} },
      [{ type: 'j' }],
      []
    );
    expect(withSuiteRef?.reference).toBe('suite');
    expect(withoutRef?.reference).toBe('canonical');
  });
});
