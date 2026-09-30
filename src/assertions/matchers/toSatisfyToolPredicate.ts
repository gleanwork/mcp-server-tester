/**
 * toSatisfyToolPredicate Matcher
 *
 * Validates that a response satisfies a custom predicate function.
 * This is an escape hatch for custom validation logic when built-in
 * matchers don't cover the use case.
 */

import { validatePredicate } from '../validators/predicate.js';
import type { ToolPredicate } from '../validators/types.js';

/**
 * Creates the toSatisfyToolPredicate matcher function
 *
 * This matcher allows custom validation logic via a predicate function.
 * The predicate receives both the raw response and extracted text. A
 * predicate that throws fails the assertion with or without `.not`.
 *
 * @example
 * ```typescript
 * // Simple boolean predicate
 * expect(result).toSatisfyToolPredicate((response) => {
 *   return response.data?.length > 0;
 * });
 *
 * // Predicate with custom message
 * expect(result).toSatisfyToolPredicate((response, text) => {
 *   const hasTemperature = text.includes('temperature');
 *   return {
 *     pass: hasTemperature,
 *     message: hasTemperature
 *       ? 'Found temperature in response'
 *       : 'Expected response to contain temperature',
 *   };
 * });
 *
 * // Async predicate
 * expect(result).toSatisfyToolPredicate(async (response) => {
 *   const isValid = await validateWithExternalService(response);
 *   return isValid;
 * });
 * ```
 */
export async function toSatisfyToolPredicate(
  this: { isNot: boolean },
  received: unknown,
  predicate: ToolPredicate,
  description?: string
): Promise<{ pass: boolean; message: () => string }> {
  const predicateDescription = description ?? 'custom predicate';
  const result = await validatePredicate(
    received,
    predicate,
    predicateDescription
  );
  // A crash is not a "false": fail in both directions.
  if (result.details?.error !== undefined) throw new Error(result.message);
  return {
    pass: result.pass,
    message: () =>
      this.isNot
        ? `Expected response NOT to satisfy ${predicateDescription}`
        : result.message,
  };
}
