import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  validateEvalCase,
  validateEvalDataset,
  EvalCaseSchema,
  EvalAssertionsSchema,
  type EvalCase,
  type SerializedEvalDataset,
} from './datasetTypes.js';
import { z, ZodError } from 'zod';

describe('datasetTypes', () => {
  it('retains event identity and named judge policy in serialized assertions', () => {
    const input = {
      id: 'identity',
      input: 'research',
      assertions: {
        toolsTriggered: {
          calls: [
            { name: 'search', source: 'mcp', server: 'agg', kind: 'tool_call' },
            { name: 'research', source: 'builtin', kind: 'skill' },
          ],
        },
      },
      judges: [{ type: 'policy', policy: 'strict', options: { limit: 3 } }],
    };
    expect(validateEvalCase(input)).toEqual(input);
  });

  it.each([
    { source: 'unknown' },
    { kind: 'unknown' },
    { server: 17 },
    { server: '' },
  ])('rejects invalid event identity %j', (identity) => {
    expect(() =>
      validateEvalCase({
        id: 'invalid',
        input: 'research',
        assertions: {
          toolsTriggered: { calls: [{ name: 'search', ...identity }] },
        },
      })
    ).toThrow(ZodError);
  });
  describe('validateEvalCase', () => {
    it('validates a minimal case: an id and an input', () => {
      const evalCase = { id: 'test-1', input: 'Get the weather for London' };
      expect(validateEvalCase(evalCase)).toEqual(evalCase);
    });

    it('validates a case with all fields', () => {
      const evalCase: EvalCase = {
        id: 'test-1',
        description: 'Get weather for London',
        input: 'Get the weather for London',
        client: 'mst',
        model: 'claude-haiku-4-5',
        clientOptions: { systemPrompt: 'Be brief.' },
        trials: 3,
        passThreshold: 0.6,
        judgeReps: 2,
        expected: { answer: 'Sunny, 20°C' },
        tags: ['weather'],
        assertions: {
          containsText: 'London',
          matchesPattern: '\\d+°C',
          toolsTriggered: { calls: [{ name: 'get_weather' }] },
          toolCallCount: { max: 2 },
        },
        judges: [
          { type: 'rubric', rubric: { text: 'Should contain temperature' } },
        ],
        metadata: { priority: 'high' },
      };
      expect(validateEvalCase(evalCase)).toEqual(evalCase);
    });

    it.each<[unknown, string]>([
      [{ input: 'x' }, 'without an id'],
      [{ id: '', input: 'x' }, 'with an empty id'],
      [{ id: 'test-1' }, 'without an input'],
      [{ id: 'test-1', input: '' }, 'with an empty input'],
    ])('rejects a case %j (%s)', (evalCase) => {
      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('names the replacement for a tool call source of host', () => {
      expect(() =>
        validateEvalCase({
          id: 'test-1',
          input: 'x',
          assertions: {
            toolsTriggered: { calls: [{ name: 'search', source: 'host' }] },
          },
        })
      ).toThrow("`source: 'host'` is now `source: 'builtin'`");
    });

    it.each([
      ['mode', 'host', '`mode` is gone: every case runs on the client'],
      ['mode', 'mcp_host', '`mode` is gone'],
      [
        'toolName',
        'get_weather',
        '`toolName` is gone: direct tool calls are Playwright tests',
      ],
      [
        'args',
        { city: 'London' },
        '`args` is gone: direct tool calls are Playwright tests',
      ],
      [
        'request',
        { method: 'skills/list' },
        '`request` is gone: direct requests are Playwright tests',
      ],
      ['mcpHostConfig', { provider: 'openai' }, '`mcpHostConfig` is gone'],
      ['externalHost', { driver: 'x' }, '`externalHost` is gone'],
    ])(
      'rejects the removed %s %j with what replaces it',
      (key, value, message) => {
        const result = EvalCaseSchema.safeParse({
          id: 'old',
          input: 'Get the weather for London',
          [key]: value,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([
          expect.objectContaining({
            path: [key],
            message: expect.stringContaining(message),
          }),
        ]);
      }
    );

    it.each([
      ['response', { content: [] }, 'toMatchToolResponse'],
      ['schema', 'WeatherResponse', 'toMatchToolSchema'],
      ['snapshot', 'weather', 'toMatchToolSnapshot'],
      ['snapshotSanitizers', ['uuid'], 'toMatchToolSnapshot'],
      ['isError', false, 'toBeToolError'],
      ['responseSize', { maxBytes: 10 }, 'toHaveToolResponseSize'],
    ])(
      'rejects the tool-response assertion %s and names its matcher',
      (key, value, matcher) => {
        const result = EvalCaseSchema.safeParse({
          id: 'old',
          input: 'Get the weather',
          assertions: { [key]: value },
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toEqual([
          expect.objectContaining({
            path: ['assertions', key],
            message: expect.stringContaining(matcher),
          }),
        ]);
      }
    );
  });

  describe('trials and passThreshold', () => {
    it('should accept trials and passThreshold on a case', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'multi-iter',
            input: 'Use add',
            trials: 5,
            passThreshold: 0.8,
          },
        ],
      };
      const result = validateEvalDataset(raw);
      expect(result.cases[0]!.trials).toBe(5);
      expect(result.cases[0]!.passThreshold).toBe(0.8);
    });

    it('should reject trials below 1', () => {
      const raw = {
        name: 'test',
        cases: [{ id: 'bad', input: 'add', trials: 0 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });

    it('should reject passThreshold outside 0-1', () => {
      const raw = {
        name: 'test',
        cases: [{ id: 'bad', input: 'add', passThreshold: 1.5 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });
  });

  describe('judgeReps', () => {
    it('accepts judgeReps as a positive integer', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judgeReps: 3,
      });
      expect(result.success).toBe(true);
    });

    it('rejects judgeReps: 0', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judgeReps: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects judgeReps: -1', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judgeReps: -1,
      });
      expect(result.success).toBe(false);
    });

    it("accepts a judge's reps", () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: 'correctness', reps: 5 }],
      });
      expect(result.success).toBe(true);
    });

    it("rejects a judge's reps: 0", () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: 'correctness', reps: 0 }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('rubric case judges', () => {
    it('accepts a built-in rubric name', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: 'correctness' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a custom rubric object', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [
          {
            type: 'rubric',
            rubric: { text: 'Evaluate if the response is helpful' },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a plain string that is not a built-in rubric', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: 'this is not a built-in rubric' }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts all five built-in rubric names', () => {
      const names = [
        'correctness',
        'completeness',
        'groundedness',
        'instruction-following',
        'conciseness',
      ];
      for (const rubric of names) {
        const result = EvalCaseSchema.safeParse({
          id: 'test',
          input: 'x',
          judges: [{ type: 'rubric', rubric }],
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects a custom rubric object with empty text', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: { text: '' } }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts the rubric judge's LLM settings flat", () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [
          {
            type: 'rubric',
            rubric: 'correctness',
            provider: 'openai',
            model: 'gpt-4o',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            maxTokens: 512,
            temperature: 0.2,
            maxBudgetUsd: 0.05,
            maxToolOutputSize: 100000,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown provider values', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [{ type: 'rubric', rubric: 'correctness', provider: 'ollama' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects configId on a rubric judge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        judges: [
          { type: 'rubric', rubric: 'correctness', configId: 'my-judge' },
        ],
      });
      // configId is no longer a field; a rubric judge has no other keys.
      expect(result.success).toBe(false);
    });
  });

  describe('case judges', () => {
    const parse = (judges: unknown) =>
      EvalCaseSchema.safeParse({ id: 'test', input: 'x', judges });

    it('accepts references and tagged entries, as an eval config writes them', () => {
      const result = parse([
        'acme/judge/completeness',
        { type: 'rubric', rubric: 'correctness', threshold: 0.8 },
        { type: 'acme/judge/tone', threshold: 0.9, formality: 'high' },
        { type: 'mst/judge/rubric', options: { rubric: 'conciseness' } },
      ]);
      expect(result.success).toBe(true);
      expect(result.data?.judges).toEqual([
        { type: 'acme/judge/completeness' },
        { type: 'rubric', rubric: 'correctness', threshold: 0.8 },
        { type: 'acme/judge/tone', threshold: 0.9, formality: 'high' },
        // A built-in written in full reads as its short name.
        { type: 'rubric', options: { rubric: 'conciseness' } },
      ]);
    });

    it.each([
      ['acme/metric/x', 'is a metric, not a judge'],
      ['mst/metric/rubric', 'is a metric, not a judge'],
      [{ type: 'acme/pairwise-judge/x' }, 'is a pairwise judge, not a judge'],
    ])('rejects %j, which is not a judge', (entry, message) => {
      const result = parse([entry]);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(message);
    });

    it('needs a rubric for the rubric judge', () => {
      for (const entry of ['rubric', { type: 'rubric', threshold: 0.5 }]) {
        const result = parse([entry]);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain(
          'the rubric judge needs a rubric'
        );
      }
    });

    it('names the judge in type, not judge', () => {
      const result = parse([{ type: 'acme/judge/x', judge: 'acme/judge/x' }]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(
        'a case judge names its judge in `type`'
      );
    });

    it('rejects an entry without a type', () => {
      expect(parse([{ rubric: 'correctness' }]).success).toBe(false);
      expect(parse([{ threshold: 0.8 }]).success).toBe(false);
    });

    it('accepts an empty list', () => {
      expect(parse([]).success).toBe(true);
    });

    it('rejects assertions.passesJudge, naming judges', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: 'correctness' } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path: ['assertions', 'passesJudge'],
          message: expect.stringContaining(
            "`passesJudge` is gone: list the case's judges in `judges`, beside `assertions`"
          ),
        }),
      ]);
    });
  });

  describe('toolsTriggered and toolCallCount', () => {
    it('should preserve toolsTriggered in expect block after validation', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'tool-trigger-test',
            input: 'Search for documents',
            assertions: {
              toolsTriggered: {
                calls: [{ name: 'search', required: true }],
                order: 'any',
              },
              toolCallCount: { min: 1, max: 3 },
            },
          },
        ],
      };
      const result = validateEvalDataset(raw);
      expect(result.cases[0]!.assertions?.toolsTriggered).toBeDefined();
      expect(result.cases[0]!.assertions?.toolsTriggered?.calls[0]!.name).toBe(
        'search'
      );
      expect(result.cases[0]!.assertions?.toolCallCount?.min).toBe(1);
    });
  });

  describe('renamed keys', () => {
    it.each([
      ['scenario', 'input'],
      ['iterations', 'trials'],
      ['accuracyThreshold', 'passThreshold'],
      ['expect', 'assertions'],
      ['canonicalAnswer', 'expected.answer'],
    ])('rejects %s and names %s', (from, to) => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        [from]: 'x',
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path: [from],
          message: `\`${from}\` is now \`${to}\``,
        }),
      ]);
    });

    it('accepts the reference answer as expected.answer', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        expected: { answer: 'Paris is the capital of France.' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('tags', () => {
    it('accepts an array of tag strings', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        tags: ['tool-finding', 'multi-hop'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts an empty tags array', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        tags: [],
      });
      expect(result.success).toBe(true);
    });

    it('is optional — case without tags still validates', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', input: 'x' });
      expect(result.success).toBe(true);
    });

    it('rejects non-string tag values', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        tags: [123],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('LLMProvider expansion', () => {
    it('accepts every provider in a case clientOptions', () => {
      const providers = [
        'openai',
        'anthropic',
        'google',
        'mistral',
        'azure',
        'deepseek',
        'openrouter',
        'xai',
      ];
      for (const provider of providers) {
        expect(() =>
          validateEvalDataset({
            name: 'test',
            cases: [
              {
                id: 'c',
                input: 's',
                clientOptions: { provider },
              },
            ],
          })
        ).not.toThrow();
      }
    });
  });

  describe('validateEvalDataset', () => {
    it('should validate minimal dataset', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            input: 'Use get_weather',
          },
        ],
      };

      const result = validateEvalDataset(dataset);

      expect(result).toEqual(dataset);
    });

    it('should validate dataset with all fields', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        description: 'Test dataset for weather tools',
        cases: [
          {
            id: 'case-1',
            input: 'Use get_weather',
          },
          {
            id: 'case-2',
            input: 'Use get_forecast',
          },
        ],
        metadata: {
          version: '1.0',
          author: 'test',
        },
      };

      const result = validateEvalDataset(dataset);

      expect(result).toEqual(dataset);
    });

    it('should reject dataset without name', () => {
      const dataset = {
        cases: [
          {
            id: 'case-1',
            input: 'Use test',
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with empty name', () => {
      const dataset = {
        name: '',
        cases: [
          {
            id: 'case-1',
            input: 'Use test',
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset without cases', () => {
      const dataset = {
        name: 'test-dataset',
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with empty cases array', () => {
      const dataset = {
        name: 'test-dataset',
        cases: [],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should reject dataset with invalid case', () => {
      const dataset = {
        name: 'test-dataset',
        cases: [
          {
            // missing id - this is always required
            input: 'Use get_weather',
          },
        ],
      };

      expect(() => validateEvalDataset(dataset)).toThrow(ZodError);
    });

    it('should validate dataset with multiple cases', () => {
      const dataset: SerializedEvalDataset = {
        name: 'test-dataset',
        cases: Array.from({ length: 10 }, (_, i) => ({
          id: `case-${i}`,
          input: 'Use test',
        })),
      };

      const result = validateEvalDataset(dataset);

      expect(result.cases).toHaveLength(10);
    });
  });
});

describe('the dataset editor schema', () => {
  const editor = JSON.parse(
    fs.readFileSync(
      new URL('../../schema/eval-dataset.schema.json', import.meta.url),
      'utf8'
    )
  ) as {
    definitions: Record<string, { properties: Record<string, unknown> }>;
  };
  /** Keys a schema accepts: removed and renamed keys only explain themselves. */
  function liveKeys(shape: Record<string, z.ZodType>): string[] {
    return Object.keys(shape)
      .filter((key) => {
        const field = shape[key]!;
        return !(
          field instanceof z.ZodOptional && field.unwrap() instanceof z.ZodNever
        );
      })
      .sort();
  }

  it('declares the same case keys as EvalCaseSchema, judges included', () => {
    expect(Object.keys(editor.definitions.EvalCase!.properties).sort()).toEqual(
      liveKeys(EvalCaseSchema.shape)
    );
    expect(editor.definitions.EvalCase!.properties).toHaveProperty('judges');
  });

  it('declares the same assertion keys as EvalAssertionsSchema, without passesJudge', () => {
    expect(
      Object.keys(editor.definitions.EvalAssertions!.properties).sort()
    ).toEqual(liveKeys(EvalAssertionsSchema.shape));
    expect(editor.definitions.EvalAssertions!.properties).not.toHaveProperty(
      'passesJudge'
    );
  });
});
