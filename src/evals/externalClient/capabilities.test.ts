import { describe, expect, it } from 'vitest';
import { validateClientCapabilities } from './capabilities.js';

describe('validateClientCapabilities', () => {
  it('passes when all required external client capabilities are present', () => {
    expect(
      validateClientCapabilities([
        'control',
        'input',
        'completion',
        'trace',
        'normalize',
      ])
    ).toEqual([]);
  });

  it('reports missing required capabilities', () => {
    expect(validateClientCapabilities(['control', 'input'])).toEqual([
      'completion',
      'trace',
      'normalize',
    ]);
  });
});
