/**
 * Schema Validator
 *
 * Validates that a response matches a Zod schema.
 */

import type { ZodType, ZodError } from 'zod';
import type { ValidationResult, SchemaValidatorOptions } from './types.js';
import { extractText, stringifyResponse } from './utils.js';

/**
 * Validates that a response matches a Zod schema
 *
 * Attempts to parse the response with the provided Zod schema.
 * If the response is a text representation of JSON, it will be parsed first.
 *
 * @param response - The response to validate
 * @param schema - The Zod schema to validate against
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 *
 * const WeatherSchema = z.object({
 *   temperature: z.number(),
 *   conditions: z.string(),
 * });
 *
 * const result = validateSchema(response, WeatherSchema);
 * if (!result.pass) {
 *   console.log(result.message);
 * }
 * ```
 */
export function validateSchema(
  response: unknown,
  schema: ZodType,
  options: SchemaValidatorOptions = {}
): ValidationResult {
  // Get the value to validate
  const valueToValidate = getValidatableValue(response);

  // If strict mode is enabled and we have an object schema with .strict(),
  // the schema itself should handle this - the option is for documentation
  if (options.strict && valueToValidate !== null) {
    // Strict mode is handled by the schema itself (using z.object().strict())
    // This option documents the intent but the actual strictness comes from the schema
  }

  try {
    // Attempt to parse with the schema
    schema.parse(valueToValidate);

    return {
      pass: true,
      message: 'Response matches schema',
    };
  } catch (error) {
    const zodError = error as ZodError;
    const issues = formatZodIssues(zodError);

    const text = stringifyResponse(response);
    return {
      pass: false,
      message: `Response does not match schema: ${issues}`,
      details: {
        issues: zodError.issues,
        textPreview: truncateForDisplay(text),
      },
    };
  }
}

/**
 * Extracts a validatable value from a response
 *
 * Handles various response formats:
 * - NormalizedToolResponse: extracts structuredContent or parses text
 * - CallToolResult: extracts structuredContent or parses content
 * - Plain objects: used directly
 * - Strings: parsed as JSON
 */
function getValidatableValue(response: unknown): unknown {
  if (response === null || response === undefined) {
    return null;
  }

  // Plain object - use directly (might be a schema-ready value)
  if (typeof response === 'object' && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;

    // Check for structuredContent (MCP response with structured data)
    if ('structuredContent' in r && r.structuredContent !== undefined) {
      return r.structuredContent;
    }

    // Check for normalized response format
    if ('raw' in r && 'text' in r && 'isError' in r && 'contentBlocks' in r) {
      // It's a NormalizedToolResponse
      if (r.structuredContent !== undefined) {
        return r.structuredContent;
      }
      // Try to parse text as JSON
      const text = r.text as string;
      return tryParseJson(text) ?? response;
    }

    // Check for raw CallToolResult format
    if ('content' in r && Array.isArray(r.content)) {
      // Try to extract and parse text content
      const text = extractText(response);
      return tryParseJson(text) ?? response;
    }

    // Regular object - use as-is
    return response;
  }

  // String - try to parse as JSON
  if (typeof response === 'string') {
    return tryParseJson(response) ?? response;
  }

  // Array or primitive - use directly
  return response;
}

/**
 * Attempts to parse a string as JSON
 */
function tryParseJson(text: string): unknown {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  // Quick check for JSON-like strings
  if (
    !(trimmed.startsWith('{') || trimmed.startsWith('[')) ||
    !(trimmed.endsWith('}') || trimmed.endsWith(']'))
  ) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Formats Zod issues into a human-readable string
 */
function formatZodIssues(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${path}: ${issue.message}`;
  });

  return issues.join('; ');
}

function truncateForDisplay(str: string, maxLength = 200): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '... (truncated)';
}
