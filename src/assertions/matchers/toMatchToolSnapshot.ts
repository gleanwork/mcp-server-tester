/**
 * toMatchToolSnapshot Matcher
 *
 * Validates that a response matches a saved snapshot, using Playwright's
 * snapshot store for the current test.
 */

import { expect as baseExpect } from '@playwright/test';
import type { SnapshotSanitizer } from '../validators/types.js';
import {
  playwrightSnapshotStore,
  validateSnapshot,
} from '../validators/snapshot.js';

/**
 * Creates the toMatchToolSnapshot matcher function
 *
 * @remarks
 * **Requires Playwright test context.** The comparison runs
 * `expect(content).toMatchSnapshot()`, which only works inside a Playwright
 * test (when `testInfo` is available). To compare outside Playwright, call
 * `validateSnapshot` with your own `SnapshotStore`.
 *
 * Note: This is an async matcher that uses Playwright's snapshot testing.
 */
export async function toMatchToolSnapshot(
  this: { isNot: boolean },
  received: unknown,
  name: string,
  sanitizers: SnapshotSanitizer[] = []
): Promise<{ pass: boolean; message: () => string }> {
  const result = await validateSnapshot(received, name, {
    sanitizers,
    store: playwrightSnapshotStore(baseExpect),
  });
  return {
    pass: result.pass,
    message: () =>
      this.isNot
        ? `Expected response NOT to match snapshot "${name}", but it did`
        : result.message,
  };
}
