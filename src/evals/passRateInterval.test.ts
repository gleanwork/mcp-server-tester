import { describe, expect, it } from 'vitest';
import {
  clopperPearson,
  passRateInterval,
  regularizedBeta,
  suggestedTrialsPerCase,
  tCritical975,
  trialsToShow,
} from './passRateInterval.js';

const cases = (n: number, passes: number, trials: number) =>
  Array.from({ length: n }, () => ({ passes, trials }));

describe('regularizedBeta', () => {
  it('matches closed forms', () => {
    // I_x(a, 1) = x^a and I_x(1, b) = 1 - (1 - x)^b.
    expect(regularizedBeta(0.3, 4, 1)).toBeCloseTo(0.3 ** 4, 12);
    expect(regularizedBeta(0.3, 1, 5)).toBeCloseTo(1 - 0.7 ** 5, 12);
    expect(regularizedBeta(0.5, 7, 7)).toBeCloseTo(0.5, 12);
  });
});

describe('tCritical975', () => {
  it.each([
    [1, 12.7062],
    [3, 3.1824],
    [7, 2.3646],
    [30, 2.0423],
    [1000, 1.9623],
  ])('df %i → %f', (df, t) => {
    expect(tCritical975(df)).toBeCloseTo(t, 3);
  });
});

describe('clopperPearson', () => {
  it.each([
    // passes, trials, lower, upper
    [10, 10, 0.6915, 1],
    [24, 24, 0.8575, 1],
    [3, 3, 0.2924, 1],
    [4, 4, 0.3976, 1],
    [8, 8, 0.6306, 1],
    [1, 1, 0.025, 1],
    [0, 10, 0, 0.3085],
    [5, 10, 0.1871, 0.8129],
    [17, 20, 0.6211, 0.9679],
  ])('%i of %i → %f–%f', (passes, trials, lower, upper) => {
    const interval = clopperPearson(passes, trials);
    expect(interval.lower).toBeCloseTo(lower, 4);
    expect(interval.upper).toBeCloseTo(upper, 4);
  });

  it('spans everything without trials', () => {
    expect(clopperPearson(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('passRateInterval', () => {
  it('counts one trial per case as one sample per case', () => {
    // 4 cases × 1 trial, all passing: 4 of 4.
    const interval = passRateInterval(cases(4, 1, 1))!;
    expect(interval.effectiveTrials).toBe(4);
    expect(interval.lower).toBeCloseTo(0.3976, 4);
    expect(interval.tooWide).toBe(true);
  });

  it('counts fewer trials than ran when there are few cases', () => {
    // 8 cases × 3 trials, all passing: 24 trials, shrunk by (t₂₃ / t₇)².
    const interval = passRateInterval(cases(8, 3, 3))!;
    expect(interval.effectiveTrials).toBeCloseTo(18.37, 2);
    // 0.025^(1 / 18.37): every effective trial passed.
    expect(interval.lower).toBeCloseTo(0.818, 3);
    expect(interval.upper).toBe(1);
    expect(interval.lower).toBeLessThan(clopperPearson(24, 24).lower);
  });

  it('counts trials for a single case', () => {
    const interval = passRateInterval([{ passes: 10, trials: 10 }])!;
    expect(interval.effectiveTrials).toBe(10);
    expect(interval.lower).toBeCloseTo(0.6915, 4);
  });

  it('never narrows when a trial fails', () => {
    const allPass = passRateInterval(cases(8, 10, 10))!;
    const oneFails = passRateInterval([
      { passes: 9, trials: 10 },
      ...cases(7, 10, 10),
    ])!;
    expect(oneFails.lower).toBeLessThan(allPass.lower);
    expect(oneFails.effectiveTrials).toBeLessThanOrEqual(
      allPass.effectiveTrials
    );
  });

  it('counts fewer trials the more cases differ', () => {
    // Every case passes half its trials: no spread between cases, so only
    // the few-cases adjustment applies.
    const even = passRateInterval(cases(10, 5, 10))!;
    expect(even.effectiveTrials).toBeCloseTo(76.94, 2);
    // Half the cases always pass and half never do: each case is one
    // sample, and the trials add nothing.
    const split = passRateInterval([...cases(5, 10, 10), ...cases(5, 0, 10)])!;
    expect(split.effectiveTrials).toBeCloseTo(6.92, 2);
    expect(split.upper - split.lower).toBeGreaterThan(even.upper - even.lower);
  });

  it('flags an interval wider than ±10 points', () => {
    expect(passRateInterval(cases(40, 20, 20))!.tooWide).toBe(false);
    expect(passRateInterval(cases(4, 1, 1))!.tooWide).toBe(true);
  });

  it('leaves out cases without trials', () => {
    expect(passRateInterval([{ passes: 0, trials: 0 }])).toBeUndefined();
    expect(
      passRateInterval([
        { passes: 0, trials: 0 },
        { passes: 10, trials: 10 },
      ])!.effectiveTrials
    ).toBe(10);
  });
});

describe('trialsToShow', () => {
  it('uses the lower end of the two-sided 95% interval', () => {
    expect(trialsToShow(0.9)).toBe(36);
    expect(trialsToShow(0.95)).toBe(72);
    // The count it gives is enough, and one fewer isn't.
    expect(clopperPearson(36, 36).lower).toBeGreaterThanOrEqual(0.9);
    expect(clopperPearson(35, 35).lower).toBeLessThan(0.9);
  });
});

describe('suggestedTrialsPerCase', () => {
  it('suggests the guide’s 10 or 20, whichever is expected to be enough', () => {
    // 8 cases: 80 passing trials pin the rate down.
    expect(suggestedTrialsPerCase(cases(8, 1, 1), 1)).toBe(10);
    // 4 cases: 40 trials still leave it too wide; 80 don't.
    expect(suggestedTrialsPerCase(cases(4, 1, 1), 1)).toBe(20);
    expect(suggestedTrialsPerCase(cases(8, 10, 10), 20)).toBeUndefined();
  });

  it('suggests none when the cases differ too much for trials to help', () => {
    const split = [...cases(5, 10, 10), ...cases(5, 0, 10)];
    expect(passRateInterval(split)!.tooWide).toBe(true);
    expect(suggestedTrialsPerCase(split, 10)).toBeUndefined();
  });
});
