import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEvalSuite } from './runEvalSuite.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A suite directory with one file dataset and the given manifest. */
async function suiteDir(manifest: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-configs-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'one', mode: 'mcp_host', scenario: 'Say hello' }],
    })
  );
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('manifest identity', () => {
  it('is unchanged for a manifest without extends', async () => {
    const dir = await suiteDir({
      name: 'identity',
      datasets: ['./cases.json'],
      judges: [{ type: 'rubric', rubric: 'correctness' }],
      iterations: 2,
    });
    const { summary } = await runEvalSuite({
      manifestPath: path.join(dir, 'manifest.json'),
      rootDir: dir,
      dryRun: true,
    });
    expect({
      manifestId: summary.manifestId,
      contentHash: summary.contentHash,
    }).toEqual({
      manifestId: 'identity',
      contentHash:
        '03bb021897ce1dae78884adcf0a155256cda50ac6a9e1fb46f5e80a3b4e71cf1',
    });
  });
});
