import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  containerName,
  contextPool,
  coworkImageDirectory,
  DEFAULT_COWORK_IMAGE,
  dockerRunArgs,
} from './docker.js';
import { resolveEnvironment } from './builtinEnvironments.js';
import { runEval } from '../runEval.js';
import { readRunDirectory } from '../runFormat.js';
import { buildRunReport } from '../runReport.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { setupEnvironment } from '../../cli/commands/env/index.js';
import { resetPluginsForTests } from '../../plugins/extensions.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('the docker environment', () => {
  it('starts a container with the VM devices and the seccomp profile, and no credential', () => {
    const args = dockerRunArgs({
      name: 'mst-run-1',
      image: 'mst-cowork-linux:test',
      runId: 'run',
      seccompProfile: '/pkg/docker/cowork-linux/seccomp.json',
      inference: {
        baseURL: 'https://gateway.example/anthropic',
        authScheme: 'bearer',
      },
    });
    for (const device of [
      '/dev/kvm',
      '/dev/vhost-vsock',
      '/dev/vhost-net',
      '/dev/net/tun',
    ])
      expect(args[args.indexOf(device) - 1]).toBe('--device');
    expect(args).toContain('seccomp=/pkg/docker/cowork-linux/seccomp.json');
    expect(args).toContain(
      'MST_INFERENCE_GATEWAY_URL=https://gateway.example/anthropic'
    );
    expect(args).toContain('MST_INFERENCE_AUTH_SCHEME=bearer');
    expect(args).not.toContain('--privileged');
    expect(args.at(-1)).toBe('mst-cowork-linux:test');
  });

  it('names containers by run and shard, as Docker allows', () => {
    expect(containerName('20261011T020624Z-51a866', 0)).toBe(
      'mst-20261011T020624Z-51a866-1'
    );
    expect(containerName('a run/x', 2)).toBe('mst-a-run-x-3');
  });

  it('runs one container per context at a time', async () => {
    const pool = contextPool(['a', 'b']);
    const signal = new AbortController().signal;
    expect(await pool.acquire(signal)).toBe('a');
    expect(await pool.acquire(signal)).toBe('b');
    let third: string | undefined = 'waiting';
    const waiting = pool.acquire(signal).then((context) => (third = context));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(third).toBe('waiting');
    pool.release('b');
    await waiting;
    expect(third).toBe('b');
    // A cancelled run stops waiting.
    const controller = new AbortController();
    const cancelled = pool.acquire(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
  });

  it('checks its options', () => {
    expect(
      resolveEnvironment('docker', { contexts: 'a,b', shards: '2' })
    ).toMatchObject({
      name: 'docker',
      shards: 2,
      options: { contexts: 'a,b' },
    });
    expect(() => resolveEnvironment('docker', { contxts: 'a' })).toThrow();
    expect(() =>
      resolveEnvironment('docker', { readyTimeout: 'soon' })
    ).toThrow();
  });

  it('ships the image beside the package', async () => {
    const dir = coworkImageDirectory();
    for (const file of ['Dockerfile', 'seccomp.json', 'bin/restart-desktop'])
      await expect(fs.stat(path.join(dir, file))).resolves.toBeTruthy();
    const seccomp = JSON.parse(
      await fs.readFile(path.join(dir, 'seccomp.json'), 'utf8')
    ) as {
      syscalls: Array<{ names: string[]; args?: Array<{ value: number }> }>;
    };
    // Docker's default profile, plus AF_VSOCK (40) sockets.
    expect(
      seccomp.syscalls.some(
        (rule) => rule.names.includes('socket') && rule.args?.[0]?.value === 40
      )
    ).toBe(true);
    expect(DEFAULT_COWORK_IMAGE).toMatch(/^mst-cowork-linux:/);
  });
});

