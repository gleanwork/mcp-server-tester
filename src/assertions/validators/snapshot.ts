/**
 * Snapshot validator: compares a response's text, after sanitizing, with a
 * named snapshot held by a snapshot store.
 */
import type { Expect } from '@playwright/test';
import type { SnapshotSanitizer, ValidationResult } from './types.js';
import { extractText } from './utils.js';

/**
 * Built-in regex patterns for common variable data
 */
export const BUILT_IN_PATTERNS: Record<
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

function isRegexSanitizer(
  sanitizer: SnapshotSanitizer
): sanitizer is { pattern: string | RegExp; replacement?: string } {
  return (
    typeof sanitizer === 'object' &&
    sanitizer !== null &&
    'pattern' in sanitizer
  );
}

function isFieldRemovalSanitizer(
  sanitizer: SnapshotSanitizer
): sanitizer is { remove: string[] } {
  return (
    typeof sanitizer === 'object' && sanitizer !== null && 'remove' in sanitizer
  );
}

/** Removes fields from an object by dot-notation paths. */
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
 * Applies sanitizers to a string value.
 *
 * Handles three types of sanitizers:
 * 1. Built-in names: 'timestamp', 'uuid', 'iso-date', 'objectId', 'jwt'
 * 2. Regex sanitizers: { pattern: string | RegExp, replacement?: string }
 * 3. Field removal sanitizers: { remove: string[] } - only works on JSON strings
 *
 * @throws When a regex sanitizer's pattern is not a valid regular expression.
 */
export function applySanitizers(
  value: string,
  sanitizers: SnapshotSanitizer[]
): string {
  let result = value;

  for (const sanitizer of sanitizers) {
    if (typeof sanitizer === 'string') {
      const builtIn = BUILT_IN_PATTERNS[sanitizer];
      if (builtIn) {
        result = result.replace(builtIn.pattern, builtIn.replacement);
      }
      continue;
    }

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

/** Where named snapshots live. */
export interface SnapshotStore {
  /**
   * Compares content with the named snapshot. The store decides what a
   * missing snapshot means (Playwright writes it under its update policy).
   */
  match(
    name: string,
    content: string
  ): Promise<{ pass: boolean; message: string }>;
}

/**
 * The current Playwright test's snapshot store, via `toMatchSnapshot`.
 * Honours `--update-snapshots` and the project's `snapshotPathTemplate`.
 */
export function playwrightSnapshotStore(expect: Expect): SnapshotStore {
  return {
    async match(name, content) {
      try {
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(content).toMatchSnapshot(name);
        return { pass: true, message: `Response matches snapshot "${name}"` };
      } catch (error) {
        return {
          pass: false,
          message:
            error instanceof Error
              ? error.message
              : `Response does not match snapshot "${name}"`,
        };
      }
    },
  };
}

export interface SnapshotValidatorOptions {
  /** Where the named snapshot lives. */
  store: SnapshotStore;
  /** Applied to the response text before comparison. */
  sanitizers?: SnapshotSanitizer[];
}

/**
 * Validates that a response's text, after sanitizing, matches a named snapshot.
 *
 * @throws When a sanitizer is invalid (a configuration error, not a mismatch).
 */
export async function validateSnapshot(
  response: unknown,
  name: string,
  options: SnapshotValidatorOptions
): Promise<ValidationResult> {
  const sanitizers = options.sanitizers ?? [];
  const text = extractText(response);
  const content =
    sanitizers.length > 0 ? applySanitizers(text, sanitizers) : text;
  const result = await options.store.match(name, content);
  return {
    pass: result.pass,
    message: result.message,
    details: { snapshot: name },
  };
}
