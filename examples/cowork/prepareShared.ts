import { join } from 'node:path';
import { createDesktopEvalFixture } from '../../tests/fixtures/desktop-evals/fixture.js';
import { createDesktopMcpbBundles } from '../../tests/fixtures/desktop-evals/mcpb.js';
import { writePrivateJson } from './files.js';

/** Prepare one retained private fixture shared by the CoWork and Codex runners. */
export async function prepareSharedDesktopEval(root: string): Promise<void> {
  const fixture = await createDesktopEvalFixture({ rootDir: root });
  let keep = false;
  try {
    const bundleDir = join(fixture.privateDir, 'bundles');
    const bundles = await createDesktopMcpbBundles(fixture, bundleDir);
    await writePrivateJson(join(root, 'cowork-run.json'), {
      attemptId: 'REPLACE_ME',
      runtimePath: '/REPLACE_ME/cua-driver',
      executablePath: '/Applications/Claude.app/Contents/MacOS/Claude',
      profilePath: join(root, 'claude-profile'),
      dataDir: '/REPLACE_ME/isolated-profile/account-session-directory',
      fixtureRoot: root,
      outputDir: join(root, 'cowork-results'),
      servers: [
        {
          transport: 'stdio',
          label: 'desktop_records',
          command: 'node',
          args: [
            '/REPLACE_ME/desktop_records/server/index.mjs',
            '/REPLACE_ME/desktop_records/server/runtime.json',
          ],
        },
        {
          transport: 'stdio',
          label: 'desktop_decoy',
          command: 'node',
          args: [
            '/REPLACE_ME/desktop_decoy/server/index.mjs',
            '/REPLACE_ME/desktop_decoy/server/runtime.json',
          ],
        },
      ],
      mcpServerPrefixes: {
        mcp__REPLACE_ME_RECORDS__: 'desktop_records',
        mcp__REPLACE_ME_DECOY__: 'desktop_decoy',
      },
    });
    await writePrivateJson(join(root, 'fixture-summary.json'), {
      version: 1,
      runId: fixture.oracle.runId,
      bundles: bundles.map(({ serverLabel, displayName, path }) => ({
        serverLabel,
        displayName,
        path,
      })),
      cases: ['direct-lookup', 'dependent-lookup', 'missing-recovery'],
    });
    keep = true;
  } finally {
    if (!keep) await fixture.dispose();
  }
}
