/**
 * Matchers Module
 *
 * Custom Playwright matchers for MCP tool response validation.
 * These matchers use the validators internally and provide a clean
 * assertion API for Playwright tests.
 */

import { expect as baseExpect } from '@playwright/test';

// Import matcher functions
import { toMatchToolResponse } from './toMatchToolResponse.js';
import { toMatchToolSchema } from './toMatchToolSchema.js';
import { toContainToolText } from './toContainToolText.js';
import { toMatchToolPattern } from './toMatchToolPattern.js';
import { toMatchToolSnapshot } from './toMatchToolSnapshot.js';
import { toBeToolError } from './toBeToolError.js';
import { toPassToolJudge } from './toPassToolJudge.js';
import { toHaveToolResponseSize } from './toHaveToolResponseSize.js';
import { toSatisfyToolPredicate } from './toSatisfyToolPredicate.js';
import { toHaveToolCalls } from './toHaveToolCalls.js';
import { toHaveToolCallCount } from './toHaveToolCallCount.js';

// Import types for global declaration
import './types.js';

/**
 * Extended Playwright expect with MCP tool matchers
 *
 * @example
 * ```typescript
 * import { expect } from '@gleanwork/mcp-server-tester';
 *
 * test('weather tool', async ({ mcp }) => {
 *   const result = await mcp.callTool('get_weather', { city: 'London' });
 *
 *   expect(result).toContainToolText('temperature');
 *   expect(result).toMatchToolSchema(WeatherSchema);
 *   expect(result).not.toBeToolError();
 * });
 * ```
 */
export const expect = baseExpect.extend({
  toMatchToolResponse,
  toMatchToolSchema,
  toContainToolText,
  toMatchToolPattern,
  toMatchToolSnapshot,
  toBeToolError,
  toPassToolJudge,
  toHaveToolResponseSize,
  toSatisfyToolPredicate,
  toHaveToolCalls,
  toHaveToolCallCount,
});