describe("the image's Cowork VM bundle manifest (bin/vm-bundle-manifest.mjs)", () => {
  const script = path.join(
    coworkImageDirectory(),
    'bin/vm-bundle-manifest.mjs'
  );
  const sha = '882518393ed4ce89020bd48d99d5daf114999773';
  // As Claude Desktop's app.asar holds it: minified JavaScript, unquoted keys.
  const app = `var a=1;const M={_note:"Written by the publish step, do not hand-edit.",versions:[{sha:"${sha}",publishedAt:"2026-09-11",files:{unix:{arm64:[{name:"rootfs.img",checksum:"c1",size:12,progressStart:0,deltas:[{from:"old",checksum:"d1"}]},{name:"vmlinuz",checksum:"c2",size:3}],x64:[{name:"rootfs.img",checksum:"c3",size:14}]}}},{sha:"${'0'.repeat(40)}",files:{unix:{arm64:[]}}}]};f(M);`;

  async function manifest(arch: string, content = app) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-asar-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'app.asar'), content, 'latin1');
    const { execFile } = await import('node:child_process');
    return new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) =>
        execFile(
          process.execPath,
          [script, path.join(dir, 'app.asar'), arch],
          (error, stdout, stderr) =>
            resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
        )
    );
  }

  it("reads the current bundle's files for an architecture", async () => {
    const result = await manifest('arm64');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sha,
      arch: 'arm64',
      files: [
        { name: 'rootfs.img', checksum: 'c1', size: 12 },
        { name: 'vmlinuz', checksum: 'c2', size: 3 },
      ],
    });
    expect(JSON.parse((await manifest('x64')).stdout).files).toEqual([
      { name: 'rootfs.img', checksum: 'c3', size: 14 },
    ]);
  });

  it('fails, so the build goes on without seeding, when it has nothing to seed', async () => {
    expect(await manifest('riscv64')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'no riscv64 files in the manifest (has: arm64, x64)'
      ),
    });
    expect(await manifest('arm64', 'var a=1;')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no Cowork VM manifest'),
    });
  });
});

