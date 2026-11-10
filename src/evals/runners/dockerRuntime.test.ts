import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createDockerRunner,
  dockerRunner,
  type DockerRunnerOptions,
  type DockerRuntimeContext,
  type RunnerKeep,
  type ShardEvents,
  type ShardSpec,
} from '../../entries/evals.js';
import { liveContainers, releaseContainer } from './dockerContainers.js';
import { writeShardBundle } from './protocol.js';
import packageJson from '../../../package.json' with { type: 'json' };

const cli = fileURLToPath(
  new URL('../../../tests/mocks/runtimeDocker.ts', import.meta.url)
);
const opaque = 'synthetic-opaque-runtime-input';
const token = 'synthetic-inference-token';
const dirs: string[] = [];
interface Call {
  context?: string;
  args: string[];
}

async function command(
  context: DockerRuntimeContext,
  name: string,
  input = ''
): Promise<void> {
  const run = context.channel.exec([name], {
    stdin: (async function* () {
      yield input;
    })(),
    signal: context.signal,
  });
  // Consume both streams without logging opaque data.
  const drain = async (stream: AsyncIterable<string | Buffer>) => {
    for await (const _chunk of stream) {
      /* drain */
    }
  };
  await Promise.all([drain(run.stdout), drain(run.stderr)]);
  if ((await run.exit) !== 0)
    throw new Error(`Synthetic ${name} failed: ${opaque}`);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('MST_DOCKER', cli);
  vi.stubEnv('MST_LLM_AUTH_COMMAND', '');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  vi.stubEnv('ANTHROPIC_API_KEY', token);
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('OPENAI_API_KEY', token);
});
afterEach(async () => {
  // A failed-removal test explicitly checks this guard before releasing it.
  for (const name of liveContainers()) releaseContainer('offline', name);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function fixture({
  runtime = {},
  client = 'cowork',
  keep = 'never',
  work = 'collect',
  definition,
}: {
  runtime?: DockerRunnerOptions;
  client?: string;
  keep?: RunnerKeep;
  work?: ShardSpec['work'];
  definition?: typeof dockerRunner;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-runtime-'));
  dirs.push(root);
  vi.stubEnv('RUNTIME_DOCKER_ROOT', root);
  const bundleDir = path.join(root, 'bundle');
  await writeShardBundle(bundleDir, {
    runId: 'runtime-test',
    shard: { index: 0, count: 1 },
    mst: packageJson.version,
    plugins: [],
    evalConfig: { name: 'runtime-test', datasets: [] } as never,
    tokenServers: [],
    batches: [
      {
        variant: { name: 'default' },
        requests: [
          {
            caseId: 'one',
            trial: 0,
            config: { type: client },
            input: { prompt: 'hello', servers: [] },
          },
        ],
      },
    ],
  });
  const runner = await (definition ?? createDockerRunner(runtime)).open(
    {
      contexts: 'offline',
      image: 'mst-runtime:test',
      memory: '3g',
      cpus: '2',
    },
    { runId: 'runtime-test', shards: 1, keep, client }
  );
  const controller = new AbortController();
  const events: ShardEvents = {
    progress() {},
    async requestTokens() {
      return { byServer: {} };
    },
  };
  const shard: ShardSpec = {
    runId: 'runtime-test',
    index: 0,
    count: 1,
    work,
    bundleDir,
    resultsDir: path.join(root, 'results'),
  };
  const calls = async (): Promise<Call[]> =>
    (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Call);
  const run = async () => {
    try {
      return await runner.runShard(shard, events, controller.signal);
    } finally {
      await runner.close();
    }
  };
  return { root, calls, run, runner, controller, events };
}

function stage(call: Call): string | undefined {
  if (['run', 'rm', 'rename', 'cp'].includes(call.args[0]!))
    return call.args[0];
  if (call.args.includes('--dirs-only')) return 'dirs';
  if (call.args.includes('/opt/mst/bin/desktop-session')) return 'desktop';
  if (call.args.includes('runtime-prepare')) return 'prepare';
  if (call.args.includes('runtime-cleanup')) return 'cleanup';
  if (call.args.includes('collect') || call.args.includes('grade-shard'))
    return 'worker';
  if (call.args.join(' ').includes('cat > /run/mst/inference-token'))
    return 'token';
  if (call.args.join(' ').includes('/run/mst/session/ready')) return 'ready';
  return undefined;
}

function preparation(
  cleanups: DockerRuntimeContext[] = []
): DockerRunnerOptions['prepareRuntime'] {
  return async (context) => {
    await command(context, 'runtime-prepare', opaque);
    return async (cleanupContext) => {
      cleanups.push(cleanupContext);
      await command(cleanupContext, 'runtime-cleanup');
    };
  };
}

describe('in-process Docker runtime preparation (external CLI stand-in)', () => {
  it.each(['cowork', 'chatgpt'])(
    'prepares %s before desktop startup and cleans before removal',
    async (client) => {
      vi.stubEnv('RUNTIME_DOCKER_EXPECT_PREPARED', '1');
      const cleanups: DockerRuntimeContext[] = [];
      const f = await fixture({
        client,
        runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
      });
      expect(await f.run()).toMatchObject({ ok: true, collected: 1 });
      const calls = await f.calls();
      const stages = calls.map(stage).filter(Boolean);
      expect(stages).toEqual([
        'run',
        'dirs',
        'prepare',
        'desktop',
        'ready',
        'cp',
        'worker',
        'cp',
        'cleanup',
        'rm',
      ]);
      expect(cleanups).toHaveLength(1);
      expect(cleanups[0]).toMatchObject({
        runId: 'runtime-test',
        shardIndex: 0,
        shardCount: 1,
        client,
        desktop: client,
        signal: expect.any(AbortSignal),
      });
      expect(cleanups[0]!.signal.aborted).toBe(false);
      expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
      const runArgs = calls.find((call) => call.args[0] === 'run')!.args;
      expect(runArgs.slice(-6)).toEqual([
        '--entrypoint',
        '/usr/bin/tini',
        'mst-runtime:test',
        '--',
        'sleep',
        'infinity',
      ]);
      expect(runArgs).toContain('mst.run=runtime-test');
      expect(runArgs).toContain(`mst.owner.pid=${process.pid}`);
      expect(runArgs).toContain('/run/mst:mode=0755');
      expect(runArgs).not.toContain('--privileged');
      if (client === 'cowork') {
        expect(runArgs).toContain('/dev/kvm');
        expect(runArgs[runArgs.indexOf('--memory') + 1]).toBe('3072m');
        expect(runArgs[runArgs.indexOf('--cpus') + 1]).toBe('2');
        expect(runArgs.join(' ')).toContain('seccomp=');
      } else {
        expect(runArgs).not.toContain('--device');
        expect(runArgs).toContain('no-new-privileges');
      }
      expect(JSON.stringify(calls)).not.toMatch(
        /synthetic-opaque|synthetic-inference|MST_INFERENCE|MST_CHATGPT_/
      );
      expect(JSON.stringify(cleanups)).not.toContain(opaque);
    }
  );

  it('delivers MST-managed inference before preparation, over stdin only', async () => {
    vi.stubEnv('RUNTIME_DOCKER_EXPECT_TOKEN', '1');
    const f = await fixture({ runtime: { prepareRuntime: preparation() } });
    expect(await f.run()).toMatchObject({ ok: true });
    const stages = (await f.calls()).map(stage).filter(Boolean);
    expect(stages.indexOf('dirs')).toBeLessThan(stages.indexOf('token'));
    expect(stages.indexOf('token')).toBeLessThan(stages.indexOf('prepare'));
    expect(stages.indexOf('prepare')).toBeLessThan(stages.indexOf('desktop'));
    expect(JSON.stringify(await f.calls())).not.toContain(token);
  });

  it.each(['cowork', 'chatgpt'])(
    'leaves the default %s gateway startup path unchanged',
    async (client) => {
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example/anthropic');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', token);
      vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example/openai/v1');
      const f = await fixture({ definition: dockerRunner, client });
      expect(await f.run()).toMatchObject({ ok: true });
      const calls = await f.calls();
      const stages = calls.map(stage).filter(Boolean);
      expect(stages).toEqual([
        'run',
        'token',
        'ready',
        'cp',
        'worker',
        'cp',
        'rm',
      ]);
      const runArgs = calls.find((call) => call.args[0] === 'run')!.args;
      expect(runArgs.at(-1)).toBe('mst-runtime:test');
      expect(runArgs).not.toContain('--entrypoint');
      expect(runArgs.join(' ')).toContain(
        client === 'cowork'
          ? 'MST_INFERENCE_AUTH_SCHEME=bearer'
          : 'MST_CHATGPT_INFERENCE_TOKEN_FILE='
      );
      expect(runArgs.join(' ')).toContain(
        client === 'cowork'
          ? 'MST_INFERENCE_GATEWAY_URL=https://gateway.example/anthropic'
          : 'MST_CHATGPT_INFERENCE_BASE_URL=https://gateway.example/openai/v1'
      );
      expect(JSON.stringify(calls)).not.toContain(token);
    }
  );

  it('does not resolve MST inference when the plugin manages it, even without a hook', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const f = await fixture({ runtime: { inference: 'plugin' } });
    expect(await f.run()).toMatchObject({ ok: true });
    expect((await f.calls()).map(stage)).not.toContain('token');
  });

  it('cleans the runtime before keeping a container', async () => {
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation() },
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect((await f.calls()).map(stage).filter(Boolean).slice(-2)).toEqual([
      'cleanup',
      'rename',
    ]);
    const kept = path.join(f.root, 'containers/mst-runtime-test-1-kept');
    expect(await fs.readdir(path.dirname(kept))).toEqual([
      'mst-runtime-test-1-kept',
    ]);
    await expect(
      fs.access(path.join(kept, 'run/mst/opaque-runtime'))
    ).rejects.toThrow();
  });

  it('removes partially prepared containers on failure, even with keep=always', async () => {
    const f = await fixture({
      keep: 'always',
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          await command(context, 'runtime-prepare', opaque);
          throw new Error(opaque);
        },
      },
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Runtime preparation failed'),
    });
    expect(outcome.reason).not.toContain(opaque);
    expect((await f.calls()).map(stage)).not.toContain('desktop');
    expect((await f.calls()).map(stage).filter(Boolean).slice(-1)).toEqual([
      'rm',
    ]);
    expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
  });

  it('runs returned cleanup after desktop startup fails', async () => {
    vi.stubEnv('RUNTIME_DOCKER_DESKTOP', 'failed');
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation() },
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("didn't come up"),
    });
    expect((await f.calls()).map(stage).filter(Boolean).slice(-2)).toEqual([
      'cleanup',
      'rm',
    ]);
  });

  it('runs returned cleanup after preparation is cancelled, without starting a desktop', async () => {
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      keep: 'always',
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          const cleanup = await preparation(cleanups)!(context);
          f.controller.abort();
          return cleanup;
        },
      },
    });
    expect(await f.run()).toMatchObject({ ok: false, cancelled: true });
    const stages = (await f.calls()).map(stage);
    expect(stages).not.toContain('desktop');
    expect(stages.filter(Boolean).slice(-2)).toEqual(['cleanup', 'rm']);
    expect(cleanups[0]!.signal.aborted).toBe(false);
    expect(cleanups[0]!.signal).not.toBe(f.controller.signal);
  });

  it('cleans after worker cancellation with a fresh signal', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_WORKER', '1');
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
    });
    f.events.progress = (event) => {
      if (event.type === 'hello') f.controller.abort();
    };
    expect(await f.run()).toMatchObject({ ok: false, cancelled: true });
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]!.signal.aborted).toBe(false);
    expect((await f.calls()).map(stage).filter(Boolean).slice(-2)).toEqual([
      'cleanup',
      'rm',
    ]);
  });

  it('cancels a blocked readiness command and still cleans the prepared runtime', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_READY', '1');
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      runtime: {
        inference: 'plugin',
        prepareRuntime: preparation(cleanups),
      },
    });
    const running = f.run();
    await vi.waitFor(() => fs.access(path.join(f.root, 'waiting-ready')), {
      timeout: 10_000,
    });
    f.controller.abort();
    expect(await running).toMatchObject({ ok: false, cancelled: true });
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]!.signal.aborted).toBe(false);
    expect((await f.calls()).map(stage).filter(Boolean).slice(-2)).toEqual([
      'cleanup',
      'rm',
    ]);
  }, 15_000);

  it('runs cleanup once if close overlaps shard disposal', async () => {
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
    });
    let closing: Promise<void> | undefined;
    f.events.progress = (event) => {
      if (event.type === 'hello') closing = f.runner.close();
    };
    await f.run();
    await closing;
    expect(cleanups).toHaveLength(1);
    expect(
      (await f.calls()).map(stage).filter((value) => value === 'rm')
    ).toHaveLength(1);
  });

  it('records cleanup failure in a failed shard reason and overrides keep=failed', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WORKER_FAIL', '1');
    vi.stubEnv('RUNTIME_DOCKER_CLEANUP_FAIL', '1');
    const f = await fixture({
      keep: 'failed',
      runtime: {
        inference: 'plugin',
        prepareRuntime: preparation(),
      },
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.reason).toContain('before it finished');
    expect(outcome.reason).toContain('Runtime cleanup failed');
    const stages = (await f.calls()).map(stage).filter(Boolean);
    expect(stages.slice(-2)).toEqual(['cleanup', 'rm']);
    expect(stages).not.toContain('rename');
    expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
  });

  it('bounds cleanup independently and removes rather than keeping a timed-out runtime', async () => {
    let cleanupSignal: AbortSignal | undefined;
    const f = await fixture({
      keep: 'always',
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          await command(context, 'runtime-prepare', opaque);
          return async ({ signal }) => {
            cleanupSignal = signal;
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true })
            );
          };
        },
      },
    });
    const outcome = await f.run();
    expect(outcome.note).toContain('Runtime cleanup timed out after 30 s');
    expect(cleanupSignal!.aborted).toBe(true);
    expect((await f.calls()).map(stage).filter(Boolean).at(-1)).toBe('rm');
    expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
  }, 40_000);

  it('never keeps a container when runtime cleanup fails, and surfaces the failure', async () => {
    vi.stubEnv('RUNTIME_DOCKER_CLEANUP_FAIL', '1');
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation() },
    });
    const outcome = await f.run();
    expect(outcome.note).toContain('Runtime cleanup failed');
    expect(JSON.stringify(outcome)).not.toContain(opaque);
    const stages = (await f.calls()).map(stage).filter(Boolean);
    expect(stages.slice(-2)).toEqual(['cleanup', 'rm']);
    expect(stages).not.toContain('rename');
    expect(stages.filter((value) => value === 'cleanup')).toHaveLength(1);
    expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
  });

  it('retains the removal guard and reports both failures when removal fails too', async () => {
    vi.stubEnv('RUNTIME_DOCKER_CLEANUP_FAIL', '1');
    vi.stubEnv('RUNTIME_DOCKER_REMOVE_FAIL', '1');
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation() },
    });
    const outcome = await f.run();
    expect(outcome.note).toContain('Runtime cleanup failed');
    expect(outcome.note).toContain(
      'Removing container mst-runtime-test-1 failed: daemon refused removal'
    );
    expect(liveContainers()).toContain('mst-runtime-test-1');
    expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([
      'mst-runtime-test-1',
    ]);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toMatch(
      /kept container|removed container/
    );
  });

  it('reports a failed preparation and a failed removal without losing the guard', async () => {
    vi.stubEnv('RUNTIME_DOCKER_REMOVE_FAIL', '1');
    const f = await fixture({
      keep: 'always',
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          await command(context, 'runtime-prepare', opaque);
          throw new Error(opaque);
        },
      },
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.reason).toContain('Runtime preparation failed');
    expect(outcome.reason).toContain('daemon refused removal');
    expect(outcome.reason).not.toContain(opaque);
    expect(liveContainers()).toContain('mst-runtime-test-1');
    expect((await f.calls()).map(stage)).not.toContain('rename');
  });

  it('removes rather than falsely reporting a kept container when rename fails', async () => {
    vi.stubEnv('RUNTIME_DOCKER_RENAME_FAIL', '1');
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation() },
    });
    expect((await f.run()).note).toContain('renaming failed');
    expect((await f.calls()).map(stage).filter(Boolean).slice(-3)).toEqual([
      'cleanup',
      'rename',
      'rm',
    ]);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(
      'kept container'
    );
  });

  it.each([
    { work: 'grade' as const, client: 'chatgpt' },
    { work: 'collect' as const, client: 'api' },
  ])('skips runtime hooks for $work/$client', async ({ work, client }) => {
    const prepareRuntime = vi
      .fn<NonNullable<DockerRunnerOptions['prepareRuntime']>>()
      .mockRejectedValue(new Error('must not run'));
    const f = await fixture({
      work,
      client,
      runtime: { inference: 'plugin', prepareRuntime },
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(prepareRuntime).not.toHaveBeenCalled();
    const stages = (await f.calls()).map(stage);
    expect(stages).not.toContain('prepare');
    expect(stages).not.toContain('desktop');
    expect(stages).not.toContain('token');
  });

  it('keeps in-process runtime options out of the serialized runner schema', () => {
    const definition = createDockerRunner({
      inference: 'plugin',
      prepareRuntime: preparation(),
    });
    expect(definition.schema).toBe(dockerRunner.schema);
    expect(definition.schema.safeParse({ inference: 'plugin' }).success).toBe(
      false
    );
    expect(
      definition.schema.safeParse({ prepareRuntime: opaque }).success
    ).toBe(false);
  });

  it('Cowork --dirs-only only initializes private directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-runtime-dirs-'));
    dirs.push(root);
    vi.stubEnv('RUNTIME_DOCKER_ROOT', root);
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    for (const name of ['id', 'install'])
      await fs.symlink(cli, path.join(bin, name));
    const session = fileURLToPath(
      new URL(
        '../../../docker/cowork-linux/bin/desktop-session',
        import.meta.url
      )
    );
    await promisify(execFile)('bash', [session, '--dirs-only'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = (
      await fs.readFile(path.join(root, 'image-calls.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      [
        '-d',
        '-o',
        'mst',
        '-g',
        'mst',
        '-m',
        '0700',
        '/run/mst',
        '/run/mst/session',
        '/run/mst/tokens',
        '/run/mst/settings',
      ],
    ]);
  });
});
