import { describe, expect, it } from 'vitest';
import { krippendorffAlpha } from './agreement.js';

describe('krippendorffAlpha', () => {
  it('is 1 when raters always agree, and undefined without variation or pairs', () => {
    expect(
      krippendorffAlpha([
        ['pass', 'pass'],
        ['fail', 'fail'],
        ['pass', 'pass'],
      ])
    ).toBe(1);
    expect(krippendorffAlpha([['pass', 'pass']])).toBeUndefined();
    expect(krippendorffAlpha([['pass'], ['fail']])).toBeUndefined();
    expect(krippendorffAlpha([])).toBeUndefined();
  });

  it('matches a worked example with missing values', () => {
    // Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability",
    // the nominal example: four raters, twelve units, values 1-5, with
    // missing ratings. Its alpha is 0.743.
    const raters = [
      [1, 2, 3, 3, 2, 1, 4, 1, 2, null, null, null],
      [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, null, 3],
      [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, null],
      [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, null],
    ];
    const units = raters[0]!.map((_, unit) =>
      raters.map((r) => (r[unit] === null ? undefined : String(r[unit])))
    );
    expect(krippendorffAlpha(units)).toBeCloseTo(0.743, 3);
  });

  it('is 0 or below when raters agree no more than chance', () => {
    expect(
      krippendorffAlpha([
        ['pass', 'fail'],
        ['fail', 'pass'],
      ])
    ).toBeLessThan(0);
  });
});
