/**
 * 95% intervals for pass rates, and how many trials a run needs before its
 * pass rates mean something.
 *
 * - A case's own pass rate gets an exact (Clopper–Pearson) interval over its
 *   trials. Unlike the normal approximation, it doesn't shrink to zero width
 *   when every trial passes: 10 of 10 bounds the rate at 69.2–100%.
 * - A pass rate over several cases (the mean of their per-case rates) counts
 *   cases, not trials, as the sampling unit: trials of one case are
 *   correlated, so pooling them overstates precision. The interval is Korn
 *   and Graubard's (1998): Clopper–Pearson at Kish's effective sample size,
 *   the variance of the rate over cases turned into an equivalent number of
 *   independent trials, never more than the trials that ran. Their
 *   degrees-of-freedom adjustment then shrinks that size when there are few
 *   cases, as a t-interval widens with few observations.
 * - When every trial passes (or every one fails) the variance over cases is
 *   zero, and the effective size is the trials that ran, as Korn and
 *   Graubard set it. That keeps the interval continuous: one failure among
 *   many passing trials never narrows it, and more trials always help.
 */
import type { PassRateInterval } from '../types/reporter.js';

/** Each tail's share outside a two-sided 95% interval. */
const TAIL = 0.025;

/**
 * Widest half-width a pass rate's interval can have and still be reported
 * as a result: ±10 points.
 */
const MAX_HALF_WIDTH = 0.1;

/** Trials per case to run while developing an eval, as the evals guide advises. */
const DEVELOPMENT_TRIALS_PER_CASE = 10;

/** Trials per case to run before a release decision, as the evals guide advises. */
const RELEASE_TRIALS_PER_CASE = 20;

/** Lanczos approximation of ln Γ(x), for x > 0 (error below 1e-14). */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = c[0]!;
  for (let i = 1; i < g + 2; i++) sum += c[i]! / (z + i);
  const t = z + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
  );
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b): the Beta(a, b) CDF at x. */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(x, a, b)) / a
    : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** Student's t at the upper 2.5% point, for `df` degrees of freedom (any df > 0). */
export function tCritical975(df: number): number {
  // For t > 0, P(T > t) = I_{df / (df + t²)}(df / 2, 1 / 2) / 2.
  const upperTail = (t: number) =>
    regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (upperTail(mid) > TAIL) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The p-quantile of Beta(a, b), by bisection on its CDF. */
function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Exact (Clopper–Pearson) 95% interval for a share of `passes` out of
 * `trials`. Either count may be fractional, as an effective sample is.
 */
export function clopperPearson(
  passes: number,
  trials: number
): { lower: number; upper: number } {
  if (!(trials > 0)) return { lower: 0, upper: 1 };
  const k = Math.min(Math.max(passes, 0), trials);
  return {
    lower: k <= 0 ? 0 : betaQuantile(TAIL, k, trials - k + 1),
    upper: k >= trials ? 1 : betaQuantile(1 - TAIL, k + 1, trials - k),
  };
}

/** One case's trials: how many ran (infrastructure failures left out) and passed. */
export interface CaseTally {
  passes: number;
  trials: number;
}

/**
 * The 95% interval for the mean of the cases' pass rates, counting cases as
 * the sampling unit (see the module comment). Undefined when no case has a
 * trial.
 */
export function passRateInterval(
  cases: CaseTally[]
): PassRateInterval | undefined {
  const counted = cases.filter((c) => c.trials > 0);
  if (counted.length === 0) return undefined;
  const rates = counted.map((c) => c.passes / c.trials);
  const m = counted.length;
  const total = counted.reduce((sum, c) => sum + c.trials, 0);
  const p = rates.reduce((sum, r) => sum + r, 0) / m;
  // One case: its trials are the sample, independent given the case.
  if (m === 1) return withBounds(p, total);
  // Kish: the trials that would give the rate this variance if they were
  // independent. No variance (every case at the same rate, or every trial
  // agreeing) is no evidence of correlation: the trials that ran.
  const variance =
    rates.reduce((sum, r) => sum + (r - p) ** 2, 0) / (m - 1) / m;
  const kish = variance > 0 ? Math.min(total, (p * (1 - p)) / variance) : total;
  // Korn and Graubard's adjustment for the m - 1 degrees of freedom the
  // variance has: few cases shrink the effective size.
  const adjust = (tCritical975(total - 1) / tCritical975(m - 1)) ** 2;
  return withBounds(p, Math.min(total, kish * adjust));
}

function withBounds(p: number, effective: number): PassRateInterval {
  const { lower, upper } = clopperPearson(p * effective, effective);
  return {
    lower,
    upper,
    effectiveTrials: Number(effective.toPrecision(6)),
    // A hair of slack, so ±10.0 points exactly isn't counted as wider.
    tooWide: (upper - lower) / 2 > MAX_HALF_WIDTH + 1e-9,
  };
}

/**
 * Passing trials in a row it takes to show a pass rate of at least `rate`,
 * by the lower end of the same 95% interval: ln(0.025) / ln(rate). 36 for
 * 90%, 72 for 95%.
 */
export function trialsToShow(rate: number): number {
  return Math.ceil(Math.log(TAIL) / Math.log(rate) - 1e-9);
}

/**
 * Trials per case to run next when a rate's interval is too wide: the
 * guide's 10, or its 20, whichever is more than the run has and is first
 * expected to bring the interval within ±10 points. The expectation keeps
 * each case's pass rate as it is, so a rate held back by how much cases
 * differ, not by how few trials ran, gets none. Undefined then, and from 20
 * trials on: more cases narrow it, not more trials.
 */
export function suggestedTrialsPerCase(
  cases: CaseTally[],
  current: number
): number | undefined {
  for (const next of [DEVELOPMENT_TRIALS_PER_CASE, RELEASE_TRIALS_PER_CASE]) {
    if (next <= current) continue;
    const expected = passRateInterval(
      cases
        .filter((c) => c.trials > 0)
        .map((c) => ({ passes: (c.passes / c.trials) * next, trials: next }))
    );
    if (expected && !expected.tooWide) return next;
  }
  return undefined;
}
