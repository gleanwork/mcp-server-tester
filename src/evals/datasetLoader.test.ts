import { describe, it, expect } from 'vitest';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import { z } from 'zod';

describe('datasetLoader', () => {
  describe('loadEvalDatasetFromObject', () => {
    it('should load valid dataset', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'get_weather',
            args: { city: 'London' },
          },
        ],
      };

      const dataset = loadEvalDatasetFromObject(data);

      expect(dataset.name).toBe('test-dataset');
      expect(dataset.cases).toHaveLength(1);
      expect(dataset.cases[0]?.id).toBe('case-1');
    });

    it('preserves a legacy host deadline through canonical dataset loading', () => {
      const mcpHostConfig = {
        provider: 'openai',
        model: 'case-model',
        timeout: 17,
      };
      const dataset = loadEvalDatasetFromObject({
        name: 'host-deadline',
        cases: [
          { id: 'one', mode: 'mcp_host', scenario: 'hello', mcpHostConfig },
        ],
      });

      expect(dataset.cases[0]?.mcpHostConfig).toEqual(mcpHostConfig);
    });

    it.each([0, -1, 1.5, Infinity, '17'])(
      'rejects an invalid legacy host deadline: %s',
      (timeout) => {
        expect(() =>
          loadEvalDatasetFromObject({
            name: 'host-deadline',
            cases: [
              {
                id: 'one',
                mode: 'mcp_host',
                scenario: 'hello',
                mcpHostConfig: { provider: 'openai', timeout },
              },
            ],
          })
        ).toThrow();
      }
    );

    it('should attach schemas to dataset', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
            expectedSchemaName: 'test-schema',
          },
        ],
      };

      const TestSchema = z.object({
        result: z.string(),
      });

      const dataset = loadEvalDatasetFromObject(data, {
        schemas: {
          'test-schema': TestSchema,
        },
      });

      expect(dataset.schemas).toBeDefined();
      expect(dataset.schemas?.['test-schema']).toBe(TestSchema);
    });

    it('should validate dataset by default', () => {
      const invalidData = {
        name: 'test',
        cases: [], // Empty cases array is invalid
      };

      expect(() => loadEvalDatasetFromObject(invalidData)).toThrow();
    });

    it('should skip validation when validate=false', () => {
      const invalidData = {
        name: 'test',
        cases: [],
      };

      const dataset = loadEvalDatasetFromObject(invalidData, {
        validate: false,
      });

      expect(dataset.name).toBe('test');
    });

    it('should handle dataset with metadata', () => {
      const data = {
        name: 'test-dataset',
        description: 'Test description',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
          },
        ],
        metadata: {
          version: '1.0',
          author: 'test-author',
        },
      };

      const dataset = loadEvalDatasetFromObject(data);

      expect(dataset.description).toBe('Test description');
      expect(dataset.metadata).toEqual({
        version: '1.0',
        author: 'test-author',
      });
    });

    it('should handle multiple schemas', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
            expectedSchemaName: 'schema-a',
          },
          {
            id: 'case-2',
            toolName: 'test',
            args: {},
            expectedSchemaName: 'schema-b',
          },
        ],
      };

      const SchemaA = z.object({ a: z.string() });
      const SchemaB = z.object({ b: z.number() });

      const dataset = loadEvalDatasetFromObject(data, {
        schemas: {
          'schema-a': SchemaA,
          'schema-b': SchemaB,
        },
      });

      expect(dataset.schemas?.['schema-a']).toBe(SchemaA);
      expect(dataset.schemas?.['schema-b']).toBe(SchemaB);
    });

    it('should handle empty schemas object', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
          },
        ],
      };

      const dataset = loadEvalDatasetFromObject(data, {
        schemas: {},
      });

      expect(dataset.schemas).toEqual({});
    });

    it('should default to empty schemas when not provided', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            toolName: 'test',
            args: {},
          },
        ],
      };

      const dataset = loadEvalDatasetFromObject(data);

      expect(dataset.schemas).toEqual({});
    });
  });
});
