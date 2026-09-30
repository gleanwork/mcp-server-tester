/**
 * Snapshots end to end: the toMatchToolSnapshot matcher and eval `snapshot`
 * expectations, through Playwright's real snapshot store. Snapshots live in
 * tests/__snapshots__ (see snapshotPathTemplate in playwright.config.ts).
 */
import { test, expect } from '../src/fixtures/mcp.js';
import { runEvalDataset } from '../src/evals/evalRunner.js';

const MESSAGE = 'order 123e4567-e89b-12d3-a456-426614174000 shipped';

test.describe('snapshots', () => {
  test('matcher compares sanitized text with the saved snapshot', async ({
    mcp,
  }) => {
    const result = await mcp.callTool('echo', { message: MESSAGE });
    await expect(result).toMatchToolSnapshot('echo-order', ['uuid']);
  });

  test('.not passes when the response differs from the snapshot', async ({
    mcp,
  }) => {
    const result = await mcp.callTool('echo', { message: MESSAGE });
    await expect(result).not.toMatchToolSnapshot('echo-other', ['uuid']);
  });

  test('.not fails when the response matches the snapshot', async ({ mcp }) => {
    const result = await mcp.callTool('echo', { message: MESSAGE });
    let message = '';
    try {
      await expect(result).not.toMatchToolSnapshot('echo-order', ['uuid']);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      'Expected response NOT to match snapshot "echo-order"'
    );
  });

  test('eval snapshot expectations use the same store', async ({
    mcp,
  }, testInfo) => {
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'snapshots',
          cases: [
            {
              id: 'matches',
              toolName: 'echo',
              args: { message: MESSAGE },
              expect: {
                snapshot: 'echo-order',
                snapshotSanitizers: ['uuid'],
              },
            },
            {
              id: 'differs',
              toolName: 'echo',
              args: { message: MESSAGE },
              expect: {
                snapshot: 'echo-other',
                snapshotSanitizers: ['uuid'],
              },
            },
          ],
        },
      },
      { mcp, testInfo, expect }
    );
    const [matches, differs] = result.caseResults;
    expect(matches?.expectations.snapshot).toEqual({
      pass: true,
      details: 'Matches snapshot "echo-order"',
    });
    expect(differs?.expectations.snapshot?.pass).toBe(false);
    expect(differs?.expectations.snapshot?.details).toContain('echo-other');
  });
});
