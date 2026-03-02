/**
 * toMatchToolSnapshot Matcher
 *
 * Validates that a response matches a saved snapshot.
 * Uses Playwright's native snapshot testing functionality.
 */

import { expect as baseExpect } from '@playwright/test';
import type { SnapshotSanitizer } from '../validators/types.js';
import { extractText } from '../validators/utils.js';

/**
 * Built-in regex patterns for common variable data
 */
const BUILT_IN_PATTERNS: Record<
  string,
  { pattern: RegExp; replacement: string }
> = {
  timestamp: {
    pattern: /\b\d{10,13}\b/g,
    replacement: '[TIMESTAMP]',
  },
  uuid: {
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    replacement: '[UUID]',
  },
  'iso-date': {
    pattern:
      /\b\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?)?\b/g,
    replacement: '[ISO_DATE]',
  },
  objectId: {
    pattern: /\b[0-9a-f]{24}\b/gi,
    replacement: '[OBJECT_ID]',
  },
  jwt: {
    pattern: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g,
    replacement: '[JWT]',
  },
};

/**
 * Type guard for regex sanitizer
 */
function isRegexSanitizer(
  sanitizer: SnapshotSanitizer
): sanitizer is { pattern: string | RegExp; replacement?: string } {
  return (
    typeof sanitizer === 'object' &&
    sanitizer !== null &&
    'pattern' in sanitizer
  );
}

/**
 * Type guard for field removal sanitizer
 */
function isFieldRemovalSanitizer(
  sanitizer: SnapshotSanitizer
): sanitizer is { remove: string[] } {
  return (
    typeof sanitizer === 'object' && sanitizer !== null && 'remove' in sanitizer
  );
}

/**
 * Apply sanitizers to a string value
 *
 * Handles three types of sanitizers:
 * 1. Built-in names: 'timestamp', 'uuid', 'iso-date', 'objectId', 'jwt'
 * 2. Regex sanitizers: { pattern: string | RegExp, replacement?: string }
 * 3. Field removal sanitizers: { remove: string[] } - only works on JSON strings
 */
function applySanitizers(
  value: string,
  sanitizers: SnapshotSanitizer[]
): string {
  let result = value;

  for (const sanitizer of sanitizers) {
    // Handle built-in sanitizer names
    if (typeof sanitizer === 'string') {
      const builtIn = BUILT_IN_PATTERNS[sanitizer];
      if (builtIn) {
        result = result.replace(builtIn.pattern, builtIn.replacement);
      }
      continue;
    }

    // Handle regex sanitizers
    if (isRegexSanitizer(sanitizer)) {
      let pattern: RegExp;
      if (sanitizer.pattern instanceof RegExp) {
        pattern = sanitizer.pattern;
      } else {
        try {
          pattern = new RegExp(sanitizer.pattern, 'g');
        } catch {
          throw new Error(
            `toMatchToolSnapshot: invalid regex pattern "${sanitizer.pattern}" in sanitizer`
          );
        }
      }
      const replacement = sanitizer.replacement ?? '[SANITIZED]';
      result = result.replace(pattern, replacement);
      continue;
    }

    // Handle field removal sanitizers
    if (isFieldRemovalSanitizer(sanitizer)) {
      try {
        const parsed: unknown = JSON.parse(result);
        removeFields(parsed, sanitizer.remove);
        result = JSON.stringify(parsed, null, 2);
      } catch {
        // Not valid JSON, skip field removal
      }
    }
  }

  return result;
}

/**
 * Remove fields from an object by dot-notation paths
 */
function removeFields(obj: unknown, paths: string[]): void {
  if (typeof obj !== 'object' || obj === null) {
    return;
  }

  for (const path of paths) {
    const parts = path.split('.');
    if (parts.length === 0) {
      continue;
    }

    let current: unknown = obj;

    // Navigate to parent of target field
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof current !== 'object' || current === null) {
        break;
      }
      const key = parts[i];
      if (key !== undefined) {
        current = (current as Record<string, unknown>)[key];
      }
    }

    // Delete the target field
    if (typeof current === 'object' && current !== null) {
      const lastKey = parts[parts.length - 1];
      if (lastKey !== undefined) {
        delete (current as Record<string, unknown>)[lastKey];
      }
    }
  }
}

/**
 * Creates the toMatchToolSnapshot matcher function
 *
 * Note: This is an async matcher that uses Playwright's snapshot testing.
 */
export async function toMatchToolSnapshot(
  this: { isNot: boolean },
  received: unknown,
  name: string,
  sanitizers: SnapshotSanitizer[] = []
): Promise<{ pass: boolean; message: () => string }> {
  // Extract text content from response
  let content = extractText(received);

  // Apply sanitizers
  if (sanitizers.length > 0) {
    content = applySanitizers(content, sanitizers);
  }

  // .not is not really meaningful for snapshots, but handle it gracefully
  if (this.isNot) {
    // For .not, we want to verify it does NOT match - this is unusual for snapshots
    // but we can try and check if it throws
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await baseExpect(content).toMatchSnapshot(name);
      // If it didn't throw, the snapshot matched - so .not fails
      return {
        pass: false,
        message: () =>
          `Expected response NOT to match snapshot "${name}", but it did`,
      };
    } catch {
      // Snapshot didn't match - .not passes
      return {
        pass: true,
        message: () => `Response does not match snapshot "${name}" as expected`,
      };
    }
  }

  try {
    // Use Playwright's native snapshot testing
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await baseExpect(content).toMatchSnapshot(name);
    return {
      pass: true,
      message: () => `Response matches snapshot "${name}"`,
    };
  } catch (error) {
    return {
      pass: false,
      message: () =>
        error instanceof Error
          ? error.message
          : `Response does not match snapshot "${name}"`,
    };
  }
}

export { BUILT_IN_PATTERNS, applySanitizers };
