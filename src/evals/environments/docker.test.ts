import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  containerName,
  contextPool,
  chatgptDockerRunArgs,
  coworkImageDirectory,
  DEFAULT_CHATGPT_IMAGE,
  DEFAULT_COWORK_IMAGE,
  deliverToken,
  dockerClient,
  dockerRunArgs,
  gradeContainerPrepareArgs,
  headlessContainerRunArgs,
  imageDirectory,
  npmPackArgs,
  shardIsHeadless,
} from './docker.js';
import { writeShardBundle } from './protocol.js';
import { resolveEnvironment } from './builtinEnvironments.js';
import { gradeRun, runEval } from '../runEval.js';
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
  it("forwards the coordinator's Cowork VM warm-up budget to the container", () => {
    const base = {
      name: 'mst-run-1',
      image: 'mst-cowork-linux:test',
      runId: 'run',
      seccompProfile: '/pkg/docker/cowork-linux/seccomp.json',
      inference: {
        baseURL: 'https://gateway.example/anthropic',
        authScheme: 'bearer' as const,
      },
    };
    const args = dockerRunArgs({ ...base, warmVmTimeoutS: '1740' });
    expect(args[args.indexOf('MST_COWORK_WARM_VM_TIMEOUT_S=1740') - 1]).toBe(
      '--env'
    );
    expect(args.at(-1)).toBe('mst-cowork-linux:test');
    for (const warmVmTimeoutS of [undefined, '', '0', '12s', '-5'])
      expect(
        dockerRunArgs({ ...base, warmVmTimeoutS }).join(' ')
      ).not.toContain('MST_COWORK_WARM_VM_TIMEOUT_S');
  });

  it('packs a checkout as built, and an installed package without its scripts', () => {
    expect(npmPackArgs('/out', { ignoreScripts: false })).toEqual([
      'pack',
      '--silent',
      '--pack-destination',
      '/out',
    ]);
    expect(npmPackArgs('/out', { ignoreScripts: true })).toContain(
      '--ignore-scripts'
    );
  });

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
    // Whose it is: a later run removes it if this process dies.
    expect(args).toContain('mst.run=run');
    expect(args).toContain(`mst.owner.host=${os.hostname()}`);
    expect(args).toContain(`mst.owner.pid=${process.pid}`);
    expect(args.at(-1)).toBe('mst-cowork-linux:test');
  });

  it('limits a container to its memory and CPUs, when they are set', () => {
    const base = {
      name: 'mst-run-1',
      image: 'mst-cowork-linux:test',
      runId: 'run',
      seccompProfile: '/pkg/docker/cowork-linux/seccomp.json',
      inference: {
        baseURL: 'https://gateway.example/anthropic',
        authScheme: 'bearer' as const,
      },
    };
    const args = dockerRunArgs({
      ...base,
      limits: { memory: 8 * 1024 ** 3, cpus: 2 },
    });
    expect(args.slice(-5)).toEqual([
      '--memory',
      '8192m',
      '--cpus',
      '2',
      'mst-cowork-linux:test',
    ]);
    expect(dockerRunArgs({ ...base, limits: {} })).not.toContain('--memory');
    expect(dockerRunArgs(base)).not.toContain('--cpus');
    const grade = headlessContainerRunArgs({
      name: 'mst-run-1',
      image: 'mst-cowork-linux:test',
      runId: 'run',
      limits: { memory: 2 * 1024 ** 3 },
    });
    expect(grade[grade.indexOf('--memory') + 1]).toBe('2048m');
    expect(grade.indexOf('--memory')).toBeLessThan(
      grade.indexOf('--entrypoint')
    );
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

  it('runs as many containers on a context as it has slots, roomiest first', async () => {
    const sizes: Record<string, number> = { a: 2, b: 1, c: 0 };
    const pool = contextPool(['a', 'b', 'c'], async (context) =>
      context === 'c'
        ? Promise.reject(new Error('no answer'))
        : sizes[context!]!
    );
    const signal = new AbortController().signal;
    // c's size is unknown: one slot, like a context that can't say.
    const taken = [
      await pool.acquire(signal),
      await pool.acquire(signal),
      await pool.acquire(signal),
      await pool.acquire(signal),
    ];
    expect(taken).toEqual(['a', 'a', 'b', 'c']);
    let fifth: string | undefined = 'waiting';
    const waiting = pool.acquire(signal).then((context) => (fifth = context));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fifth).toBe('waiting');
    pool.release('a');
    await waiting;
    expect(fifth).toBe('a');
    // A released slot with no one waiting is taken again.
    pool.release('b');
    expect(await pool.acquire(signal)).toBe('b');
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
    expect(
      resolveEnvironment('docker', { memory: '8g', cpus: '1.5' }).options
    ).toEqual({ memory: '8g', cpus: '1.5' });
    expect(() => resolveEnvironment('docker', { memory: 'lots' })).toThrow(
      'memory must be a size such as 8g or 512m'
    );
    expect(() => resolveEnvironment('docker', { cpus: '0' })).toThrow(
      'cpus must be more than 0'
    );
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

describe('ChatGPT in the docker environment', () => {
  it('picks the ChatGPT image only for a ChatGPT eval', () => {
    expect(dockerClient('chatgpt')).toBe('chatgpt');
    for (const client of ['cowork', undefined])
      expect(dockerClient(client)).toBe('cowork');
    expect(DEFAULT_CHATGPT_IMAGE).toMatch(/^mst-chatgpt-linux:/);
  });

  it('starts a container with no devices, no new privileges, and no secret', () => {
    const args = chatgptDockerRunArgs({
      name: 'mst-run-1',
      image: 'mst-chatgpt-linux:test',
      runId: 'run',
      inference: {
        MST_CHATGPT_INFERENCE_BASE_URL: 'https://gateway.example/openai/v1',
        MST_CHATGPT_INFERENCE_TOKEN_FILE: '/run/mst/inference-token',
      },
    });
    expect(args).not.toContain('--device');
    expect(args.join(' ')).not.toContain('seccomp=');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain(
      'MST_CHATGPT_INFERENCE_BASE_URL=https://gateway.example/openai/v1'
    );
    expect(args).toContain('/run/mst:mode=0755');
    expect(args.at(-1)).toBe('mst-chatgpt-linux:test');
  });

  it('ships the image beside the package', async () => {
    const dir = imageDirectory('chatgpt');
    for (const file of [
      'Dockerfile',
      'bin/desktop-session',
      'bin/chatgpt-package',
    ])
      await expect(fs.stat(path.join(dir, file))).resolves.toBeTruthy();
    const dockerfile = await fs.readFile(path.join(dir, 'Dockerfile'), 'utf8');
    // The Linux client's contract, from the image's ENV.
    for (const key of [
      'AT_SPI_BUS_ADDRESS',
      'GNOME_KEYRING_CONTROL',
      'MST_CHATGPT_APP_PATH',
      'MST_CHATGPT_CODEX_PATH',
      'MST_CHATGPT_EVIDENCE_DIR',
    ])
      expect(dockerfile).toContain(`${key}=`);
  });

  it('takes chatgptVersion as a setup option', () => {
    expect(() =>
      resolveEnvironment('docker', { chatgptVersion: '26.1007.71326' })
    ).not.toThrow();
    expect(() =>
      resolveEnvironment('docker', { chatgptVersion: 'latest; rm -rf' })
    ).toThrow();
  });
});

describe('delivering the inference token (a fake Docker CLI)', () => {
  async function container(denials: number): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-token-'));
    await fs.mkdir(path.join(root, 'containers', 'mst-token-1', 'run/mst'), {
      recursive: true,
    });
    vi.stubEnv('MST_DOCKER', mock('fakeDocker.mjs'));
    vi.stubEnv('FAKE_DOCKER_ROOT', root);
    vi.stubEnv('FAKE_DOCKER_TOKEN_DENIALS', String(denials));
    return root;
  }
  async function calls(root: string): Promise<number> {
    const log = await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8');
    return log.trim().split('\n').length;
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('retries a write the new container denies', async () => {
    const root = await container(2);
    await deliverToken(undefined, 'mst-token-1', 'synthetic-token');
    expect(await calls(root)).toBe(3);
    expect(
      await fs.readFile(
        path.join(root, 'containers/mst-token-1/run/mst/inference-token'),
        'utf8'
      )
    ).toBe('synthetic-token');
  });

  it('fails at once when the container has gone', async () => {
    const root = await container(0);
    const started = Date.now();
    await expect(
      deliverToken(undefined, 'mst-gone-1', 'synthetic-token')
    ).rejects.toThrow('No such container: mst-gone-1');
    expect(await calls(root)).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops retrying when the run is cancelled', async () => {
    await container(10_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const started = Date.now();
    await expect(
      deliverToken(
        undefined,
        'mst-token-1',
        'synthetic-token',
        controller.signal
      )
    ).rejects.toThrow('The run was cancelled.');
    expect(Date.now() - started).toBeLessThan(5_000);
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

  it("builds the ChatGPT image when the eval's shared config makes it a ChatGPT eval", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root, project, configPath } = await fixture(
      { MST_NPM: mock('fakeNpm.mjs') },
      ['@acme/mst-dt']
    );
    await installPluginPackage(project, '1.2.3');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete config.client;
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, extends: ['dt/config/chatgpt'] })
    );
    await setupEnvironment('docker', {
      config: configPath,
      envOption: ['contexts=ctx-a'],
      rootDir: project,
    });
    const builds = (await fs.readFile(path.join(root, 'builds.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(builds).toEqual([
      {
        context: 'ctx-a',
        tag: DEFAULT_CHATGPT_IMAGE,
        plugins: ['acme-mst-dt-1.2.3.tgz'],
        desktop: 'chatgpt',
      },
    ]);
  }, 120_000);

  it("fails a build with the build's last lines, so the cause is in the error", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { project, configPath } = await fixture(
      {
        MST_NPM: mock('fakeNpm.mjs'),
        FAKE_DOCKER_BUILD_ERROR: 'ERROR: error reading from server: EOF',
      },
      ['@acme/mst-dt']
    );
    await installPluginPackage(project, '1.2.3');
    await expect(
      setupEnvironment('docker', {
        config: configPath,
        envOption: ['contexts=ctx-a', 'image=mst-test:1'],
        rootDir: project,
      })
    ).rejects.toThrow(
      'Building mst-test:1 on ctx-a failed: #12 [5/9] RUN npm install ERROR: error reading from server: EOF'
    );
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
    // Each Cowork container may use all its context can spare: the fake's
    // 8 GiB, less 1 GiB for the daemon.
    for (const run of runs)
      expect(run.args[run.args.indexOf('--memory') + 1]).toBe('7168m');
    expect(lines).toContain(
      '[mst] ctx-a has 8 GiB and 4 CPUs: 1 Cowork container at a time, 7 GiB each'
    );
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

  it("makes a ChatGPT grade container's tmpfs HOME and TMPDIR before its worker, and the tmpfs and tokens directory for Cowork", () => {
    expect(gradeContainerPrepareArgs('mst-run-1', 'chatgpt')).toEqual([
      'exec',
      '-u',
      'root',
      'mst-run-1',
      '/opt/mst/bin/desktop-session',
      '--dirs-only',
    ]);
    expect(gradeContainerPrepareArgs('mst-run-1', 'cowork')).toEqual([
      'exec',
      '-u',
      'root',
      'mst-run-1',
      'install',
      '-d',
      '-o',
      'mst',
      '-g',
      'mst',
      '-m',
      '0700',
      '/run/mst',
      '/run/mst/tokens',
    ]);
  });

  it('grades a stored run in containers without a desktop or inference, two to a context (ADR 0005)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, root, configPath, calls } = await fixture();
    const outputDir = path.join(dir, 'out');
    const collected = await runEval({
      configPath,
      rootDir: dir,
      outputDir,
      env: 'docker',
      envOptions: { contexts: 'ctx-a', image: 'mst-test:1' },
      grade: false,
      report: false,
    });
    const before = (await calls()).length;
    // Grading starts no client: it needs no inference.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const graded = await gradeRun({
      configPath,
      rootDir: dir,
      outputDir,
      run: path.basename(collected.outputDir),
      env: 'docker',
      envOptions: { shards: '2', contexts: 'ctx-a', image: 'mst-test:1' },
      report: false,
    });
    expect(graded.summary.metrics).toMatchObject({ passed: 3, total: 3 });
    const runs = (await calls())
      .slice(before)
      .filter((call) => call.args[0] === 'run');
    // Both on the one context: no VM, so no host-wide port to share.
    expect(runs.map((call) => call.context)).toEqual(['ctx-a', 'ctx-a']);
    for (const run of runs) {
      expect(run.args).not.toContain('/dev/kvm');
      expect(run.args.join(' ')).not.toContain('MST_INFERENCE');
      expect(run.args[run.args.indexOf('--memory') + 1]).toBe('2048m');
      expect(run.args.slice(-4)).toEqual([
        'mst-test:1',
        '--',
        'sleep',
        'infinity',
      ]);
    }
    // Each container's worker graded; none collected.
    const workers = (await calls())
      .slice(before)
      .filter((call) => call.args[0] === 'exec')
      .map((call) =>
        call.args.find((arg) => /^(collect|grade-shard)$/.test(arg))
      )
      .filter(Boolean);
    expect(workers).toEqual(['grade-shard', 'grade-shard']);
    const stored = await readRunDirectory(graded.outputDir);
    expect(stored.run.grading?.environment).toMatchObject({
      name: 'docker',
      shards: 2,
    });
    expect(
      stored.run.grading?.environment.machines?.map((machine) => machine.ok)
    ).toEqual([true, true]);
    expect(await fs.readdir(path.join(root, 'containers'))).toEqual([]);
  }, 120_000);

  it('grades one container at a time on a context with room for one', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, configPath, calls } = await fixture();
    const outputDir = path.join(dir, 'out');
    const collected = await runEval({
      configPath,
      rootDir: dir,
      outputDir,
      env: 'docker',
      envOptions: { contexts: 'ctx-a', image: 'mst-test:1' },
      grade: false,
      report: false,
    });
    const before = (await calls()).length;
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // 4 GiB, so 3 GiB to spare: one 3g grade container fits.
    vi.stubEnv('FAKE_DOCKER_INFO', `${4 * 1024 ** 3} 4`);
    const graded = await gradeRun({
      configPath,
      rootDir: dir,
      outputDir,
      run: path.basename(collected.outputDir),
      env: 'docker',
      envOptions: {
        shards: '2',
        contexts: 'ctx-a',
        image: 'mst-test:1',
        memory: '3g',
      },
      report: false,
    });
    expect(graded.summary.metrics).toMatchObject({ passed: 3, total: 3 });
    // Every container is removed before the next one starts.
    const lifecycle = (await calls())
      .slice(before)
      .filter((call) => call.args[0] === 'run' || call.args[0] === 'rm')
      .map((call) => call.args[0]);
    expect(lifecycle).toEqual(['run', 'rm', 'run', 'rm']);
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(
      '[mst] ctx-a has 4 GiB and 4 CPUs: 1 grade container at a time, 3 GiB each'
    );
  }, 120_000);

  it('says a shard ran out of memory when Docker killed its worker for it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, configPath } = await fixture({ FAKE_DOCKER_OOM: '*' });
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { image: 'mst-test:1', memory: '6g' },
      report: false,
    });
    expect(result.summary.metrics).toMatchObject({ passed: 0 });
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /Container mst-\S+-1 ran out of memory \(its limit: 6 GiB\): raise --env-option memory, or give the Docker context more memory\. The worker exited \(code 137\)/
    );
  }, 60_000);

  it('says a desktop that ran out of memory starting up did', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, configPath, root } = await fixture({
      FAKE_DOCKER_OOM: '*',
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
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /Couldn't create a machine for shard 1: Container mst-\S+-1 ran out of memory \(its limit: 7 GiB\): give the Docker context more memory\. The desktop in container mst-\S+-1 didn't come up/
    );
    expect(await fs.readdir(path.join(root, 'containers'))).toEqual([]);
  }, 60_000);

  it('collects a headless client in containers without a desktop or inference', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, root, configPath, calls } = await fixture({
      // A headless client needs no Cowork inference.
      ANTHROPIC_API_KEY: '',
    });
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, client: 'dt/client/headless' })
    );
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { shards: '2', contexts: 'ctx-a', image: 'mst-test:1' },
      report: false,
    });
    expect(result.summary.metrics).toMatchObject({ passed: 3, total: 3 });
    const all = await calls();
    const runs = all.filter((call) => call.args[0] === 'run');
    // No VM, so both shards share the one context.
    expect(runs.map((call) => call.context)).toEqual(['ctx-a', 'ctx-a']);
    for (const run of runs) {
      expect(run.args).not.toContain('/dev/kvm');
      expect(run.args.join(' ')).not.toContain('MST_INFERENCE');
      expect(run.args.slice(-4)).toEqual([
        'mst-test:1',
        '--',
        'sleep',
        'infinity',
      ]);
    }
    // Nobody waited for a desktop; each worker collected.
    const execs = all.filter((call) => call.args[0] === 'exec');
    expect(
      execs.some((call) =>
        call.args.join(' ').includes('/run/mst/session/ready')
      )
    ).toBe(false);
    expect(execs.filter((call) => call.args.includes('collect'))).toHaveLength(
      2
    );
    // Without the desktop session, MST makes the worker's tokens directory.
    expect(
      execs.filter(
        (call) =>
          call.args.includes('install') &&
          call.args.includes('/run/mst') &&
          call.args.at(-1) === '/run/mst/tokens' &&
          call.args.includes('mst')
      )
    ).toHaveLength(2);
    expect(await fs.readdir(path.join(root, 'containers'))).toEqual([]);
  }, 120_000);

  it('gives a shard the desktop unless every client in it is headless', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-headless-'));
    dirs.push(dir);
    const bundle = (types: string[]) =>
      writeShardBundle(dir, {
        runId: 'r',
        shard: { index: 0, count: 1 },
        mst: packageJson.version,
        plugins: [],
        evalConfig: { name: 'e', datasets: [] } as never,
        tokenServers: [],
        batches: [
          {
            variant: { name: 'default' },
            requests: types.map((type, index) => ({
              caseId: `c${index}`,
              trial: 0,
              config: { type },
              input: { prompt: 'x', servers: [] },
            })),
          },
        ],
      });
    await bundle(['codex', 'mst']);
    expect(await shardIsHeadless(dir)).toBe(true);
    await bundle(['codex', 'cowork']);
    expect(await shardIsHeadless(dir)).toBe(false);
    await bundle(['acme/client/unknown']);
    expect(await shardIsHeadless(dir)).toBe(false);
    await bundle([]);
    expect(await shardIsHeadless(dir)).toBe(false);
    expect(await shardIsHeadless(path.join(dir, 'missing'))).toBe(false);
  });

  it('removes the containers a dead run on this machine left, and only those', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, root, configPath } = await fixture();
    // A process that has exited: the owner of the orphan.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const container = async (name: string, labels: string[]) => {
      await fs.mkdir(path.join(root, 'containers', name), { recursive: true });
      await fs.writeFile(
        path.join(root, 'containers', name, 'run-args.json'),
        JSON.stringify(labels.flatMap((label) => ['--label', label]))
      );
    };
    await container('mst-orphan-1', [
      'mst.run=orphan',
      `mst.owner.host=${os.hostname()}`,
      `mst.owner.pid=${dead}`,
    ]);
    await container('mst-elsewhere-1', [
      'mst.run=elsewhere',
      'mst.owner.host=another-machine',
      `mst.owner.pid=${dead}`,
    ]);
    await container('mst-debug-1-kept', [
      'mst.run=debug',
      `mst.owner.host=${os.hostname()}`,
      `mst.owner.pid=${dead}`,
    ]);
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { shards: '1', image: 'mst-test:1' },
      report: false,
    });
    expect(result.summary.metrics).toMatchObject({ passed: 3, total: 3 });
    expect((await fs.readdir(path.join(root, 'containers'))).sort()).toEqual([
      'mst-debug-1-kept',
      'mst-elsewhere-1',
    ]);
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(
      '[mst] removed container mst-orphan-1: the run that started it is gone'
    );
  }, 120_000);

  it('retries the token until the new container lets the desktop user write it', async () => {
    // On a slow machine, MST can write the token before the entrypoint has
    // given /run/mst to the desktop user; that used to lose the shard.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, configPath } = await fixture({
      FAKE_DOCKER_TOKEN_DENIALS: '2',
    });
    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'docker',
      envOptions: { image: 'mst-test:1' },
      report: false,
    });
    expect(result.summary.metrics).toMatchObject({ passed: 3, total: 3 });
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