describe('a run in docker (a fake Docker CLI)', () => {
  async function fixture(
    env: Record<string, string> = {},
    plugins: string[] = [mock('dockerTestPlugin.ts')]
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-docker-'));
    dirs.push(dir);
    const root = path.join(dir, 'docker');
    await fs.mkdir(root, { recursive: true });
    // The eval's own directory, apart from the containers: a worker resolving
    // a package can't find the eval's node_modules by walking up.
    const project = path.join(dir, 'project');
    await fs.mkdir(project, { recursive: true });
    vi.stubEnv('MST_DOCKER', mock('fakeDocker.mjs'));
    vi.stubEnv('FAKE_DOCKER_ROOT', root);
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('MST_LLM_AUTH_COMMAND', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await fs.writeFile(
      path.join(project, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: ['alpha', 'bravo', 'charlie'].map((id) => ({
          id,
          input: id,
          assertions: { containsText: 'answered' },
        })),
      })
    );
    const configPath = path.join(project, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'docker',
        plugins,
        client: 'dt/client/notes',
        datasets: ['./cases.json'],
        servers: {},
        redactStoredResponses: false,
      })
    );
    const calls = async () =>
      (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) => JSON.parse(line) as { context?: string; args: string[] }
        );
    return { dir, root, project, configPath, calls };
  }

  /** The test plugin as a package, `@acme/mst-dt`, installed in `dir`. */
  async function installPluginPackage(dir: string, version: string) {
    const packageDir = path.join(dir, 'node_modules', '@acme', 'mst-dt');
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@acme/mst-dt',
        version,
        type: 'module',
        exports: './index.mjs',
      })
    );
    await fs.writeFile(
      path.join(packageDir, 'index.mjs'),
      `export { default } from ${JSON.stringify(pathToFileURL(mock('dockerTestPlugin.ts')).href)};\n`
    );
    return packageDir;
  }

  it("builds the image with the eval's plugin packages, on every context", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root, project, configPath } = await fixture(
      { MST_NPM: mock('fakeNpm.mjs') },
      ['@acme/mst-dt']
    );
    await installPluginPackage(project, '1.2.3');
    await setupEnvironment('docker', {
      config: configPath,
      envOption: ['contexts=ctx-a,ctx-b', 'image=mst-test:1'],
      rootDir: project,
    });
    const builds = (await fs.readFile(path.join(root, 'builds.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(builds).toEqual([
      {
        context: 'ctx-a',
        tag: 'mst-test:1',
        plugins: ['acme-mst-dt-1.2.3.tgz'],
      },
      {
        context: 'ctx-b',
        tag: 'mst-test:1',
        plugins: ['acme-mst-dt-1.2.3.tgz'],
      },
    ]);
  }, 120_000);

  it('refuses to build with a plugin that is a file, not a package', async () => {
    const { project, configPath } = await fixture();
    await expect(
      setupEnvironment('docker', { config: configPath, rootDir: project })
    ).rejects.toThrow('is a file, not a package');
  });

  it('runs a worker only with the plugin version the run uses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const image = await fs.mkdtemp(
      path.join(os.tmpdir(), 'mst-image-plugins-')
    );
    dirs.push(image);
    const { dir, project, configPath } = await fixture(
      { FAKE_DOCKER_PLUGIN_DIR: image },
      ['@acme/mst-dt']
    );
    await installPluginPackage(project, '1.2.3');
    // The image was built with another version.
    const installed = await installPluginPackage(image, '1.2.4');
    const run = () =>
      runEval({
        configPath,
        rootDir: project,
        outputDir: path.join(dir, 'out'),
        env: 'docker',
        envOptions: { image: 'mst-test:1' },
        report: false,
      });
    expect((await run()).summary.metrics).toMatchObject({ passed: 0 });
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'This worker has plugin @acme/mst-dt@1.2.4; the run uses @acme/mst-dt@1.2.3.'
    );
    // Rebuilt with the run's version: the run passes.
    await fs.rm(installed, { recursive: true });
    await installPluginPackage(image, '1.2.3');
    expect((await run()).summary.metrics).toMatchObject({
      passed: 3,
      total: 3,
    });
  }, 120_000);

  it('collects every case over docker exec, brings artifacts back, and removes the containers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, root, configPath, calls } = await fixture();
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { shards: '2', contexts: 'ctx-a,ctx-b', image: 'mst-test:1' },
      report: false,
    });

    expect(result.summary.metrics).toMatchObject({ passed: 3, total: 3 });
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => /shard \d\/2: done/.test(line))).toHaveLength(
      2
    );
    // Each shard had its own context and container.
    const runs = (await calls()).filter((call) => call.args[0] === 'run');
    expect(runs.map((call) => call.context).sort()).toEqual(['ctx-a', 'ctx-b']);
    expect(runs.every((call) => call.args.at(-1) === 'mst-test:1')).toBe(true);
    // The API key went in over stdin, never on a command line.
    expect(JSON.stringify(await calls())).not.toContain('test-api-key');
    expect(
      runs.every((call) =>
        call.args.includes('MST_INFERENCE_AUTH_SCHEME=x-api-key')
      )
    ).toBe(true);
    // Every trial's artifacts are in the run, copied from the worker.
    for (const id of ['alpha', 'bravo', 'charlie'])
      expect(
        await fs.readFile(
          path.join(
            result.outputDir,
            'artifacts',
            'default',
            id,
            '0',
            'audit.jsonl'
          ),
          'utf8'
        )
      ).toBe(`${id}\n`);
    // Both containers are gone.
    expect(await fs.readdir(path.join(root, 'containers'))).toEqual([]);
    // run.json says what each shard's machine ran, and so does the report.
    const stored = await readRunDirectory(result.outputDir);
    const machines = [1, 2].map((shard) => ({
      shard,
      mst: packageJson.version,
      image: 'mst-test:1@sha256:fake-image',
      client: 'dt/client/notes',
      ok: true,
      collected: expect.any(Number),
    }));
    expect(stored.run.environment.machines).toEqual(machines);
    expect(buildRunReport(stored).run.environment).toEqual({
      name: 'docker',
      shards: 2,
      machines: machines.map(({ shard, mst, image }) => ({
        shard,
        mst,
        image,
      })),
    });
  }, 120_000);

  it("fails a shard whose desktop doesn't come up, with the image's reason", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, configPath, root } = await fixture({
      FAKE_DOCKER_DESKTOP: 'failed',
    });
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { image: 'mst-test:1' },
      report: false,
    });
    expect(result.summary.metrics).toMatchObject({ passed: 0 });
    const errors = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]));
    expect(errors.join('\n')).toMatch(/didn't come up: the desktop failed/);
    expect(await fs.readdir(path.join(root, 'containers'))).toEqual([]);
  }, 60_000);
});
