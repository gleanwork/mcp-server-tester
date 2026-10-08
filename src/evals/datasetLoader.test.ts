import { describe, it, expect } from 'vitest';
import { loadEvalDatasetFromObject } from './datasetLoader.js';

describe('datasetLoader', () => {
  describe('loadEvalDatasetFromObject', () => {
    it('should load valid dataset', () => {
      const data = {
        name: 'test-dataset',
        cases: [
          {
            id: 'case-1',
            input: 'Use get_weather',
          },
        ],
      };

      const dataset = loadEvalDatasetFromObject(data);

      expect(dataset.name).toBe('test-dataset');
      expect(dataset.cases).toHaveLength(1);
      expect(dataset.cases[0]?.id).toBe('case-1');
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
            input: 'Use test',
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
  });
});

describe('strict assertions', () => {
  it('rejects an assertion it does not know, instead of never running it', () => {
    expect(() =>
      loadEvalDatasetFromObject({
        name: 'typo',
        cases: [
          {
            id: 'one',
            input: 'Use search',
            assertions: { regex: ['found'] },
          },
        ],
      })
    ).toThrow(/regex/);
  });
});

describe('strict cases', () => {
  const dataset = (case_: Record<string, unknown>) => ({
    name: 'typos',
    cases: [{ id: 'one', input: 'Find it', ...case_ }],
  });

  it.each([
    ['a case setting', { accuracyThresold: 0.8 }, /accuracyThresold/],
    [
      'a rubric option',
      { judges: [{ type: 'rubric', rubric: 'correctness', treshold: 0.9 }] },
      /treshold/,
    ],
    [
      'a call assertion',
      {
        assertions: {
          toolsTriggered: { calls: [{ name: 'search', requird: true }] },
        },
      },
      /requird/,
    ],
    [
      'a call count',
      { assertions: { toolCallCount: { exactly: 1 } } },
      /exactly/,
    ],
  ])('rejects a misspelt %s', (_, case_, message) => {
    expect(() => loadEvalDatasetFromObject(dataset(case_))).toThrow(message);
  });

  it("keeps a named judge's own options", () => {
    const loaded = loadEvalDatasetFromObject(
      dataset({
        judges: [{ type: 'acme/judge/quality', strictness: 2 }],
      })
    );
    expect(loaded.cases[0]?.judges).toEqual([
      { type: 'acme/judge/quality', strictness: 2 },
    ]);
  });
});
