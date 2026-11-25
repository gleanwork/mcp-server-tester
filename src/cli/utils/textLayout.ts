/**
 * Layout for the CLI's listings (`mst clients`, `mst judges`): words wrapped
 * to a width, tables whose last column wraps under itself, and lists under a
 * heading. Lines break only at spaces, so a path, a command or an environment
 * variable in the output is never split.
 */

/** Where text is written, as the layout needs it: a terminal has columns. */
export interface OutputStream {
  isTTY?: boolean;
  columns?: number;
}

/**
 * The width to lay text out in: the terminal's, kept between 60 and 120
 * columns, or 100 when output goes to a file or a pipe.
 */
export function outputWidth(stream: OutputStream = process.stdout): number {
  if (stream.isTTY === true && stream.columns)
    return Math.min(120, Math.max(60, stream.columns));
  return 100;
}

/** `text` in lines of at most `width` characters, unless one word is longer. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * `text` wrapped to `width`, its first line after `first` and the others
 * after `indent`. With a bullet as `first`, the lines after it align with
 * its text.
 */
export function indented(
  text: string,
  width: number,
  indent: string,
  first: string = indent
): string[] {
  return wrap(text, Math.max(20, width - indent.length)).map(
    (line, index) => `${index === 0 ? first : indent}${line}`
  );
}

/**
 * A heading and its items: one item on the line below, more as a bulleted
 * list. No items, no section.
 */
export function listSection(
  heading: string,
  items: readonly string[] | undefined,
  width: number
): string[] {
  if (!items?.length) return [];
  const lines =
    items.length === 1
      ? indented(items[0]!, width, '  ')
      : items.flatMap((item) => indented(item, width, '    ', '  - '));
  return ['', heading, ...lines];
}
