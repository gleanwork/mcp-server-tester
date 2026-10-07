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
  it('retains event identity and named judge policy in serialized expectations', () => {
    const input = {
      id: 'identity',
      mode: 'host',
      input: 'research',
      assertions: {
        toolsTriggered: {
          calls: [
            { name: 'search', source: 'mcp', server: 'agg', kind: 'tool_call' },
            { name: 'research', source: 'host', kind: 'skill' },
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
        mode: 'host',
        input: 'research',
        assertions: {
          toolsTriggered: { calls: [{ name: 'search', ...identity }] },
        },
      })
    ).toThrow(ZodError);
  });
  describe('validateEvalCase', () => {
    it('should validate minimal eval case', () => {
      const evalCase = {
        id: 'test-1',
        toolName: 'get_weather',
        args: { city: 'London' },
      };

      const result = validateEvalCase(evalCase);

      expect(result).toEqual(evalCase);
    });

    it('should validate eval case with all fields', () => {
      const evalCase: EvalCase = {
        id: 'test-1',
        description: 'Get weather for London',
        toolName: 'get_weather',
        args: { city: 'London' },
        assertions: {
          response: { temperature: 20 },
          schema: 'weather-response',
          passesJudge: {
            rubric: { text: 'Should contain temperature' },
          },
        },
        metadata: { priority: 'high' },
      };

      const result = validateEvalCase(evalCase);

      expect(result).toEqual(evalCase);
    });

    it('should reject eval case without id', () => {
      const evalCase = {
        toolName: 'get_weather',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('should reject eval case with empty id', () => {
      const evalCase = {
        id: '',
        toolName: 'get_weather',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('accepts a client case: input, no toolName', () => {
      const evalCase = {
        id: 'test-1',
        input: 'Get the weather for London',
        client: 'mst',
        model: 'claude-haiku-4-5',
        clientOptions: { systemPrompt: 'Be brief.' },
      };

      expect(validateEvalCase(evalCase)).toEqual(evalCase);
    });

    it('should reject eval case with empty toolName', () => {
      const evalCase = {
        id: 'test-1',
        toolName: '',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it.each([
      ['mode', 'mcp_host', "`mode: 'mcp_host'` is gone"],
      ['mode', 'external_host', "`mode: 'external_host'` is gone"],
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

    it('rejects a case that has both input and a toolName', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'both',
        input: 'Get the weather',
        toolName: 'get_weather',
        args: {},
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('not both');
    });

    it('should accept eval case with complex args', () => {
      const evalCase = {
        id: 'test-1',
        toolName: 'search',
        args: {
          query: 'test',
          filters: { type: 'document', date: '2024-01-01' },
          limit: 10,
        },
      };

      const result = validateEvalCase(evalCase);

      expect(result.args).toEqual(evalCase.args);
    });
  });

  describe('trials and passThreshold', () => {
    it('should accept trials and passThreshold on a case', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'multi-iter',
            toolName: 'add',
            args: { a: 1, b: 2 },
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
        cases: [{ id: 'bad', toolName: 'add', args: {}, trials: 0 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });

    it('should reject accuracyThreshold outside 0-1', () => {
      const raw = {
        name: 'test',
        cases: [{ id: 'bad', toolName: 'add', args: {}, passThreshold: 1.5 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });
  });

  describe('judgeReps', () => {
    it('accepts judgeReps as a positive integer', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        judgeReps: 3,
      });
      expect(result.success).toBe(true);
    });

    it('rejects judgeReps: 0', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', judgeReps: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects judgeReps: -1', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', judgeReps: -1 });
      expect(result.success).toBe(false);
    });

    it('accepts passesJudge.reps', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        assertions: { passesJudge: { rubric: 'correctness', reps: 5 } },
      });
      expect(result.success).toBe(true);
    });

    it('rejects passesJudge.reps: 0', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        assertions: { passesJudge: { rubric: 'correctness', reps: 0 } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('passesJudge rubric discriminated union', () => {
    it('accepts a built-in rubric name', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        assertions: { passesJudge: { rubric: 'correctness' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a custom rubric object', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
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
          assertions: { passesJudge: { rubric } },
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects a custom rubric object with empty text', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        assertions: { passesJudge: { rubric: { text: '' } } },
      });
      expect(result.success).toBe(false);
    });

    it('accepts inline judge config fields on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
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
        assertions: {
          passesJudge: { rubric: 'correctness', provider: 'ollama' },
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects configId on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
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
        assertions: { passesJudge: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects array entry missing both judge and rubric', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        assertions: {
          passesJudge: [{ threshold: 0.8 }],
        },
      });
      expect(result.success).toBe(false);
    });

    it('still accepts single object form (backwards compat)', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
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
      const result = EvalCaseSchema.safeParse({ id: 'test', [from]: 'x' });
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
        expected: { answer: 'Paris is the capital of France.' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('tags', () => {
    it('accepts an array of tag strings', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        tags: ['tool-finding', 'multi-hop'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts an empty tags array', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test', tags: [] });
      expect(result.success).toBe(true);
    });

    it('is optional — case without tags still validates', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test' });
      expect(result.success).toBe(true);
    });

    it('rejects non-string tag values', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
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
            toolName: 'get_weather',
            args: {},
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
            toolName: 'get_weather',
            args: { city: 'London' },
          },
          {
            id: 'case-2',
            toolName: 'get_forecast',
            args: { city: 'Paris', days: 7 },
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
            toolName: 'test',
            args: {},
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
            toolName: 'test',
            args: {},
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
            toolName: 'get_weather',
            args: {},
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
          toolName: 'test',
          args: { index: i },
        })),
      };

      const result = validateEvalDataset(dataset);

      expect(result.cases).toHaveLength(10);
    });
  });
});

describe('request cases', () => {
  it('accepts a request target without toolName', () => {
    const parsed = EvalCaseSchema.parse({
      id: 'skill-entry',
      request: {
        method: 'skills/get',
        params: { uri: 'skill://docs/SKILL.md' },
        server: 'docs',
      },
      assertions: { schema: 'SkillsGetResult' },
    });
    expect(parsed.request?.method).toBe('skills/get');
  });

  it('rejects request together with toolName', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'both',
      toolName: 'search',
      request: { method: 'skills/list' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'mutually exclusive'
    );
  });

  it('rejects request outside direct mode', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'host-request',
      mode: 'host',
      input: 'x',
      request: { method: 'skills/list' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'only valid for direct cases'
    );
  });

  it('rejects unknown request keys', () => {
    expect(
      EvalCaseSchema.safeParse({
        id: 'typo',
        request: { method: 'skills/list', parms: {} },
      }).success
    ).toBe(false);
  });
});
