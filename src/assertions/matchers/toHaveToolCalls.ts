/**
 * toHaveToolCalls Matcher
 *
 * Validates which tools a client called.
 */

import { validateToolCalls } from '../validators/toolCalls.js';
import type { ToolCallAssertion } from '../validators/toolCalls.js';

/**
 * Creates the toHaveToolCalls matcher function
 */
export function toHaveToolCalls(
  this: { isNot: boolean },
  received: unknown,
  assertion: ToolCallAssertion
) {
  const result = validateToolCalls(received, assertion);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
