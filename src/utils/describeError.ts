import { z } from 'zod';

/**
 * One readable message for an error: a Zod validation failure as a list of
 * its issues, an Error's message, or the value itself.
 */
export function describeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return `Invalid configuration:\n${z.prettifyError(error)}`;
  return error instanceof Error ? error.message : String(error);
}
