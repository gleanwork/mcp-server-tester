import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../../package.json' with { type: 'json' };
import { forkEnvironment } from '../../../tests/mocks/forkEnvironment.js';
import { machineEnvironment, runShardOverChannel } from './channel.js';
import {
  parseCoordinatorMessage,
  readClientResult,
  writeShardBundle,
  type ShardTokens,
} from './protocol.js';
import type { EvalConfig } from '../evalConfig.js';
import type {
  EnvironmentContext,
  ShardEvents,
  ShardProgress,
  ShardSpec,
  WorkerChannel,
} from '../evalFrameworkTypes.js';

const PLUGIN = fileURLToPath(
  new URL('../../../tests/mocks/shardTestPlugin.ts', import.meta.url)
);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-shard-'));
  dirs.push(dir);
  return dir;
}

interface RequestSpec {
  caseId: string;
  prompt: string;
  delayMs?: number;
}

/** A shard with a `probe` batch (run per case) and, optionally, a `batch` one. */
async function shardIn(
  root: string,
  probe: RequestSpec[],
  batch: RequestSpec[] = []
): Promise<ShardSpec> {
  const bundleDir = path.join(root, 'bundle');
  const request = (type: string) => (spec: RequestSpec) => ({
    caseId: spec.caseId,
    trial: 0,
    config: { type, delayMs: spec.delayMs ?? 0 },
    input: { prompt: spec.prompt, servers: [], env: { SECRET: 'leak' } },
  });
  await writeShardBundle(bundleDir, {
    runId: 'run-1',
    shard: { index: 0, count: 1 },
    mst: packageJson.version,
    plugins: [PLUGIN],
    evalConfig: { name: 'shard-test' } as EvalConfig,
    tokenServers: ['acme'],
    batches: [
      {
        variant: { name: 'baseline' },
        requests: probe.map(request('shard-test/client/probe')),
      },
      ...(batch.length
        ? [
            {
              variant: { name: 'candidate' },
              requests: batch.map(request('shard-test/client/batch')),
            },
          ]
        : []),
    ],
  });
  return {
    runId: 'run-1',
    index: 0,
    count: 1,
    bundleDir,
    resultsDir: path.join(root, 'results'),
  };
}

/** Events that record what the shard reported and hand out `tokens` in turn. */
function recorder(tokens: Array<() => ShardTokens>) {
  const progress: ShardProgress[] = [];
  const reasons: string[] = [];
  const events: ShardEvents = {
    progress: (event) => progress.push(event),
    async requestTokens({ reason }) {
      reasons.push(reason);
      return (tokens[reasons.length - 1] ?? tokens.at(-1)!)();
    },
  };
  return { events, progress, reasons };
}

const context = (
  keep: EnvironmentContext['keep'] = 'never'
): EnvironmentContext => ({ runId: 'run-1', shards: 1, keep });

describe('a shard in a child-process environment', () => {
  it('runs end to end, renewing a token mid-trial', async () => {
    const root = await tempDir();
    const tokensDir = path.join(root, 'tokens');
    const shard = await shardIn(
      root,
      [
        // Long enough for the first token to be renewed while it runs.
        { caseId: 'a', prompt: 'a', delayMs: 2500 },
        { caseId: 'flaky', prompt: 'flaky' },
      ],
      [{ caseId: 'b', prompt: 'b' }]
    );
    const { events, progress, reasons } = recorder([
      () => ({
        byServer: {
          acme: { accessToken: 'token-1', expiresAt: Date.now() + 2000 },
        },
        env: { API_KEY: 'key-1' },
      }),
      () => ({
        byServer: {
          acme: { accessToken: 'token-2', expiresAt: Date.now() + 3_600_000 },
        },
        env: { API_KEY: 'key-1' },
      }),
    ]);
    const environment = forkEnvironment(context(), root, {
      MST_TOKENS_DIR: tokensDir,
      MST_HEARTBEAT_MS: '200',
      // Ask again 1.5 s before expiry: about 0.5 s into case a.
      MST_TOKEN_RENEW_MS: '1500',
    });

    const outcome = await environment.runShard(
      shard,
      events,
      new AbortController().signal
    );

    expect(outcome).toEqual({
      ok: true,
      collected: 2,
      infra: 1,
      cancelled: false,
    });
    expect(reasons).toEqual(['start', 'expiring']);
    const a = await readClientResult(path.join(shard.resultsDir, '0/0.json'));
    expect(a.key).toEqual({ variant: 'baseline', caseId: 'a', trial: 0 });
    expect(a.result.finalText).toBe('a: token-1 then token-2; key key-1');
    // An error never carries a token.
    const flaky = await readClientResult(
      path.join(shard.resultsDir, '0/1.json')
    );
    expect(flaky.result).toMatchObject({
      error: 'ECONNRESET while using [REDACTED]',
    });
    // The batch client's result, reported as it finished.
    const b = await readClientResult(path.join(shard.resultsDir, '1/0.json'));
    expect(b.key).toEqual({ variant: 'candidate', caseId: 'b', trial: 0 });
    expect(b.result.finalText).toBe('b: token-2 then token-2; key key-1');

    expect(progress[0]).toEqual({
      type: 'hello',
      mst: packageJson.version,
      client: 'shard-test/client/probe',
    });
    expect(
      progress
        .filter((event) => event.type === 'trial')
        .map((event) => event.type === 'trial' && event.status)
    ).toEqual(['collected', 'infra', 'collected']);
    expect(progress.some((event) => event.type === 'heartbeat')).toBe(true);
    // Tokens are gone, the bundle never held the secrets, the machine is deleted.
    await expect(fs.stat(tokensDir)).rejects.toThrow();
    expect(
      await fs.readFile(path.join(shard.bundleDir, 'bundle.json'), 'utf8')
    ).not.toContain('leak');
    expect(environment.disposed).toEqual([false]);
  }, 30_000);

  it('stops after the trial in flight when cancelled, and keeps a failed machine', async () => {
    const root = await tempDir();
    const shard = await shardIn(
      root,
      ['a', 'b', 'c', 'd'].map((id) => ({
        caseId: id,
        prompt: id,
        delayMs: 700,
      }))
    );
    const controller = new AbortController();
    const { events, progress } = recorder([() => ({ byServer: {} })]);
    const wrapped: ShardEvents = {
      ...events,
      progress(event) {
        events.progress(event);
        if (event.type === 'trial') controller.abort();
      },
    };
    const environment = forkEnvironment(context('failed'), root, {
      MST_TOKENS_DIR: path.join(root, 'tokens'),
    });

    const outcome = await environment.runShard(
      shard,
      wrapped,
      controller.signal
    );

    expect(outcome).toMatchObject({
      ok: false,
      cancelled: true,
      reason: 'The shard was cancelled.',
    });
    expect(outcome.collected).toBeGreaterThanOrEqual(1);
    expect(outcome.collected).toBeLessThan(4);
    expect(progress.filter((event) => event.type === 'trial').length).toBe(
      outcome.collected
    );
    await expect(
      fs.stat(path.join(shard.resultsDir, '0/3.json'))
    ).rejects.toThrow();
    expect(environment.disposed).toEqual([true]);
  }, 30_000);
});

