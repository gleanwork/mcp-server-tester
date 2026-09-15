import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../src/mcp/clientFactory.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from './fixture.js';
import { createDesktopMcpbBundles } from './mcpb.js';

const fixtures: DesktopEvalFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('shared desktop MCPB packaging', () => {
  it.skipIf(process.platform !== 'darwin')(
    'runs the exact packaged server bytes for primary and decoy fixtures',
    async () => {
      const fixture = await createDesktopEvalFixture();
      fixtures.push(fixture);
      const bundleDir = join(fixture.privateDir, 'bundles');
      const bundles = await createDesktopMcpbBundles(fixture, bundleDir);
      expect(bundles.map((bundle) => bundle.serverLabel)).toEqual([
        'desktop_records',
        'desktop_decoy',
      ]);

      for (const bundle of bundles) {
        expect((await stat(bundle.path)).mode & 0o777).toBe(0o600);
        const entries = (
          await promisify(execFile)('/usr/bin/unzip', ['-Z1', bundle.path], {
            env: {},
            timeout: 10_000,
          })
        ).stdout
          .trim()
          .split('\n')
          .sort();
        expect(entries).toEqual([
          'manifest.json',
          'package.json',
          'server/index.mjs',
          'server/runtime.json',
        ]);

        const extracted = join(
          fixture.privateDir,
          `extracted-${bundle.serverLabel}`
        );
        await mkdir(extracted, { mode: 0o700 });
        await promisify(execFile)(
          '/usr/bin/unzip',
          ['-q', bundle.path, '-d', extracted],
          { env: {}, timeout: 10_000 }
        );
        const manifest = await readFile(
          join(extracted, 'manifest.json'),
          'utf8'
        );
        expect(manifest).not.toContain(fixture.oracle.direct.verificationCode);
        const client = await createMCPClientForConfig({
          transport: 'stdio',
          label: bundle.serverLabel,
          command: process.execPath,
          args: [
            join(extracted, 'server/index.mjs'),
            join(extracted, 'server/runtime.json'),
          ],
          cwd: extracted,
        });
        try {
          const result = await client.callTool({
            name: 'lookup_record',
            arguments: {
              namespace: 'releases',
              reference: fixture.oracle.direct.reference,
            },
          });
          expect(result).toMatchObject({
            isError: false,
            structuredContent: {
              serverLabel: bundle.serverLabel,
              record: { reference: fixture.oracle.direct.reference },
            },
          });
        } finally {
          await closeMCPClient(client);
        }
      }

      const ledger = await fixture.readLedger();
      const requests = ledger.filter(
        (entry) =>
          entry.direction === 'request' &&
          'method' in entry.message &&
          entry.message.method === 'tools/call'
      );
      expect(requests.map((entry) => entry.serverLabel)).toEqual([
        'desktop_records',
        'desktop_decoy',
      ]);
    }
  );
});
