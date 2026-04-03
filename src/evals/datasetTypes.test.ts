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
        expect: {
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

    it('should accept eval case without toolName (for mcp_host mode)', () => {
      const evalCase = {
        id: 'test-1',
        mode: 'mcp_host' as const,
        scenario: 'Get the weather for London',
      };

      expect(() => validateEvalCase(evalCase)).not.toThrow();
    });

    it('should reject eval case with empty toolName', () => {
      const evalCase = {
        id: 'test-1',
        toolName: '',
        args: {},
      };

      expect(() => validateEvalCase(evalCase)).toThrow(ZodError);
    });

    it('should accept eval case without args (for mcp_host mode)', () => {
      const evalCase = {
        id: 'test-1',
        mode: 'mcp_host' as const,
        scenario: 'Get the weather for London',
      };

      expect(() => validateEvalCase(evalCase)).not.toThrow();
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

  describe('iterations and accuracyThreshold', () => {
    it('should accept iterations and accuracyThreshold on a case', () => {
      const raw = {
        name: 'test',
        cases: [
          {
            id: 'multi-iter',
            toolName: 'add',
            args: { a: 1, b: 2 },
            iterations: 5,
            accuracyThreshold: 0.8,
          },
        ],
      };
      const result = validateEvalDataset(raw);
      expect(result.cases[0]!.iterations).toBe(5);
      expect(result.cases[0]!.accuracyThreshold).toBe(0.8);
    });

    it('should reject iterations below 1', () => {
      const raw = {
        name: 'test',
        cases: [{ id: 'bad', toolName: 'add', args: {}, iterations: 0 }],
      };
      expect(() => validateEvalDataset(raw)).toThrow();
    });

    it('should reject accuracyThreshold outside 0-1', () => {
      const raw = {
        name: 'test',
        cases: [
          { id: 'bad', toolName: 'add', args: {}, accuracyThreshold: 1.5 },
        ],
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
        expect: { passesJudge: { rubric: 'correctness', reps: 5 } },
      });
      expect(result.success).toBe(true);
    });

    it('rejects passesJudge.reps: 0', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: 'correctness', reps: 0 } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('passesJudge rubric discriminated union', () => {
    it('accepts a built-in rubric name', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: 'correctness' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a custom rubric object', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: {
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
        expect: { passesJudge: { rubric: 'this is not a built-in rubric' } },
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
          expect: { passesJudge: { rubric } },
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects a custom rubric object with empty text', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: { text: '' } } },
      });
      expect(result.success).toBe(false);
    });

    it('accepts inline judge config fields on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: {
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
        expect: {
          passesJudge: { rubric: 'correctness', provider: 'ollama' },
        },
      });
      expect(result.success).toBe(false);
    });

    it('does not accept configId on passesJudge', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: {
          passesJudge: { rubric: 'correctness', configId: 'my-judge' },
        },
      });
      // configId is no longer a recognized field — strict Zod should reject it
      // (passesJudge uses .object() which strips unknown fields but does not fail)
      // After strip, configId should be absent from the result
      if (result.success) {
        expect(
          (result.data.expect?.passesJudge as Record<string, unknown>)[
            'configId'
          ]
        ).toBeUndefined();
      }
    });
  });

  describe('multi-judge passesJudge', () => {
    it('accepts an array of judge configs', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: {
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
        expect: {
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
        expect: { passesJudge: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects array entry missing both judge and rubric', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: {
          passesJudge: [{ threshold: 0.8 }],
        },
      });
      expect(result.success).toBe(false);
    });

    it('still accepts single object form (backwards compat)', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        expect: { passesJudge: { rubric: 'correctness' } },
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
            mode: 'mcp_host',
            scenario: 'Search for documents',
            mcpHostConfig: { provider: 'openai' },
            expect: {
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
      expect(result.cases[0]!.expect?.toolsTriggered).toBeDefined();
      expect(result.cases[0]!.expect?.toolsTriggered?.calls[0]!.name).toBe(
        'search'
      );
      expect(result.cases[0]!.expect?.toolCallCount?.min).toBe(1);
    });
  });

  describe('canonicalAnswer', () => {
    it('accepts a canonical answer string', () => {
      const result = EvalCaseSchema.safeParse({
        id: 'test',
        canonicalAnswer: 'Paris is the capital of France.',
      });
      expect(result.success).toBe(true);
    });

    it('is optional — case without canonicalAnswer still validates', () => {
      const result = EvalCaseSchema.safeParse({ id: 'test' });
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
    it('should accept new provider values in mcpHostConfig', () => {
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
                mode: 'mcp_host',
                scenario: 's',
                mcpHostConfig: { provider },
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
