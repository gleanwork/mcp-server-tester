import { describe, it, expect } from 'vitest';
import { resolveRubric, isBuiltInRubric, BUILT_IN_RUBRICS } from './rubrics.js';

describe('resolveRubric', () => {
  it('expands "correctness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('correctness');
    expect(resolved).not.toBe('correctness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "completeness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('completeness');
    expect(resolved).not.toBe('completeness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "groundedness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('groundedness');
    expect(resolved).not.toBe('groundedness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "instruction-following" to a non-empty rubric string', () => {
    const resolved = resolveRubric('instruction-following');
    expect(resolved).not.toBe('instruction-following');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('expands "conciseness" to a non-empty rubric string', () => {
    const resolved = resolveRubric('conciseness');
    expect(resolved).not.toBe('conciseness');
    expect(resolved.length).toBeGreaterThan(10);
  });

  it('returns custom rubric text unchanged when given { text: ... }', () => {
    const custom = 'My custom rubric for evaluating X';
    expect(resolveRubric({ text: custom })).toBe(custom);
  });

  it('returns text from { text: ... } object as-is', () => {
    const text = 'Does the response accurately describe the weather?';
    expect(resolveRubric({ text })).toBe(text);
  });
});

describe('5-point scale rubrics', () => {
  const ALL_FIVE_SCORES = ['1.0', '0.75', '0.5', '0.25', '0.0'];

  it.each([
    'correctness',
    'completeness',
    'groundedness',
    'instruction-following',
    'conciseness',
  ] as const)('"%s" rubric mentions all 5 score levels', (rubricName) => {
    const text = BUILT_IN_RUBRICS[rubricName];
    for (const score of ALL_FIVE_SCORES) {
      expect(text, `${rubricName} should mention score ${score}`).toContain(
        score
      );
    }
  });

  it('all built-in rubrics mention Score 0.75 (5-point scale)', () => {
    for (const [name, text] of Object.entries(BUILT_IN_RUBRICS)) {
      expect(text, `${name} should be on a 5-point scale`).toContain('0.75');
    }
  });
});

describe('isBuiltInRubric', () => {
  it('returns true for all built-in rubric names', () => {
    for (const name of Object.keys(BUILT_IN_RUBRICS)) {
      expect(isBuiltInRubric(name)).toBe(true);
    }
  });

  it('returns false for custom strings', () => {
    expect(isBuiltInRubric('my-custom-rubric')).toBe(false);
    expect(isBuiltInRubric('')).toBe(false);
    expect(isBuiltInRubric('CORRECTNESS')).toBe(false); // case sensitive
  });

  it('returns false for { text: ... } objects', () => {
    expect(isBuiltInRubric({ text: 'custom rubric' })).toBe(false);
    expect(isBuiltInRubric({ text: 'correctness' })).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isBuiltInRubric(null)).toBe(false);
    expect(isBuiltInRubric(undefined)).toBe(false);
  });

  it('returns false for numbers and booleans', () => {
    expect(isBuiltInRubric(42)).toBe(false);
    expect(isBuiltInRubric(true)).toBe(false);
  });
});
