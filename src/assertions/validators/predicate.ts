/**
 * Predicate validator: runs a custom predicate against a response and its
 * extracted text. The escape hatch when no built-in validator fits.
 */
import type {
  PredicateResult,
  ToolPredicate,
  ValidationResult,
} from './types.js';
import { extractText } from './utils.js';

function normalizeResult(result: boolean | PredicateResult): PredicateResult {
  if (typeof result === 'boolean') {
    return {
      pass: result,
      message: result ? 'Predicate passed' : 'Predicate returned false',
    };
  }
  return result;
}

/**
 * Validates that a response satisfies a predicate. A predicate that throws
 * fails with `details.error` set, so callers can tell a crash from a `false`.
 *
 * @param description - Names the predicate in default messages.
 */
export async function validatePredicate(
  response: unknown,
  predicate: ToolPredicate,
  description = 'custom predicate'
): Promise<ValidationResult> {
  try {
    const result = normalizeResult(
      await predicate(response, extractText(response))
    );
    return {
      pass: result.pass,
      message:
        result.message ??
        (result.pass
          ? `Response satisfies ${description}`
          : `Expected response to satisfy ${description}`),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      message: `Predicate threw error: ${message}`,
      details: { error: message },
    };
  }
}
