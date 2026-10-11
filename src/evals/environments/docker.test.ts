import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containerName,
  contextPool,
  coworkImageDirectory,
  DEFAULT_COWORK_IMAGE,
  dockerRunArgs,
} from './docker.js';
import { resolveEnvironment } from './builtinEnvironments.js';
import { runEval } from '../runEval.js';
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

describe('a run in docker (a fake Docker CLI)', () => {
  async function fixture(env: Record<string, string> = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-docker-'));
    dirs.push(dir);
    const root = path.join(dir, 'docker');
    await fs.mkdir(root, { recursive: true });
    vi.stubEnv('MST_DOCKER', mock('fakeDocker.mjs'));
    vi.stubEnv('FAKE_DOCKER_ROOT', root);
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('MST_LLM_AUTH_COMMAND', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: ['alpha', 'bravo', 'charlie'].map((id) => ({
          id,
          input: id,
          assertions: { containsText: 'answered' },
        })),
      })
    );
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'docker',
        plugins: [mock('dockerTestPlugin.ts')],
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
    return { dir, root, configPath, calls };
  }

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
