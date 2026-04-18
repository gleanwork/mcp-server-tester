/**
 * toMatchToolSchema Matcher
 *
 * Validates that a response matches a Zod schema.
 */

import type { ZodType } from 'zod';
import { validateSchema } from '../validators/schema.js';
import type { SchemaValidatorOptions } from '../validators/types.js';

/**
 * Creates the toMatchToolSchema matcher function
 */
export function toMatchToolSchema(
  this: { isNot: boolean },
  received: unknown,
  schema: ZodType,
  options: SchemaValidatorOptions = {}
) {
  const result = validateSchema(received, schema, options);

  const preview = result.details?.textPreview as string | undefined;

  return {
    pass: result.pass,
    message: () => {
      if (this.isNot) {
        return result.pass
          ? 'Expected response NOT to match schema, but it did'
          : result.message;
      }
      if (!result.pass && preview) {
        return `${result.message}\n\nActual response (truncated):\n${preview}`;
      }
      return result.message;
    },
  };
}
