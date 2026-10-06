/**
 * Presentation helpers for the tool optimization view. Every number here is
 * computed by the library (src/evals/variantComparison.ts); these only format
 * and label it.
 */
import type {
  TrialFailureKind,
  MCPComparisonData,
  PairedChange,
  VariantComparisonEntry,
  VariantStatus,
} from '../../types';

/** Formats a share (0-1) as a percentage, dropping a trailing ".0". */
export function pct(share: number): string {
  return `${trim(share * 100)}%`;
}

/** Formats a change in share (0-1) as signed points: +87, −2.5, ±0. */
export function pts(share: number): string {
  const x = share * 100;
  const sign = x > 0.04 ? '+' : x < -0.04 ? '−' : '±';
  return `${sign}${trim(Math.abs(x))}`;
}

/** Formats a share (0-1) as unsigned points: 42, 18.3. */
export function points(share: number): string {
  return trim(Math.abs(share * 100));
}

function trim(x: number): string {
  return Math.abs(x - Math.round(x)) < 0.05
    ? String(Math.round(x))
    : x.toFixed(1);
}

/** The library's assessment on a change, as a direction. */
export function direction(change: PairedChange): 'up' | 'down' | 'flat' {
  if (change.assessment === 'better') return 'up';
  if (change.assessment === 'worse') return 'down';
  return 'flat';
}

/** A p-value to two significant figures: "p = 0.008", "p < 0.001". */
export function pValue(p: number): string {
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

/** The p-value a "clearly better" call needs, after the variant adjustment. */
export function betterThreshold(data: MCPComparisonData): number {
  return data.alpha / Math.max(1, data.variantsTried);
}

/**
 * True when a variant is clearly better overall but not on held-out cases,
 * which the selection never saw: the gain may not carry beyond the cases it
 * was tuned on.
 */
export function heldOutUnconfirmed(v: VariantComparisonEntry): boolean {
  const heldOut = v.capability.heldOutChange;
  return (
    v.capability.change?.assessment === 'better' &&
    heldOut !== undefined &&
    heldOut.assessment !== 'better'
  );
}

export function rangeText(change: PairedChange): string {
  return `${pts(change.lower)} to ${pts(change.upper)} pts`;
}

/** Display name: the baseline is "current". */
export function variantName(
  data: MCPComparisonData,
  variant: Pick<VariantComparisonEntry, 'id'>
): string {
  return variant.id === data.baselineId ? 'current' : variant.id;
}

export const STATUS_LABEL: Record<VariantStatus, string> = {
  baseline: 'Baseline',
  recommended: 'Recommended',
  breaks: 'Breaks things',
  better: 'Better, not best',
  worse: 'Worse',
  'no-change': 'No clear change',
};

/** Background and text classes for each meaning: good, bad, caution, neutral. */
export const TONE = {
  good: 'bg-green-500/10 text-green-800 dark:text-green-300',
  bad: 'bg-red-500/10 text-red-800 dark:text-red-300',
  warn: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  neutral: 'bg-muted text-muted-foreground',
} as const;

export type Tone = keyof typeof TONE;

export const STATUS_TONE: Record<VariantStatus, Tone> = {
  baseline: 'neutral',
  recommended: 'good',
  breaks: 'bad',
  better: 'neutral',
  worse: 'bad',
  'no-change': 'neutral',
};

export const FAILURE_LABEL: Record<TrialFailureKind, string> = {
  'no-tool-call': 'No tool called',
  'wrong-tool': 'Called the wrong tool',
  'check-failed': 'Right tool, but a check failed',
  error: 'Error',
};

export const FAILURE_KINDS: TrialFailureKind[] = [
  'no-tool-call',
  'wrong-tool',
  'check-failed',
  'error',
];

/** Bar colors per failure kind: categorical, not good/bad. */
export const FAILURE_COLOR: Record<TrialFailureKind, string> = {
  'no-tool-call': 'bg-indigo-400 dark:bg-indigo-300',
  'wrong-tool': 'bg-orange-400 dark:bg-orange-300',
  'check-failed': 'bg-violet-400 dark:bg-violet-300',
  error: 'bg-teal-500 dark:bg-teal-300',
};

/** What the variants changed, as a phrase for the page title. */
export function changedThing(data: MCPComparisonData): {
  what: string;
  tools: string[];
} {
  const changes = data.variants.flatMap((v) => v.toolChanges);
  const tools = [...new Set(changes.map((c) => c.tool))];
  const fields = new Set(changes.map((c) => c.field));
  const what =
    fields.size === 1 && fields.has('description')
      ? 'descriptions'
      : fields.size === 1 && fields.has('inputSchema')
        ? 'input schemas'
        : 'metadata';
  return { what, tools };
}