/** A channel whose worker prints `stdout` and then waits to be killed. */
function scriptedChannel(stdout: string[]): {
  channel: WorkerChannel;
  sent: string[];
} {
  const sent: string[] = [];
  const channel: WorkerChannel = {
    exec(_argv, { stdin, signal }) {
      void (async () => {
        for await (const line of stdin) sent.push(line);
      })();
      const killed = new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      return {
        stdout: (async function* () {
          for (const line of stdout) yield `${line}\n`;
          await killed;
        })(),
        stderr: (async function* () {})(),
        exit: killed.then(() => 137),
      };
    },
    async put() {},
    async get() {},
  };
  return { channel, sent };
}

const spec: ShardSpec = {
  runId: 'run-1',
  index: 0,
  count: 1,
  bundleDir: '/nowhere',
  resultsDir: '/nowhere',
};
const quiet: ShardEvents = {
  progress() {},
  async requestTokens() {
    return { byServer: {} };
  },
};

describe('runShardOverChannel', () => {
  it('fails a worker on another MST version at hello, and cancels it', async () => {
    const { channel, sent } = scriptedChannel([
      JSON.stringify({
        type: 'hello',
        protocol: 'mst.shard/v1',
        mst: '0.0.1',
        client: { name: 'cowork' },
      }),
    ]);
    const outcome = await runShardOverChannel(
      channel,
      spec,
      quiet,
      new AbortController().signal
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(
      `The worker runs MST 0.0.1, but this run uses ${packageJson.version}: install the same version in the worker's image.`
    );
    expect(sent.map((line) => parseCoordinatorMessage(line).type)).toEqual([
      'cancel',
    ]);
  });

  it('ends a worker that said done but stays alive, without failing it', async () => {
    const { channel } = scriptedChannel([
      JSON.stringify({
        type: 'done',
        collected: 3,
        infra: 0,
        cancelled: false,
        cleanup: 'ok',
      }),
    ]);
    const outcome = await runShardOverChannel(
      channel,
      spec,
      quiet,
      new AbortController().signal,
      { cancelGraceMs: 100, silenceMs: 50 }
    );
    expect(outcome).toEqual({
      ok: true,
      collected: 3,
      infra: 0,
      cancelled: false,
    });
  });

  it('fails a worker that goes silent', async () => {
    const { channel } = scriptedChannel([]);
    const outcome = await runShardOverChannel(
      channel,
      spec,
      quiet,
      new AbortController().signal,
      { silenceMs: 100 }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('its channel may be gone');
  });

  it('skips stray lines, and fails on a message outside the protocol', async () => {
    const { channel } = scriptedChannel([
      'a stray log line',
      JSON.stringify({ type: 'trial', key: 'nope' }),
    ]);
    const outcome = await runShardOverChannel(
      channel,
      spec,
      quiet,
      new AbortController().signal
    );
    expect(outcome.reason).toContain("isn't mst.shard/v1");
  });
});

describe('machineEnvironment', () => {
  it("reports a machine it couldn't create as the shard's outcome", async () => {
    const environment = machineEnvironment(context(), async () => {
      throw new Error('no capacity in us-west1-b');
    });
    expect(
      await environment.runShard(spec, quiet, new AbortController().signal)
    ).toEqual({
      ok: false,
      reason:
        "Couldn't create a machine for shard 1: no capacity in us-west1-b",
      collected: 0,
      infra: 0,
      cancelled: false,
    });
  });
});
