/**
 * toMatchToolPattern Matcher
 *
 * Validates that a response matches regex patterns.
 */

import { validatePattern } from '../validators/pattern.js';
import type { PatternValidatorOptions } from '../validators/types.js';

/**
 * Creates the toMatchToolPattern matcher function
 */
export function toMatchToolPattern(
  this: { isNot: boolean },
  received: unknown,
  patterns: string | RegExp | (string | RegExp)[],
  options: PatternValidatorOptions = {}
) {
  const result = validatePattern(received, patterns, options);

  const preview = result.details?.textPreview as string | undefined;

  return {
    pass: result.pass,
    message: () => {
      if (this.isNot) {
        return result.pass
          ? 'Expected response NOT to match pattern(s), but it did'
          : result.message;
      }
      if (!result.pass && preview) {
        return `${result.message}\n\nActual response (truncated):\n${preview}`;
      }
      return result.message;
    },
  };
}
