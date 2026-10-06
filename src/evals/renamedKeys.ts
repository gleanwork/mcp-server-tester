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
