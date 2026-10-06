/**
 * Snapshots end to end: the toMatchToolSnapshot matcher and eval `snapshot`
 * expectations, through Playwright's real snapshot store. Snapshots live in
 * tests/__snapshots__ (see snapshotPathTemplate in playwright.config.ts).
 */
import fs from 'node:fs';
import { test, expect } from '../src/fixtures/mcp.js';
import { runEvalDataset } from '../src/evals/evalRunner.js';

/** True under --update-snapshots, when positive comparisons rewrite baselines. */
function updatingSnapshots(testInfo: { config: { updateSnapshots: string } }) {
  return ['all', 'changed'].includes(testInfo.config.updateSnapshots);
}

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

  test('.not fails on a missing snapshot and writes nothing', async ({
    mcp,
  }, testInfo) => {
    const result = await mcp.callTool('echo', { message: MESSAGE });
    let message = '';
    try {
      await expect(result).not.toMatchToolSnapshot('echo-never-saved');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("A snapshot doesn't exist");
    expect(fs.existsSync(testInfo.snapshotPath('echo-never-saved'))).toBe(
      false
    );
  });

  async function evalSnapshot(
    mcp: Parameters<typeof runEvalDataset>[1]['mcp'],
    testInfo: Parameters<typeof runEvalDataset>[1]['testInfo'],
    snapshot: string
  ) {
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'snapshots',
          cases: [
            {
              id: snapshot,
              toolName: 'echo',
              args: { message: MESSAGE },
              assertions: { snapshot, snapshotSanitizers: ['uuid'] },
            },
          ],
        },
      },
      { mcp, testInfo, expect }
    );
    return result.caseResults[0]?.expectations.snapshot;
  }

  test('eval snapshot expectations use the same store', async ({
    mcp,
  }, testInfo) => {
    expect(await evalSnapshot(mcp, testInfo, 'echo-order')).toEqual({
      pass: true,
      details: 'Matches snapshot "echo-order"',
    });
  });

  test('eval snapshot expectations report a mismatch', async ({
    mcp,
  }, testInfo) => {
    // A positive comparison against a deliberately different baseline would
    // overwrite it under --update-snapshots.
    test.skip(updatingSnapshots(testInfo), 'rewrites the echo-other baseline');
    const snapshot = await evalSnapshot(mcp, testInfo, 'echo-other');
    expect(snapshot?.pass).toBe(false);
    expect(snapshot?.details).toContain('echo-other');
  });
});
