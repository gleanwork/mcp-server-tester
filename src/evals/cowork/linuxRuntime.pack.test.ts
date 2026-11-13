import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { stageInstalledPackage } from '../runners/installedPackage.js';

const exec = promisify(execFile);

it('ships every Linux desktop runtime as Node, with no Python', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mst-linux-runtime-pack-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  try {
    await stageInstalledPackage(root, directory);
    // Supply installed dependencies, not source files. This is the same package
    // boundary the image uses, without running installation hooks or the desktop.
    await symlink(
      join(root, 'node_modules'),
      join(directory, 'node_modules'),
      'dir'
    );
    const require = createRequire(join(directory, 'package.json'));
    for (const [entry, file] of [
      ['cowork-linux-runtime', 'dist/cowork/linuxThirdParty.js'],
      ['cowork-linux-first-party-runtime', 'dist/cowork/linuxFirstParty.js'],
      ['chatgpt-linux-runtime', 'dist/chatgpt/linuxDriver.js'],
    ] as const) {
      const helper = require.resolve(`@gleanwork/mcp-server-tester/${entry}`);
      expect(helper).toBe(await realpath(join(directory, file)));
      const { stdout } = await exec(process.execPath, [helper, '--help'], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      expect(stdout).toContain('--mode');
      expect(stdout).toContain('--max-actions');
    }
    // The Cowork image's readiness check runs from the installed package.
    expect(existsSync(join(directory, 'dist/cowork/desktopReady.js'))).toBe(
      true
    );
    const shipped = await readdir(directory, { recursive: true });
    expect(
      shipped.filter(
        (file) => !file.startsWith('node_modules') && /\.py$/.test(file)
      )
    ).toEqual([]);
    expect(existsSync(join(directory, 'scripts'))).toBe(false);
    const helper =
      require.resolve('@gleanwork/mcp-server-tester/cowork-linux-first-party-runtime');
    await expect(
      exec(
        process.execPath,
        [helper, '--mode', 'probe', '--timeout-ms', '1000'],
        {
          timeout: 10_000,
          env: { PATH: process.env.PATH },
        }
      )
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('account_runtime_required'),
    });
    // Native approvals keep the established wire key, even though the internal
    // workflow has a narrower payload. Invalid D-Bus prevents all UI interaction.
    for (const approveWriteTools of [false, true]) {
      const result = new Promise<string>((resolve) => {
        const child = execFile(
          process.execPath,
          [helper, '--mode', 'hitl', '--timeout-ms', '1000'],
          {
            timeout: 10_000,
            env: {
              PATH: process.env.PATH,
              MST_COWORK_ACCOUNT_OWNER: 'fixture',
              MST_COWORK_ACCOUNT_PROFILE: '/fixture/profile',
              MST_COWORK_ACCOUNT_MARKER: '/fixture/owner',
              DBUS_SESSION_BUS_ADDRESS: 'tcp:host=example.invalid',
            },
          },
          (_error, stdout) => resolve(String(stdout))
        );
        child.stdin?.end(JSON.stringify({ approveWriteTools }));
      });
      expect(JSON.parse(await result)).toMatchObject({
        status: 'failed',
        action_count: 0,
        error: 'invalid_dbus_address',
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
