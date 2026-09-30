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
            `invalid regex pattern "${sanitizer.pattern}" in snapshot sanitizer`
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

export interface SnapshotMatchOptions {
  /**
   * Compare for a negated assertion (`.not`). The result is still the
   * positive one (does the content match?), but the store must not write
   * snapshots, and a missing snapshot counts as a match so the negated
   * assertion fails.
   */
  negated?: boolean;
}

/** Where named snapshots live. */
export interface SnapshotStore {
  /**
   * Whether content matches the named snapshot. For a positive comparison
   * the store decides what a missing snapshot means (Playwright writes it
   * under its update policy).
   */
  match(
    name: string,
    content: string,
    options?: SnapshotMatchOptions
  ): Promise<{ pass: boolean; message: string }>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The current Playwright test's snapshot store, via `toMatchSnapshot`.
 * Honours `--update-snapshots`, `ignoreSnapshots` and the project's
 * `snapshotPathTemplate`. Negated comparisons use Playwright's own
 * `.not.toMatchSnapshot`, which never writes.
 */
export function playwrightSnapshotStore(expect: Expect): SnapshotStore {
  return {
    async match(name, content, options = {}) {
      if (options.negated) {
        try {
          // eslint-disable-next-line @typescript-eslint/await-thenable
          await expect(content).not.toMatchSnapshot(name);
          return {
            pass: false,
            message: `Response does not match snapshot "${name}"`,
          };
        } catch (error) {
          // Playwright explains why: it matched, or the snapshot is missing.
          return {
            pass: true,
            message: errorMessage(error, `Response matches snapshot "${name}"`),
          };
        }
      }
      try {
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(content).toMatchSnapshot(name);
        return { pass: true, message: `Response matches snapshot "${name}"` };
      } catch (error) {
        return {
          pass: false,
          message: errorMessage(
            error,
            `Response does not match snapshot "${name}"`
          ),
        };
      }
    },
  };
}

export interface SnapshotValidatorOptions extends SnapshotMatchOptions {
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
  const result = await options.store.match(name, content, {
    negated: options.negated,
  });
  return {
    pass: result.pass,
    message: result.message,
    details: { snapshot: name },
  };
}
