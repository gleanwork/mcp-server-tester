/**
 * toHaveToolCalls Matcher
 *
 * Validates which tools the LLM called during a mcp_host simulation.
 */

import { validateToolCalls } from '../validators/toolCalls.js';
import type { ToolCallExpectation } from '../validators/toolCalls.js';

/**
 * Creates the toHaveToolCalls matcher function
 */
export function toHaveToolCalls(
  this: { isNot: boolean },
  received: unknown,
  expectation: ToolCallExpectation
) {
  const result = validateToolCalls(received, expectation);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
