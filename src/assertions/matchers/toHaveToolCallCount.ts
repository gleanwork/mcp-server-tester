/**
 * toHaveToolCallCount Matcher
 *
 * Validates the number of tool calls made during a mcp_host simulation.
 */

import { validateToolCallCount } from '../validators/toolCalls.js';
import type { ToolCallCountOptions } from '../validators/toolCalls.js';

/**
 * Creates the toHaveToolCallCount matcher function
 */
export function toHaveToolCallCount(
  this: { isNot: boolean },
  received: unknown,
  options: ToolCallCountOptions
) {
  const result = validateToolCallCount(received, options);

  return {
    pass: result.pass,
    message: () => result.message,
  };
}
