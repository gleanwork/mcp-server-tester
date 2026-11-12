import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
let root: string;
let source: string;
let consumer: string;
let env: NodeJS.ProcessEnv;

// Exercise Node's real self-reference/link resolution and npm's actual Git
// installation boundary. Only Docker is replaced: it captures the build context.
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-pack-boundary-'));
  source = path.join(root, 'source');
  consumer = path.join(root, 'consumer');
  env = {
    ...process.env,
    npm_config_cache: path.join(root, 'cache'),
    MST_NPM: 'npm',
    MST_DOCKER: path.join(repo, 'tests/mocks/fakeDocker.mjs'),
    FAKE_DOCKER_ROOT: root,
  };
  // `npm publish --dry-run` runs these tests with npm_config_dry_run set; the
  // fixture's own npm pack and install must still write their output.
  for (const key of Object.keys(env))
    if (/^npm_config_dry[-_]run$/i.test(key)) delete env[key];
  // External runtime dependencies resolve from the fixture's parent. Its own
  // build-only dependency is deliberately absent there and in the consumer.
  await fs.symlink(
    path.join(repo, 'node_modules'),
    path.join(root, 'node_modules')
  );
  const builder = path.join(root, 'builder');
  await fs.mkdir(builder);
  await fs.writeFile(
    path.join(builder, 'package.json'),
    JSON.stringify({
      name: 'pack-fixture-builder',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    })
  );
  await fs.writeFile(
    path.join(builder, 'index.js'),
    `import fs from 'node:fs';
fs.appendFileSync('lifecycle.log', 'prepare\\n');
fs.mkdirSync('dist/cli', {recursive: true});
fs.writeFileSync('dist/cli/index.js', '#!/usr/bin/env node\\nconsole.log("fresh-build");\\n');
`
  );
  await exec('npm', ['pack', '--silent', '--pack-destination', root], {
    cwd: builder,
    env,
  });
  await fs.mkdir(path.join(source, 'src/cli'), { recursive: true });
  await fs.mkdir(path.join(source, 'docker/cowork-linux'), { recursive: true });
  await fs.mkdir(consumer);
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    '{"private":true,"type":"module"}'
  );
  await fs.writeFile(
    path.join(source, 'src/cli/index.ts'),
    '// source entry\n'
  );
  await fs.writeFile(
    path.join(source, 'docker/cowork-linux/Dockerfile'),
    'FROM scratch\n'
  );
  await fs.writeFile(
    path.join(source, 'prepare.mjs'),
    "import 'pack-fixture-builder';\n"
  );
  await fs.writeFile(
    path.join(source, '.gitignore'),
    'node_modules\ndist\nlifecycle.log\n'
  );
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: '@gleanwork/mcp-server-tester',
      version: '0.0.0-boundary',
      type: 'module',
      exports: {
        './evals': './src/runner.mjs',
        './cowork-linux-image': './docker/cowork-linux/Dockerfile',
      },
      bin: { mst: 'dist/cli/index.js' },
      files: ['src', 'dist', 'docker', 'prepare.mjs'],
      scripts: { prepare: 'node prepare.mjs' },
      devDependencies: {
        'pack-fixture-builder': `file:${path.join(root, 'pack-fixture-builder-1.0.0.tgz')}`,
      },
    })
  );
  await build({
    entryPoints: [path.join(repo, 'src/evals/runners/docker.ts')],
    outfile: path.join(source, 'src/runner.mjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  await exec('npm', ['install', '--offline', '--no-audit', '--no-fund'], {
    cwd: source,
    env,
  });
  await exec('git', ['init', '--quiet'], { cwd: source, env });
  await exec('git', ['add', '.'], { cwd: source, env });
  await exec(
    'git',
    [
      '-c',
      'user.name=Acme',
      '-c',
      'user.email=acme@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: source, env }
  );
}, 30_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function setup(cwd: string, capture: string): Promise<string> {
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { dockerRunner } from '@gleanwork/mcp-server-tester/evals'; await dockerRunner.setup({}, {log() {}});",
    ],
    { cwd, env: { ...env, FAKE_DOCKER_BUILD_CAPTURE: capture } }
  );
  const { stdout } = await exec('tar', [
    '-xOf',
    path.join(
      capture,
      'mst-package/gleanwork-mcp-server-tester-0.0.0-boundary.tgz'
    ),
    'package/dist/cli/index.js',
  ]);
  return stdout;
}

it('repacks an actual installed Git dependency without its missing build dependency', async () => {
  await exec(
    'npm',
    [
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      `git+file://${source}`,
    ],
    { cwd: consumer, env }
  );
  const installed = path.join(
    consumer,
    'node_modules/@gleanwork/mcp-server-tester'
  );
  expect(
    await fs.readFile(path.join(installed, 'src/cli/index.ts'), 'utf8')
  ).toContain('source entry');
  await expect(
    exec(process.execPath, ['prepare.mjs'], { cwd: installed, env })
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Cannot find package 'pack-fixture-builder'"
    ),
  });
  const manifest = await fs.readFile(
    path.join(installed, 'package.json'),
    'utf8'
  );
  expect(await setup(consumer, path.join(root, 'installed-capture'))).toContain(
    'fresh-build'
  );
  expect(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).toBe(
    manifest
  );
}, 30_000);

it.each(['missing', 'stale'] as const)(
  'builds fresh output from a source archive with %s dist',
  async (state) => {
    const archive = path.join(root, `archive-${state}`);
    await fs.cp(source, archive, {
      recursive: true,
      filter: (file) => path.basename(file) !== '.git',
    });
    await fs.rm(path.join(archive, 'dist'), { recursive: true, force: true });
    if (state === 'stale') {
      await fs.mkdir(path.join(archive, 'dist/cli'), { recursive: true });
      await fs.writeFile(
        path.join(archive, 'dist/cli/index.js'),
        '// stale-build\n'
      );
    }
    expect(await setup(archive, path.join(root, `${state}-capture`))).toContain(
      'fresh-build'
    );
  },
  30_000
);

it.each(['checkout', 'worktree'] as const)(
  'builds a linked %s through Node package resolution',
  async (kind) => {
    const target = kind === 'checkout' ? source : path.join(root, 'worktree');
    if (kind === 'worktree') {
      await exec('git', ['worktree', 'add', '--detach', target], {
        cwd: source,
        env,
      });
      await fs.symlink(
        path.join(source, 'node_modules'),
        path.join(target, 'node_modules')
      );
    }
    await fs.rm(path.join(target, 'dist'), { recursive: true, force: true });
    const linked = path.join(root, `linked-${kind}`);
    await fs.mkdir(path.join(linked, 'node_modules/@gleanwork'), {
      recursive: true,
    });
    await fs.symlink(
      target,
      path.join(linked, 'node_modules/@gleanwork/mcp-server-tester')
    );
    expect(await setup(linked, path.join(root, `${kind}-capture`))).toContain(
      'fresh-build'
    );
  },
  30_000
);
