/**
 * Matcher behaviour that only a real Playwright test shows: failure
 * formatting such as the custom message passed to expect().
 */
import { test, expect } from '../src/fixtures/mcp.js';

test('a throwing predicate fails with Playwright formatting, with or without .not', async ({
  mcp,
}) => {
  const result = await mcp.callTool('echo', { message: 'hi' });
  function crash(): boolean {
    throw new Error('boom');
  }
  for (const negated of [false, true]) {
    let message = '';
    try {
      const assertion = expect(result, 'echo check');
      await (negated
        ? assertion.not.toSatisfyToolPredicate(crash)
        : assertion.toSatisfyToolPredicate(crash));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('echo check');
    expect(message).toContain('Predicate threw error: boom');
  }
});
