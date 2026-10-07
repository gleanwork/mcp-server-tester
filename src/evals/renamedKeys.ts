import { z } from 'zod';

/**
 * Schema fields for keys that 2.0's eval vocabulary renamed (ADR 0002). An
 * old key is still recognized, so a config that uses one fails with a message
 * naming its replacement rather than as an unrecognized key. There are no
 * aliases: the old name never works.
 */
export function renamedKeys<const T extends Record<string, string>>(
  renames: T
): { [K in keyof T]: z.ZodOptional<z.ZodNever> } {
  return Object.fromEntries(
    Object.entries(renames).map(([from, to]) => [
      from,
      z.never({ message: `\`${from}\` is now \`${to}\`` }).optional(),
    ])
  ) as { [K in keyof T]: z.ZodOptional<z.ZodNever> };
}

/**
 * Schema fields for keys that 2.0 removed. An old key is still recognized,
 * so a config that uses one fails with `reason` (what replaces it) rather
 * than as an unrecognized key.
 */
export function removedKeys<const T extends Record<string, string>>(
  reasons: T
): { [K in keyof T]: z.ZodOptional<z.ZodNever> } {
  return Object.fromEntries(
    Object.entries(reasons).map(([key, reason]) => [
      key,
      z.never({ message: `\`${key}\` is gone: ${reason}` }).optional(),
    ])
  ) as { [K in keyof T]: z.ZodOptional<z.ZodNever> };
}

/**
 * Throw for an option 2.0 renamed (ADR 0002) that a JavaScript caller still
 * passes, naming its replacement, rather than ignoring it or failing later.
 */
export function rejectRenamedOptions(
  options: object,
  renames: Readonly<Record<string, string>>,
  where: string
): void {
  for (const [from, to] of Object.entries(renames))
    if (Object.hasOwn(options, from))
      throw new Error(`${where}: \`${from}\` is now \`${to}\`.`);
}
