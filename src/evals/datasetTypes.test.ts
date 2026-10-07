import { describe, it, expect } from 'vitest';
import {
  validateEvalCase,
  validateEvalDataset,
  EvalCaseSchema,
  type EvalCase,
  type SerializedEvalDataset,
} from './datasetTypes.js';
import { ZodError } from 'zod';

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
        passesJudge: {
          judge: 'policy',
          policy: 'strict',
          options: { limit: 3 },
        },
      },
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
          passesJudge: { rubric: { text: 'Should contain temperature' } },
          toolsTriggered: { calls: [{ name: 'get_weather' }] },
          toolCallCount: { max: 2 },
        },
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

    it('accepts passesJudge.reps', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: 'correctness', reps: 5 } },
      });
      expect(result.success).toBe(true);
    });

    it('rejects passesJudge.reps: 0', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: 'correctness', reps: 0 } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('passesJudge rubric discriminated union', () => {
    it('accepts a built-in rubric name', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: 'correctness' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a custom rubric object', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: {
            rubric: { text: 'Evaluate if the response is helpful' },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a plain string that is not a built-in rubric', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: { rubric: 'this is not a built-in rubric' },
        },
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
          assertions: { passesJudge: { rubric } },
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects a custom rubric object with empty text', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: { text: '' } } },
      });
      expect(result.success).toBe(false);
    });

    it('accepts inline judge config fields on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: {
            rubric: 'correctness',
            provider: 'openai',
            model: 'gpt-4o',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            maxTokens: 512,
            temperature: 0.2,
            maxBudgetUsd: 0.05,
            maxToolOutputSize: 100000,
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown provider values in passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: { rubric: 'correctness', provider: 'ollama' },
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects configId on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: { rubric: 'correctness', configId: 'my-judge' },
        },
      });
      // configId is no longer a field; a rubric assertion has no other keys.
      expect(result.success).toBe(false);
    });
  });

  describe('multi-judge passesJudge', () => {
    it('accepts an array of judge configs', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: [
            { rubric: 'correctness', threshold: 0.8 },
            { rubric: 'completeness', threshold: 0.7 },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts mixed rubric and custom judge in array', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: [
            { rubric: 'correctness' },
            { judge: 'domain-relevance', threshold: 0.9 },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty array', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects array entry missing both judge and rubric', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: {
          passesJudge: [{ threshold: 0.8 }],
        },
      });
      expect(result.success).toBe(false);
    });

    it('still accepts single object form (backwards compat)', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        input: 'x',
        assertions: { passesJudge: { rubric: 'correctness' } },
      });
      expect(result.success).toBe(true);
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
