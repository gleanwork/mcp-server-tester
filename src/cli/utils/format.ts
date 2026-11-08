/**
 * Plain-text output for the CLI's setup commands. Lines are never wrapped,
 * so a token or a path copied from the output is whole.
 */

export type Status = 'success' | 'error' | 'info' | 'warning';

const ICONS: Record<Status, string> = {
  success: '\u2713',
  error: '\u2717',
  info: '\u2139',
  warning: '\u26A0',
};

/** A line that starts with the status's icon: `✓ Done`. */
export function status(kind: Status, message: string): string {
  return `${ICONS[kind]} ${message}`;
}

/** Indented JSON, cut to `maxLines` with a count of the lines left out. */
export function jsonPreview(data: unknown, maxLines = 15): string {
  const lines = (JSON.stringify(data, null, 2) ?? String(data)).split('\n');
  const shown = lines.slice(0, maxLines).map((line) => `  ${line}`);
  if (lines.length > maxLines) {
    shown.push(`  ... (${lines.length - maxLines} more lines)`);
  }
  return shown.join('\n');
}
