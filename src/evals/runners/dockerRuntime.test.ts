import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { build } from 'esbuild';
import { getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type * as TimerPromises from 'node:timers/promises';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof TimerPromises>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
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

let cli: string;
let cliDir: string;
beforeAll(async () => {
  cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-runtime-cli-'));
  cli = path.join(cliDir, 'runtimeDocker.mjs');
  await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../tests/mocks/runtimeDocker.ts', import.meta.url)
      ),
    ],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
  });
  await fs.chmod(cli, 0o700);
});
afterAll(async () => {
  await fs.rm(cliDir, { recursive: true, force: true });
});
const opaque = 'synthetic-opaque-runtime-input';
const token = 'synthetic-inference-token';
const dirs: string[] = [];
const watchers = new Set<FSWatcher>();
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
  await Promise.all([drain(run.stdout), drain(run.stderr)]);
  if ((await run.exit) !== 0)
    throw new Error(`Synthetic ${name} failed: ${opaque}`);
}

async function drain(stream: AsyncIterable<string | Buffer>): Promise<void> {
  for await (const _chunk of stream) {
    /* drain */
  }
}

beforeEach(() => {
  vi.mocked(sleep).mockClear();
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
  for (const watcher of watchers) watcher.close();
  watchers.clear();
  vi.mocked(sleep).mockReset();
  const actual = await vi.importActual<typeof TimerPromises>(
    'node:timers/promises'
  );
  vi.mocked(sleep).mockImplementation(actual.setTimeout);
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
  readyTimeout,
  image = 'mst-runtime:test',
}: {
  runtime?: DockerRunnerOptions;
  client?: string;
  keep?: RunnerKeep;
  work?: ShardSpec['work'];
  definition?: typeof dockerRunner;
  readyTimeout?: string;
  image?: string | null;
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
      ...(image === null ? {} : { image }),
      memory: '3g',
      cpus: '2',
      ...(readyTimeout ? { readyTimeout } : {}),
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
  if (call.args.includes('--prepare')) return 'initialize';
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

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), { persistent: false }, () => {
      void check();
    });
    watchers.add(watcher);
    watcher.once('error', (error) => {
      watcher.close();
      watchers.delete(watcher);
      reject(error);
    });
    async function check(): Promise<void> {
      if (
        !(await fs.access(file).then(
          () => true,
          () => false
        ))
      )
        return;
      watcher.close();
      watchers.delete(watcher);
      resolve();
    }
    // Covers a file created between arming the watcher and the first event.
    void check();
  });
}

