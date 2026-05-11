import { describe, expect, it } from 'vitest';
import { validateHostCapabilities } from './capabilities.js';

describe('validateHostCapabilities', () => {
  it('passes when all required external host capabilities are present', () => {
    expect(
      validateHostCapabilities([
        'control',
        'input',
        'completion',
        'trace',
        'normalize',
      ])
    ).toEqual([]);
  });

  it('reports missing required capabilities', () => {
    expect(validateHostCapabilities(['control', 'input'])).toEqual([
      'completion',
      'trace',
      'normalize',
    ]);
  });
});
