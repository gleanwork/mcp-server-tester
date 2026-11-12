import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type * as NodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dockerRunner } from './docker.js';
import { stageInstalledPackage } from './installedPackage.js';

const fixture = vi.hoisted(() => ({ root: '' }));
const exec = promisify(execFile);

// Resolve the image from the package under test, not this checkout. Keep
// setupDocker's filesystem checks and npm pack invocation real.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const require = actual.createRequire(...args);
      const resolve = require.resolve;
      require.resolve = Object.assign(
        (id: string, options?: { paths?: string[] }) =>
          id === '@gleanwork/mcp-server-tester/cowork-linux-image'
            ? path.join(fixture.root, 'docker', 'cowork-linux', 'Dockerfile')
            : resolve(id, options),
        { paths: resolve.paths }
      );
      return require;
    },
  };
});

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

type PackageKind =
  | 'installed'
  | 'installed-source'
  | 'checkout'
  | 'worktree'
  | 'archive-missing-dist'
  | 'archive-stale-dist';

async function packageFixture(kind: PackageKind) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-pack-'));
  dirs.push(dir);
  const installed = kind.startsWith('installed');
  fixture.root = installed
    ? path.join(
        dir,
        'node_modules/.pnpm/mst-git/node_modules/@gleanwork/mcp-server-tester'
      )
    : path.join(dir, kind);
  const root = fixture.root;
  for (const folder of [
    'dist',
    'assets',
    'docker/cowork-linux',
    'node_modules/secret',
  ])
    await fs.mkdir(path.join(root, folder), { recursive: true });
  if (kind !== 'installed') {
    await fs.mkdir(path.join(root, 'src', 'cli'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'cli', 'index.ts'), '');
  }
  if (kind !== 'archive-missing-dist')
    await fs.writeFile(path.join(root, 'dist', 'index.js'), '// prebuilt\n');
  await fs.writeFile(
    path.join(root, 'docker', 'cowork-linux', 'Dockerfile'),
    'FROM scratch\n'
  );
  if (kind === 'checkout') await fs.mkdir(path.join(root, '.git'));
  if (kind === 'worktree')
    await fs.writeFile(
      path.join(root, '.git'),
      'gitdir: /repo/.git/worktrees/mst\n'
    );
  await fs.writeFile(
    path.join(root, 'build.mjs'),
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, 'lifecycle.log'))}, process.argv[2] + '\\n');
${installed ? "throw new Error('Installed pack lifecycle must never run');" : "fs.writeFileSync('dist/index.js', '// rebuilt\\n');"}
`
  );
  const manifest = {
    name: '@gleanwork/mcp-server-tester',
    version: '0.0.0-test',
    files: ['dist', 'docker', 'assets/*.json'],
    main: 'entry.js',
    bin: { mst: 'cli.js' },
    exports: { '.': './dist/index.js' },
    dependencies: { example: '^1.0.0' },
    scripts: {
      prepack: 'node build.mjs prepack',
      prepare: 'node build.mjs prepare',
      postpack: 'node build.mjs postpack',
      build: 'node build.mjs build',
      postinstall: 'node build.mjs postinstall',
    },
  };
  const originalManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(root, 'package.json'), originalManifest);
  for (const file of [
    'README.md',
    'LICENSE',
    'entry.js',
    'cli.js',
    'assets/data.json',
  ])
    await fs.writeFile(path.join(root, file), file);
  await fs.chmod(path.join(root, 'cli.js'), 0o755);
  for (const file of [
    '.npmrc',
    '.env',
    'unlisted-secret.txt',
    'node_modules/secret/token',
    'dist/.npmrc',
    'dist/.env',
    'dist/.env.local',
    'dist/private.txt',
    'assets/unlisted.txt',
  ])
    await fs.writeFile(path.join(root, file), 'must not ship');
  await fs.writeFile(path.join(root, 'dist/.npmignore'), 'private.txt\n');
  await fs.symlink(
    path.join(root, 'unlisted-secret.txt'),
    path.join(root, 'dist/link')
  );
  vi.stubEnv('MST_NPM', 'npm');
  vi.stubEnv('npm_config_cache', path.join(dir, 'npm-cache'));
  vi.stubEnv(
    'MST_DOCKER',
    fileURLToPath(
      new URL('../../../tests/mocks/fakeDocker.mjs', import.meta.url)
    )
  );
  vi.stubEnv('FAKE_DOCKER_ROOT', dir);
  vi.stubEnv('FAKE_DOCKER_BUILD_CAPTURE', path.join(dir, 'capture'));
  return { dir, root, installed, manifest, originalManifest };
}

async function assertRemoved(directories: Promise<string>[]) {
  for (const directory of await Promise.all(directories))
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('packing MST for Docker setup', () => {
  it('copies only publishable files into staging, preserving executable permissions', async () => {
    const { dir, root, originalManifest } = await packageFixture('installed');
    const staged = path.join(dir, 'staged');
    await stageInstalledPackage(root, staged);
    const files = await fs.readdir(staged, { recursive: true });
    expect(files).toContain(path.join('assets', 'data.json'));
    expect(files.join('\n')).not.toMatch(
      /node_modules|secret|private|unlisted|build\.mjs|\.env|\.npmrc|link/
    );
    expect((await fs.stat(path.join(staged, 'cli.js'))).mode & 0o777).toBe(
      0o755
    );
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(
      originalManifest
    );
  });

  it.each([
    'installed',
    'installed-source',
    'checkout',
    'worktree',
    'archive-missing-dist',
    'archive-stale-dist',
  ] as const)(
    'packs the %s package with the correct lifecycle policy',
    async (kind) => {
      const { dir, root, installed, manifest, originalManifest } =
        await packageFixture(kind);
      const temporary = vi.spyOn(fs, 'mkdtemp');
      await dockerRunner.setup!({}, { log: () => {} });

      const lifecycle = await fs
        .readFile(path.join(root, 'lifecycle.log'), 'utf8')
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
      expect(lifecycle).toBe(installed ? '' : 'prepack\nprepare\npostpack\n');
      expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(
        originalManifest
      );
      expect(await fs.readFile(path.join(root, 'dist/index.js'), 'utf8')).toBe(
        installed ? '// prebuilt\n' : '// rebuilt\n'
      );
      expect(
        await fs.readFile(path.join(dir, 'builds.jsonl'), 'utf8')
      ).toContain('mst-cowork-linux:');

      const tarball = path.join(
        dir,
        'capture/mst-package/gleanwork-mcp-server-tester-0.0.0-test.tgz'
      );
      const { stdout: archiveManifest } = await exec('tar', [
        '-xOf',
        tarball,
        'package/package.json',
      ]);
      expect(JSON.parse(archiveManifest)).toEqual({
        ...manifest,
        scripts: installed
          ? {
              build: manifest.scripts.build,
              postinstall: manifest.scripts.postinstall,
            }
          : manifest.scripts,
      });
      const { stdout: built } = await exec('tar', [
        '-xOf',
        tarball,
        'package/dist/index.js',
      ]);
      expect(built).toBe(installed ? '// prebuilt\n' : '// rebuilt\n');
      const { stdout: contents } = await exec('tar', ['-tf', tarball]);
      const files = contents.trim().split('\n');
      for (const file of [
        'README.md',
        'LICENSE',
        'entry.js',
        'cli.js',
        'assets/data.json',
        'dist/index.js',
        'docker/cowork-linux/Dockerfile',
      ])
        expect(files).toContain(`package/${file}`);
      expect(contents).not.toMatch(
        /node_modules|secret|private|unlisted|dist\/link|\.npmrc/
      );
      if (installed) expect(contents).not.toContain('.env');
      expect(await fs.readdir(path.join(dir, 'capture'))).not.toContain(
        'mst-repack'
      );
      await assertRemoved(
        temporary.mock.results.map((result) => result.value as Promise<string>)
      );
    },
    30_000
  );

  it('packs MST when an npm dry run started it', async () => {
    // `npm publish --dry-run` passes the flag to the scripts it runs.
    const { dir } = await packageFixture('checkout');
    vi.stubEnv('npm_config_dry_run', 'true');
    await dockerRunner.setup!({}, { log: () => {} });
    await expect(
      fs.stat(
        path.join(
          dir,
          'capture/mst-package/gleanwork-mcp-server-tester-0.0.0-test.tgz'
        )
      )
    ).resolves.toBeTruthy();
  }, 30_000);

  it.each(['pack', 'build'] as const)(
    'cleans staging and preserves the installed manifest after %s failure',
    async (failure) => {
      const { root, originalManifest } = await packageFixture('installed');
      const temporary = vi.spyOn(fs, 'mkdtemp');
      if (failure === 'pack')
        vi.stubEnv('MST_NPM', path.join(root, 'missing-npm'));
      else vi.stubEnv('FAKE_DOCKER_BUILD_ERROR', 'intentional build failure');
      await expect(dockerRunner.setup!({}, { log: () => {} })).rejects.toThrow(
        failure === 'pack' ? 'npm pack failed' : 'intentional build failure'
      );
      expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(
        originalManifest
      );
      await expect(
        fs.stat(path.join(root, 'lifecycle.log'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await assertRemoved(
        temporary.mock.results.map((result) => result.value as Promise<string>)
      );
    }
  );
});
