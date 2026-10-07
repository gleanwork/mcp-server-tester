/**
 * Error Validator
 *
 * Validates error response behavior.
 */

import type { ValidationResult } from './types.js';
import { isErrorResponse, extractErrorMessage, extractText } from './utils.js';

/**
 * Validates that a response is (or is not) an error
 *
 * Can check for:
 * - Any error (expected = true)
 * - No error (expected = false)
 * - Error with specific message(s) (expected = string or string[])
 *
 * @param response - The response to validate
 * @param expected - What to expect (true for any error, false for no error, string for specific message)
 * @returns Validation result
 *
 * @example
 * ```typescript
 * // Expect any error
 * const result = validateError(response, true);
 *
 * // Expect no error
 * const result2 = validateError(response, false);
 *
 * // Expect error with specific message
 * const result3 = validateError(response, 'File not found');
 *
 * // Expect error containing one of several messages
 * const result4 = validateError(response, ['not found', 'does not exist']);
 * ```
 */
export function validateError(
  response: unknown,
  expected: boolean | string | string[] = true
): ValidationResult {
  const actualIsError = isErrorResponse(response);
  const errorMessage = actualIsError ? extractErrorMessage(response) : '';

  // Handle boolean assertion
  if (typeof expected === 'boolean') {
    if (expected) {
      // Expect an error
      if (actualIsError) {
        return {
          pass: true,
          message: 'Response is an error as expected',
        };
      }
      return {
        pass: false,
        message: 'Expected an error response but got success',
        details: {
          textPreview: truncateForDisplay(extractText(response)),
        },
      };
    } else {
      // Expect no error
      if (!actualIsError) {
        return {
          pass: true,
          message: 'Response is not an error as expected',
        };
      }
      return {
        pass: false,
        message: `Expected a success response but got error: "${truncateForDisplay(errorMessage)}"`,
        details: {
          errorMessage,
        },
      };
    }
  }

  // Handle string or string[] assertion
  const expectedMessages = Array.isArray(expected) ? expected : [expected];

  // Must be an error first
  if (!actualIsError) {
    return {
      pass: false,
      message: `Expected an error containing "${expectedMessages[0]}" but got success`,
      details: {
        textPreview: truncateForDisplay(extractText(response)),
      },
    };
  }

  // Check if error message contains any of the expected strings
  const matched = expectedMessages.some((msg) =>
    errorMessage.toLowerCase().includes(msg.toLowerCase())
  );

  if (matched) {
    return {
      pass: true,
      message: 'Error message contains expected text',
    };
  }

  return {
    pass: false,
    message:
      expectedMessages.length === 1
        ? `Error message does not contain "${expectedMessages[0]}"`
        : `Error message does not contain any of: ${expectedMessages.map((m) => `"${m}"`).join(', ')}`,
    details: {
      actualErrorMessage: errorMessage,
      expectedToContain: expectedMessages,
    },
  };
}

/**
 * Truncates a string for display in error messages
 */
function truncateForDisplay(str: string, maxLength = 200): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '... (truncated)';
}
