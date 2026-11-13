import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };

/** The Cowork image's own scripts, run as the image runs them, on scratch paths. */
const BIN = fileURLToPath(
  new URL('../../../docker/cowork-linux/bin/', import.meta.url)
);
const NODE_DIR = path.dirname(process.execPath);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-cowork-image-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function sh(script: string, env: NodeJS.ProcessEnv, cwd = root): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      'sh',
      [script],
      { cwd, env, timeout: 20_000 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? Number(error.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        })
    );
  });
}

describe('install-settings', () => {
  let staging: string;
  let target: string;
  let script: string;
  let installLog: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const source = await fs.readFile(
      path.join(BIN, 'install-settings'),
      'utf8'
    );
    const run = path.join(root, 'run/mst/settings');
    const etc = path.join(root, 'etc/claude-desktop');
    await fs.mkdir(run, { recursive: true });
    await fs.mkdir(etc, { recursive: true });
    // The script's only absolute paths, moved under the scratch root.
    const paths = source
      .split('\n')
      .filter((line) => !line.startsWith('#') && /\/(run|etc)\//.test(line));
    expect(paths).toEqual([
      'staging=/run/mst/settings/managed-settings.json',
      'target=/etc/claude-desktop/managed-settings.json',
    ]);
    const rewritten = source
      .replace('staging=/run/mst/settings/', `staging=${run}/`)
      .replace('target=/etc/claude-desktop/', `target=${etc}/`);
    script = path.join(root, 'install-settings');
    await fs.writeFile(script, rewritten);
    staging = path.join(run, 'managed-settings.json');
    target = path.join(etc, 'managed-settings.json');

    // Stand-ins for the two commands that differ off the image: `install -o
    // root` needs root, and macOS's stat has no -c. Each records its call.
    const stubs = path.join(root, 'stubs');
    await fs.mkdir(stubs);
    installLog = path.join(root, 'install.log');
    await fs.writeFile(
      path.join(stubs, 'install'),
      `#!/bin/sh\necho "$@" >> '${installLog}'\ncp "$7" "$8" && chmod "$6" "$8"\n`,
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(stubs, 'stat'),
      '#!/bin/sh\n[ "$1 $2" = "-c %s" ] || exit 64\nwc -c < "$3" | tr -d " "\n',
      { mode: 0o755 }
    );
    env = {
      PATH: `${stubs}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin:/bin`,
    };
  });

  it('installs valid settings as a root-owned copy, replacing the old one', async () => {
    await fs.writeFile(target, '{"old":true}');
    await fs.writeFile(staging, '{"inferenceProvider":"gateway"}');
    const result = await sh(script, env);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(await fs.readFile(target, 'utf8')).toBe(
      '{"inferenceProvider":"gateway"}'
    );
    expect(await fs.readFile(installLog, 'utf8')).toBe(
      `-o root -g root -m 0644 ${staging} ${target}.new\n`
    );
    await expect(fs.stat(`${target}.new`)).rejects.toThrow();
  });

  it('rejects settings that are not JSON without quoting them, and keeps the old ones', async () => {
    await fs.writeFile(target, '{"old":true}');
    await fs.writeFile(staging, '{"token": "sk-acme-secret"');
    const result = await sh(script, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("staged settings aren't JSON\n");
    expect(await fs.readFile(target, 'utf8')).toBe('{"old":true}');
    await expect(fs.stat(installLog)).rejects.toThrow();
  });

  it('refuses missing, linked and oversized staged settings', async () => {
    expect(await sh(script, env)).toMatchObject({
      code: 1,
      stderr: 'no staged settings\n',
    });

    const elsewhere = path.join(root, 'elsewhere.json');
    await fs.writeFile(elsewhere, '{}');
    await fs.symlink(elsewhere, staging);
    expect(await sh(script, env)).toMatchObject({
      code: 1,
      stderr: 'no staged settings\n',
    });
    await fs.rm(staging);

    await fs.writeFile(staging, `{"pad":"${'x'.repeat(1024 * 1024)}"}`);
    expect(await sh(script, env)).toMatchObject({
      code: 1,
      stderr: 'staged settings too large\n',
    });
    await expect(fs.stat(target)).rejects.toThrow();
  });
});

describe('desktop-ready', () => {
  it('runs the readiness check from the MST package that `mst` links to, and passes on its exit', async () => {
    // As `npm install -g` lays MST out: bin/mst links into lib/node_modules.
    const prefix = path.join(root, 'prefix');
    const pkg = path.join(prefix, 'lib/node_modules', packageJson.name);
    const cliEntry = path.join(pkg, packageJson.bin.mst);
    // The package's real file; linuxRuntime.pack.test.ts checks it ships.
    const check = path.join(pkg, 'dist/cowork/desktopReady.js');
    await fs.mkdir(path.dirname(cliEntry), { recursive: true });
    await fs.mkdir(path.dirname(check), { recursive: true });
    // npm marks the bin target executable; `command -v` finds only those.
    await fs.writeFile(cliEntry, '', { mode: 0o755 });
    await fs.writeFile(
      check,
      'console.log(`ran ${process.argv[1]} warm=${process.env.MST_COWORK_WARM_VM}`);\nprocess.exitCode = 3;\n'
    );
    await fs.mkdir(path.join(prefix, 'bin'));
    await fs.symlink(
      path.relative(path.join(prefix, 'bin'), cliEntry),
      path.join(prefix, 'bin/mst')
    );
    // Run from elsewhere, as restart-desktop does: nothing resolves from the cwd.
    const elsewhere = path.join(root, 'cwd');
    await fs.mkdir(elsewhere);
    const result = await sh(
      path.join(BIN, 'desktop-ready'),
      {
        PATH: `${path.join(prefix, 'bin')}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin:/bin`,
        MST_COWORK_WARM_VM: '0',
      },
      elsewhere
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toBe(`ran ${await fs.realpath(check)} warm=0\n`);
  });

  it('says so when mst is not on PATH, instead of guessing a path', async () => {
    // Only node: Node's own bin directory can hold a global mst.
    const nodeOnly = path.join(root, 'node-only');
    await fs.mkdir(nodeOnly);
    await fs.symlink(process.execPath, path.join(nodeOnly, 'node'));
    const result = await sh(path.join(BIN, 'desktop-ready'), {
      PATH: `${nodeOnly}${path.delimiter}/usr/bin:/bin`,
    });
    expect(result).toMatchObject({
      code: 1,
      stdout: '',
      stderr: "desktop-ready: mst isn't on PATH\n",
    });
  });
});
