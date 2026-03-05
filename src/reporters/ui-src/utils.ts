/**
 * Returns a Tailwind text color class for a pass rate value (0-1).
 * Three tiers: >= 0.8 green, >= 0.6 amber, else red.
 */
export function rateColorClass(rate: number): string {
  if (rate >= 0.8) return 'text-green-600 dark:text-green-400';
  if (rate >= 0.6) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 * Values >= 1000ms display as seconds (e.g., "1.2s"); smaller values as ms (e.g., "847ms").
 */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}