function observeReadinessPoll(): Promise<AbortSignal> {
  let onPoll!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    onPoll = resolve;
  });
  const original = vi.mocked(sleep).getMockImplementation()! as typeof sleep;
  vi.mocked(sleep).mockImplementation(function <T = void>(
    delay?: number,
    value?: T,
    options?: Parameters<typeof sleep>[2]
  ): Promise<T> {
    if (delay === 3000 && options?.signal) onPoll(options.signal);
    return original<T>(delay, value, options);
  });
  return started;
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
      const interval = vi.spyOn(globalThis, 'setInterval');
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
        'initialize',
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
      expect(interval.mock.calls.some(([, delay]) => delay === 240_000)).toBe(
        false
      );
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
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    vi.stubEnv('RUNTIME_DOCKER_EXPECT_TOKEN', '1');
    const f = await fixture({ runtime: { prepareRuntime: preparation() } });
    expect(await f.run()).toMatchObject({ ok: true });
    const stages = (await f.calls()).map(stage).filter(Boolean);
    expect(stages.indexOf('initialize')).toBeLessThan(stages.indexOf('token'));
    expect(stages.indexOf('token')).toBeLessThan(stages.indexOf('prepare'));
    expect(stages.indexOf('prepare')).toBeLessThan(stages.indexOf('desktop'));
    expect(JSON.stringify(await f.calls())).not.toContain(token);
    const scheduled = interval.mock.calls.findIndex(
      ([, delay]) => delay === 240_000
    );
    expect(scheduled).toBeGreaterThanOrEqual(0);
    expect(clear).toHaveBeenCalledWith(interval.mock.results[scheduled]!.value);
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

  it.each(['cowork', 'chatgpt'])(
    'keeps the default %s container and releases its removal guard',
    async (client) => {
      const interval = vi.spyOn(globalThis, 'setInterval');
      const clear = vi.spyOn(globalThis, 'clearInterval');
      const f = await fixture({
        definition: dockerRunner,
        client,
        keep: 'always',
      });
      expect(await f.run()).toMatchObject({ ok: true });
      const stages = (await f.calls()).map(stage).filter(Boolean);
      expect(stages).toEqual([
        'run',
        'token',
        'ready',
        'cp',
        'worker',
        'cp',
        'rename',
      ]);
      expect(liveContainers()).not.toContain('mst-runtime-test-1');
      const scheduled = interval.mock.calls.findIndex(
        ([, delay]) => delay === 240_000
      );
      expect(scheduled).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(
        interval.mock.results[scheduled]!.value
      );
      expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([
        'mst-runtime-test-1-kept',
      ]);
    }
  );

  it.each([
    { client: 'cowork', deferred: false },
    { client: 'chatgpt', deferred: false },
    { client: 'cowork', deferred: true },
    { client: 'chatgpt', deferred: true },
  ])(
    'refreshes MST inference for $client (deferred=$deferred) and stops on cancellation',
    async ({ client, deferred }) => {
      vi.stubEnv('RUNTIME_DOCKER_WAIT_WORKER', '1');
      const interval = vi.spyOn(globalThis, 'setInterval');
      const clear = vi.spyOn(globalThis, 'clearInterval');
      const f = await fixture({
        client,
        ...(deferred
          ? { runtime: { prepareRuntime: preparation() } }
          : { definition: dockerRunner }),
      });
      let onHello!: () => void;
      const hello = new Promise<void>((resolve) => {
        onHello = resolve;
      });
      f.events.progress = (event) => {
        if (event.type === 'hello') onHello();
      };
      const running = f.run();
      await hello;
      const scheduled = interval.mock.calls.findIndex(
        ([, delay]) => delay === 240_000
      );
      expect(scheduled).toBeGreaterThanOrEqual(0);
      const timer = interval.mock.results[scheduled]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      const fresh = 'synthetic-refreshed-token';
      vi.stubEnv(
        client === 'cowork' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
        fresh
      );
      // Invoke the observed production interval, not a shorter test interval.
      const refreshed = waitForFile(path.join(f.root, 'token-refreshed'));
      interval.mock.calls[scheduled]![0]();
      await refreshed;
      expect(
        await fs.readFile(
          path.join(
            f.root,
            'containers/mst-runtime-test-1/run/mst/inference-token'
          ),
          'utf8'
        )
      ).toBe(fresh);
      f.controller.abort();
      expect(await running).toMatchObject({ ok: false, cancelled: true });
      expect(clear).toHaveBeenCalledWith(timer);
      expect(
        (await f.calls()).map(stage).filter((value) => value === 'token')
      ).toHaveLength(2);
      expect(JSON.stringify(await f.calls())).not.toContain(fresh);
    }
  );

  it.each([false, true])(
    'stops the MST refresh timer after startup failure (deferred=%s)',
    async (deferred) => {
      vi.stubEnv('RUNTIME_DOCKER_DESKTOP', 'failed');
      const interval = vi.spyOn(globalThis, 'setInterval');
      const clear = vi.spyOn(globalThis, 'clearInterval');
      const f = await fixture(
        deferred
          ? { runtime: { prepareRuntime: preparation() } }
          : { definition: dockerRunner }
      );
      expect(await f.run()).toMatchObject({ ok: false });
      const scheduled = interval.mock.calls.findIndex(
        ([, delay]) => delay === 240_000
      );
      expect(scheduled).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(
        interval.mock.results[scheduled]!.value
      );
    }
  );

  it('does not resolve MST inference when the plugin manages it, even without a hook', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const f = await fixture({ runtime: { inference: 'plugin' } });
    expect(await f.run()).toMatchObject({ ok: true });
    expect((await f.calls()).map(stage)).not.toContain('token');
    expect(interval.mock.calls.some(([, delay]) => delay === 240_000)).toBe(
      false
    );
  });

  it.each(['', '<no value>', '2'])(
    'rejects unsupported image preparation capability %j before creation',
    async (capability) => {
      vi.stubEnv('RUNTIME_DOCKER_CAPABILITY', capability);
      const prepareRuntime =
        vi.fn<NonNullable<DockerRunnerOptions['prepareRuntime']>>();
      const f = await fixture({
        runtime: { inference: 'plugin', prepareRuntime },
      });
      const outcome = await f.run();
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.reason).toContain('mst-runtime:test');
      expect(outcome.reason).toContain('runtime preparation protocol 1');
      expect(outcome.reason).toContain('mst runner setup docker');
      expect(prepareRuntime).not.toHaveBeenCalled();
      expect((await f.calls()).map(stage).filter(Boolean)).toEqual([]);
      expect(liveContainers()).not.toContain('mst-runtime-test-1');
    }
  );

  it.each(['cowork', 'chatgpt'])(
    'rejects an old %s image under the current default tag before creation',
    async (client) => {
      vi.stubEnv('RUNTIME_DOCKER_CAPABILITY', '');
      const f = await fixture({
        client,
        image: null,
        runtime: { inference: 'plugin' },
      });
      expect(await f.run()).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          `mst-${client}-linux:${packageJson.version}`
        ),
      });
      expect((await f.calls()).map(stage).filter(Boolean)).toEqual([]);
    }
  );

  it('bounds a blocked initialization without calling the hook or starting a desktop', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_INITIALIZE', '1');
    const realTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) =>
      realTimeout(delay === 60_000 ? 100 : delay)
    );
    const prepareRuntime =
      vi.fn<NonNullable<DockerRunnerOptions['prepareRuntime']>>();
    const f = await fixture({
      runtime: { inference: 'plugin', prepareRuntime },
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        'Runtime initialization timed out after 60 s'
      ),
    });
    expect(prepareRuntime).not.toHaveBeenCalled();
    const stages = (await f.calls()).map(stage);
    expect(stages).not.toContain('desktop');
    expect(stages.filter((value) => value === 'rm')).toHaveLength(1);
  });

  it.each([
    { readyTimeout: '3000000', prepared: false },
    { readyTimeout: '5000000', prepared: false },
    { readyTimeout: '3000000', prepared: true },
    { readyTimeout: '5000000', prepared: true },
  ])(
    'supports readyTimeout=$readyTimeout without timer overflow (prepared=$prepared)',
    async ({ readyTimeout, prepared }) => {
      expect(dockerRunner.schema.parse({ readyTimeout })).toMatchObject({
        readyTimeout,
      });
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const cleared = vi.spyOn(globalThis, 'clearTimeout');
      const f = await fixture({
        readyTimeout,
        ...(prepared
          ? { runtime: { inference: 'plugin' as const } }
          : { definition: dockerRunner }),
      });
      expect(await f.run()).toMatchObject({ ok: true, collected: 1 });
      expect((await f.calls()).map(stage)).toContain('worker');
      const longTimers = timers.mock.calls.flatMap(([, delay], index) =>
        delay !== undefined && delay > 1_000_000
          ? [
              {
                delay,
                timer: timers.mock.results[index]!.value as NodeJS.Timeout,
              },
            ]
          : []
      );
      expect(longTimers).toHaveLength(1);
      expect(longTimers[0]!.delay).toBeLessThanOrEqual(2 ** 31 - 1);
      expect(cleared).toHaveBeenCalledWith(longTimers[0]!.timer);
      expect(liveContainers()).toEqual([]);
    }
  );

  it('rearms a long readiness deadline and aborts a blocked command only at the full deadline', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_READY', '1');
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      readyTimeout: '3000000',
      runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
    });
    const chunks: Array<{
      delay: number;
      timer: NodeJS.Timeout;
      fire: () => void;
    }> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(callback, delay, ...args);
      if (delay !== undefined && delay > 1_000_000) {
        chunks.push({
          delay,
          timer,
          fire: () => {
            clearTimeout(timer);
            callback(...args);
          },
        });
      }
      return timer;
    }) as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const running = f.run();
    await waitForFile(path.join(f.root, 'waiting-ready'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.delay).toBe(2 ** 31 - 1);
    expect(chunks[0]!.timer.hasRef()).toBe(false);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2 ** 31 - 1);
    chunks[0]!.fire();
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.delay).toBeGreaterThan(800_000_000);
    expect(chunks[1]!.delay).toBeLessThan(900_000_000);
    expect(cleanups).toHaveLength(0);
    clock.mockReturnValue(now + 3_000_000_000);
    chunks[1]!.fire();
    expect(await running).toMatchObject({
      ok: false,
      reason: expect.stringContaining("wasn't ready within 3000000 s"),
    });
    expect(chunks).toHaveLength(2);
    expect(cleared).toHaveBeenCalledWith(chunks[1]!.timer);
    expect(cleanups).toHaveLength(1);
    expect((await f.calls()).map(stage)).not.toContain('worker');
    expect(liveContainers()).toEqual([]);
  });

  it('bounds a blocked readiness command with the existing readyTimeout', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_READY', '1');
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      readyTimeout: '1',
      runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("wasn't ready within 1 s"),
    });
    expect(cleanups).toHaveLength(1);
    expect((await f.calls()).map(stage)).not.toContain('worker');
  });

  it('detects a supervised early exit promptly without echoing private diagnostics', async () => {
    vi.stubEnv('RUNTIME_DOCKER_DESKTOP', 'exited');
    const cleanups: DockerRuntimeContext[] = [];
    const f = await fixture({
      keep: 'always',
      runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({
      ok: false,
      reason: expect.stringContaining('exited with status 23'),
    });
    expect(vi.mocked(sleep).mock.calls.some(([delay]) => delay === 3000)).toBe(
      false
    );
    expect(JSON.stringify(outcome)).not.toContain(opaque);
    const calls = await f.calls();
    expect(
      calls.some(
        (call) => call.args.includes('tail') || call.args[0] === 'logs'
      )
    ).toBe(false);
    expect(
      calls.map(stage).filter((value) => value === 'cleanup')
    ).toHaveLength(1);
    expect(calls.map(stage).filter((value) => value === 'rm')).toHaveLength(1);
    expect(cleanups).toHaveLength(1);
    expect(calls.map(stage)).not.toContain('rename');
  });

  it.each(['starting', 'ready-then-block'])(
    'cancels readiness in state %s without copying a bundle or starting a worker',
    async (mode) => {
      vi.stubEnv('RUNTIME_DOCKER_READY_MODE', mode);
      const cleanups: DockerRuntimeContext[] = [];
      const f = await fixture({
        runtime: { inference: 'plugin', prepareRuntime: preparation(cleanups) },
      });
      const poll = observeReadinessPoll();
      const running = f.run();
      let waiting: AbortSignal | undefined;
      if (mode === 'starting') waiting = await poll;
      else await waitForFile(path.join(f.root, 'readiness-output'));
      f.controller.abort();
      const outcome = await running;
      expect(outcome).toMatchObject({ ok: false, cancelled: true });
      expect(outcome.reason).toContain('The run was cancelled.');
      expect(waiting?.aborted).toBe(mode === 'starting' ? true : undefined);
      expect(
        vi.mocked(sleep).mock.calls.filter(([delay]) => delay === 3000)
      ).toHaveLength(mode === 'starting' ? 1 : 0);
      const calls = await f.calls();
      expect(calls.filter((call) => stage(call) === 'ready')).toHaveLength(1);
      expect(calls.map(stage)).not.toContain('cp');
      expect(calls.map(stage)).not.toContain('worker');
      expect(calls.some((call) => call.args[0] === 'inspect')).toBe(false);
      expect(cleanups).toHaveLength(1);
    }
  );

  it('retains default readiness cancellation wording and clears its long deadline', async () => {
    vi.stubEnv('RUNTIME_DOCKER_READY_MODE', 'starting');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const f = await fixture({
      definition: dockerRunner,
      readyTimeout: '5000000',
    });
    const poll = observeReadinessPoll();
    const running = f.run();
    const waiting = await poll;
    f.controller.abort();
    expect(waiting.aborted).toBe(true);
    expect(await running).toMatchObject({
      ok: false,
      cancelled: true,
      reason: expect.stringContaining('The run was cancelled.'),
    });
    const deadlineIndex = timers.mock.calls.findIndex(
      ([, delay]) => delay === 2 ** 31 - 1
    );
    expect(deadlineIndex).toBeGreaterThanOrEqual(0);
    expect(cleared).toHaveBeenCalledWith(
      timers.mock.results[deadlineIndex]!.value
    );
  });

  it('kills a channel command when its stdin iterator throws', async () => {
    vi.stubEnv('RUNTIME_DOCKER_WAIT_STDIN', '1');
    let exit: number | undefined;
    const f = await fixture({
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          const child = context.channel.exec(['channel-probe'], {
            signal: context.signal,
            stdin: (async function* () {
              yield opaque;
              await waitForFile(path.join(f.root, 'channel-probe-started'));
              throw new Error(opaque);
            })(),
          });
          await Promise.all([drain(child.stdout), drain(child.stderr)]);
          exit = await child.exit;
          return async () => {};
        },
      },
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(exit).not.toBe(0);
    expect(JSON.stringify(await f.calls())).not.toContain(opaque);
  });

  it('settles channel spawn errors without an unhandled error or stale listener', async () => {
    let exit: number | undefined;
    let listeners = -1;
    const f = await fixture({
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          vi.stubEnv('MST_DOCKER', path.join(f.root, 'missing-executable'));
          try {
            const child = context.channel.exec(['channel-probe'], {
              signal: context.signal,
              stdin: (async function* () {})(),
            });
            await Promise.all([drain(child.stdout), drain(child.stderr)]);
            exit = await child.exit;
            // A failed spawn emits close after error; await it before checking.
            await new Promise((resolve) => setImmediate(resolve));
            listeners = getEventListeners(context.signal, 'abort').length;
          } finally {
            vi.stubEnv('MST_DOCKER', cli);
          }
          return async () => {};
        },
      },
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(exit).toBe(-1);
    expect(listeners).toBe(0);
  });

  it('removes a completed channel command abort listener', async () => {
    let listeners = -1;
    const f = await fixture({
      runtime: {
        inference: 'plugin',
        async prepareRuntime(context) {
          await command(context, 'channel-probe');
          listeners = getEventListeners(context.signal, 'abort').length;
          return async () => {};
        },
      },
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(listeners).toBe(0);
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
    const calls = await f.calls();
    expect(calls.map(stage).filter(Boolean).slice(-2)).toEqual([
      'cleanup',
      'rm',
    ]);
    expect(calls.findIndex((call) => stage(call) === 'cleanup')).toBeLessThan(
      calls.findIndex((call) => call.args[0] === 'inspect')
    );
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
    expect((await f.calls()).some((call) => call.args[0] === 'inspect')).toBe(
      false
    );
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
      readyTimeout: '5000000',
      runtime: {
        inference: 'plugin',
        prepareRuntime: preparation(cleanups),
      },
    });
    const running = f.run();
    await waitForFile(path.join(f.root, 'waiting-ready'));
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
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        callback,
        delay === 30_000 ? 5 : delay,
        ...args
      )) as typeof setTimeout);
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
  });

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
    const interval = vi.spyOn(globalThis, 'setInterval');
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
    expect(interval.mock.calls.some(([, delay]) => delay === 240_000)).toBe(
      false
    );
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

  describe.each(['cowork', 'chatgpt'])(
    'real %s image shell on scratch paths',
    (client) => {
      async function imageFixture(containerRoot?: string) {
        const root =
          containerRoot ??
          (await fs.mkdtemp(path.join(os.tmpdir(), 'mst-runtime-image-')));
        if (!containerRoot) dirs.push(root);
        const bin = path.join(root, 'bin');
        await fs.mkdir(bin, { recursive: true });
        await fs.mkdir(path.join(root, 'dev'));
        for (const name of [
          'id',
          'install',
          'chown',
          'chmod',
          'setpriv',
          'seq',
          'Xvfb',
          'dbus-daemon',
          'gdbus',
          'gnome-keyring-daemon',
          'at-spi-bus-launcher',
          'restart-desktop',
        ])
          await fs.symlink(cli, path.join(bin, name));
        const source = fileURLToPath(
          new URL(
            `../../../docker/${client}-linux/bin/desktop-session`,
            import.meta.url
          )
        );
        const script = (await fs.readFile(source, 'utf8'))
          .replaceAll('/run/mst', path.join(root, 'run/mst'))
          .replaceAll('/dev/', `${root}/dev/`)
          .replaceAll('/home/mst', path.join(root, 'home/mst'))
          .replaceAll('/opt/cowork-vm', path.join(root, 'vm'))
          .replaceAll('/opt/mst/bin', bin)
          .replaceAll(
            '/usr/libexec/at-spi-bus-launcher',
            path.join(bin, 'at-spi-bus-launcher')
          )
          .replaceAll('/tmp/.X11-unix', path.join(root, 'x11'));
        const session = path.join(root, 'desktop-session');
        await fs.writeFile(session, script, { mode: 0o700 });
        if (client === 'cowork')
          await fs.copyFile(
            fileURLToPath(
              new URL(
                '../../../docker/cowork-linux/bin/base-settings.mjs',
                import.meta.url
              )
            ),
            path.join(bin, 'base-settings.mjs')
          );
        const env = {
          ...process.env,
          RUNTIME_DOCKER_ROOT: root,
          PATH: `${bin}:${process.env.PATH}`,
          HOME: path.join(root, 'home/mst'),
          DISPLAY: ':99',
          LANG: 'C',
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
          XDG_RUNTIME_DIR: `${root}/session`,
          GNOME_KEYRING_CONTROL: `${root}/keyring`,
          AT_SPI_BUS_ADDRESS: `unix:path=${root}/a11y`,
          MST_INFERENCE_GATEWAY_URL: '',
        };
        return {
          root,
          env,
          session,
          settings: path.join(root, 'run/mst/settings/managed-settings.json'),
          async shell(args: string[], overrides: NodeJS.ProcessEnv = {}) {
            return promisify(execFile)('bash', [session, ...args], {
              env: { ...env, ...overrides },
            });
          },
        };
      }

      it('--dirs-only creates directories without starting or initializing settings', async () => {
        const f = await imageFixture();
        const dockerfile = await fs.readFile(
          fileURLToPath(
            new URL(
              `../../../docker/${client}-linux/Dockerfile`,
              import.meta.url
            )
          ),
          'utf8'
        );
        expect(dockerfile).toContain('io.glean.mst.runtime-preparation="1"');
        await f.shell(['--dirs-only']);
        await expect(
          fs.access(path.join(f.root, 'run/mst/tokens'))
        ).resolves.toBeUndefined();
        await expect(fs.access(f.settings)).rejects.toThrow();
        expect(
          await fs.readFile(path.join(f.root, 'image-calls.jsonl'), 'utf8')
        ).not.toContain('setpriv');
      });

      it.each(['', 'https://mst.example/anthropic'])(
        'initializes before the hook and preserves prepared settings (gateway %j)',
        async (gateway) => {
          const f = await imageFixture();
          const env = { MST_INFERENCE_GATEWAY_URL: gateway };
          await f.shell(['--prepare'], env);
          if (client === 'cowork') {
            const base = JSON.parse(
              await fs.readFile(f.settings, 'utf8')
            ) as Record<string, unknown>;
            expect(base.inferenceGatewayBaseUrl).toBe(gateway || undefined);
          }
          const marker = path.join(f.root, 'run/mst/hook-marker');
          await fs.writeFile(marker, opaque);
          const prepared = {
            inferenceProvider: 'gateway',
            inferenceGatewayBaseUrl: 'https://plugin.example/anthropic',
            pluginMarker: opaque,
          };
          if (client === 'cowork')
            await fs.writeFile(f.settings, JSON.stringify(prepared));
          await f.shell(['--start-prepared'], env);
          expect(await fs.readFile(marker, 'utf8')).toBe(opaque);
          if (client === 'cowork')
            expect(JSON.parse(await fs.readFile(f.settings, 'utf8'))).toEqual(
              prepared
            );
        }
      );

      it('keeps normal startup initialization unchanged', async () => {
        const f = await imageFixture();
        await f.shell(['--prepare']);
        if (client === 'cowork')
          await fs.writeFile(
            f.settings,
            JSON.stringify({ pluginMarker: opaque })
          );
        await f.shell([]);
        if (client === 'cowork')
          expect(JSON.parse(await fs.readFile(f.settings, 'utf8'))).toEqual({});
        expect(
          await fs.readFile(path.join(f.root, 'image-calls.jsonl'), 'utf8')
        ).toContain('setpriv');
      });

      it.each(['symlinks', 'swap'])(
        'does not publish privileged writes through a planted %s',
        async (attack) => {
          const f = await imageFixture();
          await f.shell(['--prepare']);
          const victim = path.join(f.root, 'victim');
          await fs.writeFile(victim, 'root-owned-data');
          const before = await fs.readFile(
            path.join(f.root, 'image-calls.jsonl'),
            'utf8'
          );
          await f.shell(['--start-prepared'], {
            RUNTIME_IMAGE_ATTACK: attack,
          });
          expect(await fs.readFile(victim, 'utf8')).toBe('root-owned-data');
          await expect(
            fs.access(path.join(f.root, 'failed-victim'))
          ).rejects.toThrow();
          expect(
            await fs.readFile(
              path.join(f.root, 'run/mst-root/startup-exit'),
              'utf8'
            )
          ).toBe('0\n');
          expect(
            (await fs.stat(path.join(f.root, 'run/mst-root/startup-exit')))
              .mode & 0o777
          ).toBe(0o644);
          const imageCalls = (
            await fs.readFile(path.join(f.root, 'image-calls.jsonl'), 'utf8')
          )
            .trim()
            .split('\n')
            .map(
              (line) => JSON.parse(line) as { invoked: string; args: string[] }
            );
          expect(imageCalls).toContainEqual({
            invoked: 'install',
            args: [
              '-d',
              '-o',
              'root',
              '-g',
              'root',
              '-m',
              '0755',
              path.join(f.root, 'run/mst-root'),
            ],
          });
          // After preparation, root must not reinitialize mst-owned paths.
          expect(
            imageCalls
              .slice(before.trim().split('\n').length)
              .filter(
                (call) =>
                  ['install', 'chown', 'chmod'].includes(call.invoked) &&
                  call.args.some(
                    (arg) =>
                      arg.startsWith(path.join(f.root, 'run/mst/')) ||
                      arg.startsWith(path.join(f.root, 'home/mst/'))
                  )
              )
          ).toHaveLength(0);
        }
      );

      it('keeps the unprivileged prepared shell diagnostics private', async () => {
        const f = await imageFixture();
        await f.shell(['--prepare']);
        await expect(
          f.shell(['--prepared'], {
            RUNTIME_IMAGE_USER: '1',
            DISPLAY: undefined,
          })
        ).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
        const log = path.join(f.root, 'run/mst/session/startup.log');
        expect(await fs.readFile(log, 'utf8')).toContain(
          'DISPLAY: unbound variable'
        );
        expect((await fs.stat(log)).mode & 0o777).toBe(0o600);
      });

      it('records a privilege-transition exit without exposing diagnostics', async () => {
        const f = await imageFixture();
        await f.shell(['--prepare']);
        // Unset DISPLAY fails under set -u before setpriv or ready/failed markers.
        await expect(
          f.shell(['--start-prepared'], { DISPLAY: undefined })
        ).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
        expect(
          await fs.readFile(
            path.join(f.root, 'run/mst-root/startup-exit'),
            'utf8'
          )
        ).toBe('1\n');
        await expect(
          fs.access(path.join(f.root, 'run/mst/session/startup.log'))
        ).rejects.toThrow();
      });

      it.each([0, 1, 23, 127, 255])(
        'reports real shell exit %s through the exact readiness command before cleanup and removal',
        async (status) => {
          const cleanups: DockerRuntimeContext[] = [];
          const f = await fixture({
            client,
            keep: 'always',
            runtime: {
              inference: 'plugin',
              prepareRuntime: preparation(cleanups),
            },
          });
          const image = await imageFixture(
            path.join(f.root, 'containers/mst-runtime-test-1')
          );
          vi.stubEnv('RUNTIME_DOCKER_IMAGE_SESSION', image.session);
          vi.stubEnv('RUNTIME_DOCKER_IMAGE_ROOT', image.root);
          vi.stubEnv('RUNTIME_IMAGE_EXIT_CODE', String(status));
          vi.stubEnv('RUNTIME_IMAGE_DIAGNOSTIC', opaque);
          vi.stubEnv('RUNTIME_IMAGE_MARKERS', '1');
          const outcome = await f.run();
          expect(outcome).toMatchObject({
            ok: false,
            reason: expect.stringContaining(`exited with status ${status}`),
          });
          expect(JSON.stringify(outcome)).not.toContain(opaque);
          expect(
            vi.mocked(console.error).mock.calls.flat().join(' ')
          ).not.toContain(opaque);
          expect(cleanups).toHaveLength(1);
          const calls = await f.calls();
          expect(
            calls.map(stage).filter((value) => value === 'rm')
          ).toHaveLength(1);
          expect(calls.map(stage)).not.toContain('worker');
          expect(calls.map(stage)).not.toContain('rename');
          expect(await fs.readdir(path.join(f.root, 'containers'))).toEqual([]);
        }
      );

      if (client === 'cowork')
        it('seeds the VM bundle before the hook and does not rewrite hook-controlled bundle paths', async () => {
          const f = await imageFixture();
          const vm = path.join(f.root, 'vm');
          await fs.mkdir(vm);
          await fs.writeFile(path.join(vm, 'bundle'), 'bundle-sha');
          await fs.writeFile(path.join(vm, 'rootfs.zst'), 'compressed-image');
          await f.shell(['--prepare']);
          const bundle = path.join(
            f.root,
            'home/mst/.config/Claude-3p/vm_bundles/claudevm.bundle'
          );
          const origin = path.join(bundle, '.rootfs.zst.origin');
          expect(await fs.readlink(path.join(bundle, 'rootfs.zst'))).toBe(
            path.join(vm, 'rootfs.zst')
          );
          expect(await fs.readFile(origin, 'utf8')).toBe('bundle-sha');
          const victim = path.join(f.root, 'bundle-victim');
          await fs.writeFile(victim, 'root-owned-data');
          await fs.rm(origin);
          await fs.symlink(victim, origin);
          await f.shell(['--start-prepared']);
          expect(await fs.readFile(victim, 'utf8')).toBe('root-owned-data');
        });

      it('never echoes a secret-bearing startup diagnostic', async () => {
        const f = await imageFixture();
        await f.shell(['--prepare']);
        await expect(
          f.shell(['--start-prepared'], {
            RUNTIME_IMAGE_EXIT_CODE: '23',
            RUNTIME_IMAGE_DIAGNOSTIC: opaque,
          })
        ).rejects.toMatchObject({ code: 23, stdout: '', stderr: '' });
        expect(
          await fs.readFile(
            path.join(f.root, 'run/mst-root/startup-exit'),
            'utf8'
          )
        ).toBe('23\n');
        expect(
          await fs.readFile(
            path.join(f.root, 'run/mst/session/startup.log'),
            'utf8'
          )
        ).toContain(opaque);
      });
    }
  );
});
