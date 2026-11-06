import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../../package.json' with { type: 'json' };
import { forkEnvironment } from '../../../tests/mocks/forkEnvironment.js';
import { startReadinessHttpServer } from '../../../tests/mocks/readyServers.js';
import { machineEnvironment, runShardOverChannel } from './channel.js';
import { collectShard } from './collect.js';
import {
  parseCoordinatorMessage,
  readClientResult,
  writeShardBundle,
  type ShardTokens,
} from './protocol.js';
import type { EvalConfig, EvalVariant } from '../evalConfig.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
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
  batch: RequestSpec[] = [],
  servers: MCPConfig[] = [],
  // The config's and the `candidate` variant's settings beyond their names.
  settings: {
    evalConfig?: Partial<EvalConfig>;
    candidate?: Partial<EvalVariant>;
  } = {}
): Promise<ShardSpec> {
  const bundleDir = path.join(root, 'bundle');
  const request = (type: string) => (spec: RequestSpec) => ({
    caseId: spec.caseId,
    trial: 0,
    config: { type, delayMs: spec.delayMs ?? 0 },
    input: { prompt: spec.prompt, servers, env: { SECRET: 'leak' } },
  });
  await writeShardBundle(bundleDir, {
    runId: 'run-1',
    shard: { index: 0, count: 1 },
    mst: packageJson.version,
    plugins: [PLUGIN],
    evalConfig: { ...settings.evalConfig, name: 'shard-test' } as EvalConfig,
    tokenServers: ['acme'],
    batches: [
      {
        variant: { name: 'baseline' },
        requests: probe.map(request('shard-test/client/probe')),
      },
      ...(batch.length
        ? [
            {
              variant: { ...settings.candidate, name: 'candidate' },
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
    work: 'collect',
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
  // The secrets file a coordinator sends: a short key, a credential, and a
  // setting that is not a secret.
  const secretsFile = {
    API_KEY: 'key-1',
    ACME_API_KEY: 'acme-key-0123456789',
    ACME_INSTANCE: 'acme-prod',
    ACME_SESSION: 'session-credential-0123',
  };
  // Its credential is in the secrets file under a name that doesn't say it
  // is one: a secret by use.
  // It serves tools, so MST's readiness check on the worker passes.
  let session: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    session = await startReadinessHttpServer();
  });
  afterAll(() => session.close());
  const sessionServer = (): MCPConfig => ({
    transport: 'http',
    label: 'session',
    serverUrl: session.url,
    auth: { accessTokenEnv: 'ACME_SESSION' },
  });

  it.each([
    { failClose: false, missingArtifacts: false, explicitEnding: false },
    { failClose: true, missingArtifacts: false, explicitEnding: false },
    { failClose: false, missingArtifacts: true, explicitEnding: false },
    { failClose: true, missingArtifacts: true, explicitEnding: false },
    // A client that typed its attempt a trial: MST's failure after it
    // still makes the attempt an infrastructure failure, not a failed trial.
    { failClose: false, missingArtifacts: false, explicitEnding: true },
    { failClose: true, missingArtifacts: false, explicitEnding: true },
    { failClose: false, missingArtifacts: true, explicitEnding: true },
    { failClose: true, missingArtifacts: true, explicitEnding: true },
  ])(
    'finalizes session cleanup without recopying temporary artifacts: %s',
    async ({ failClose, missingArtifacts, explicitEnding }) => {
      const root = await tempDir();
      const artifactDirectory = path.join(root, 'temporary-evidence');
      if (!missingArtifacts) {
        await fs.mkdir(artifactDirectory);
        await fs.writeFile(
          path.join(artifactDirectory, 'evidence.txt'),
          'captured before close'
        );
      }
      const bundleDir = path.join(root, 'bundle');
      await writeShardBundle(bundleDir, {
        runId: 'run-1',
        shard: { index: 0, count: 1 },
        mst: packageJson.version,
        plugins: [PLUGIN],
        evalConfig: { name: 'lifecycle', datasets: [] },
        tokenServers: [],
        batches: [
          {
            variant: { name: 'baseline' },
            requests: [
              {
                caseId: 'one',
                trial: 3,
                config: {
                  type: 'shard-test/client/lifecycle',
                  artifactDirectory,
                  failClose,
                  explicitEnding,
                },
                input: { prompt: 'one', servers: [] },
              },
            ],
          },
        ],
      });
      const shard: ShardSpec = {
        runId: 'run-1',
        index: 0,
        count: 1,
        work: 'collect',
        bundleDir,
        resultsDir: path.join(root, 'results'),
      };
      const { events } = recorder([() => ({ byServer: {} })]);
      const env = forkEnvironment(context(), root, {
        MST_TOKENS_DIR: path.join(root, 'tokens'),
      });
      const outcome = await env.runShard(
        shard,
        events,
        new AbortController().signal
      );
      const infrastructure = failClose || missingArtifacts;
      expect(outcome).toMatchObject({
        ok: true,
        collected: infrastructure ? 0 : 1,
        infra: infrastructure ? 1 : 0,
      });
      const result = await readClientResult(
        path.join(shard.resultsDir, '0/0.json')
      );
      expect(result.key).toEqual({
        variant: 'baseline',
        caseId: 'one',
        trial: 3,
      });
      expect(result.result.telemetry).toMatchObject({
        batchLifecycle: { closed: true },
      });
      if (infrastructure) {
        // The worker copies artifacts after the batch, so a cleanup failure
        // is the first of MST's failures: it stands, in ending and kind.
        expect(result.result.ending).toEqual({
          kind: 'infrastructure',
          broke: failClose ? 'client-app' : 'collection',
          retryable: true,
          reason: expect.stringContaining(
            failClose ? 'cleanup failed' : "Couldn't copy"
          ),
        });
        expect(result.result).toMatchObject({
          diagnostics: { failureKind: failClose ? 'cleanup' : 'artifacts' },
        });
      } else {
        expect(result.result.ending).toEqual(
          explicitEnding ? { kind: 'trial' } : undefined
        );
      }
      if (missingArtifacts) {
        expect(result.result.error).toContain("Couldn't copy");
        expect(result.result.artifacts).toBeUndefined();
      } else {
        expect(
          await fs.readFile(
            path.join(shard.resultsDir, '0/0.artifacts/evidence.txt'),
            'utf8'
          )
        ).toBe('captured before close');
        await expect(fs.stat(artifactDirectory)).rejects.toThrow();
      }
      if (failClose) expect(result.result.error).toContain('cleanup failed');
    }
  );

  it.each([false, true])(
    'saves artifact-free cleanup failures and correct counters (lifecycle: %s)',
    async (lifecycle) => {
      const root = await tempDir();
      const bundleDir = path.join(root, 'bundle');
      await writeShardBundle(bundleDir, {
        runId: 'run-1',
        shard: { index: 0, count: 1 },
        mst: packageJson.version,
        plugins: [PLUGIN],
        evalConfig: { name: 'cleanup', datasets: [] },
        tokenServers: [],
        batches: [
          {
            variant: { name: 'baseline' },
            requests: [
              {
                caseId: 'one',
                trial: 0,
                config: {
                  type: 'shard-test/client/lifecycle',
                  withoutLifecycle: !lifecycle,
                  failClose: true,
                },
                input: { prompt: 'ok', servers: [] },
              },
            ],
          },
        ],
      });
      const shard: ShardSpec = {
        runId: 'run-1',
        index: 0,
        count: 1,
        work: 'collect',
        bundleDir,
        resultsDir: path.join(root, 'results'),
      };
      // No token or secret text, and no artifacts: redaction and save both
      // retain the live result unless the early cache takes snapshots.
      const { events, progress } = recorder([() => ({ byServer: {} })]);
      const env = forkEnvironment(context(), root, {
        MST_TOKENS_DIR: path.join(root, 'tokens'),
      });
      const outcome = await env.runShard(
        shard,
        events,
        new AbortController().signal
      );
      const { result } = await readClientResult(
        path.join(shard.resultsDir, '0/0.json')
      );
      expect(result).toMatchObject({
        finalText: 'ok',
        events: [],
        error: 'cleanup failed',
        diagnostics: { failureKind: 'cleanup' },
        telemetry: {
          batchFailure: { kind: 'cleanup_failed', error: 'cleanup failed' },
        },
      });
      expect(result.artifacts).toBeUndefined();
      if (lifecycle)
        expect(result.telemetry).toMatchObject({
          batchLifecycle: { closed: true },
        });
      else expect(result.telemetry).not.toHaveProperty('batchLifecycle');
      expect(
        progress
          .filter((event) => event.type === 'trial')
          .map((event) => event.status)
      ).toEqual(['collected', 'infra']);
      expect(outcome).toMatchObject({ ok: true, collected: 0, infra: 1 });
    }
  );

  it("gives a client its variant's Cowork settings over the config's", async () => {
    const root = await tempDir();
    const shard = await shardIn(
      root,
      [],
      [{ caseId: 'a', prompt: 'cowork-setup' }],
      [],
      {
        evalConfig: {
          coworkSetup: {
            toolSearch: true,
            disabledBuiltinTools: ['WebSearch'],
          },
        },
        candidate: { coworkSetup: { toolSearch: false } },
      }
    );
    const { events } = recorder([() => ({ byServer: {}, env: {} })]);
    const outcome = await forkEnvironment(context(), root, {}).runShard(
      shard,
      events,
      new AbortController().signal
    );

    expect(outcome).toMatchObject({ ok: true, collected: 1 });
    const a = await readClientResult(path.join(shard.resultsDir, '1/0.json'));
    expect(JSON.parse(a.result.finalText)).toMatchObject({
      toolSearch: false,
      disabledBuiltinTools: ['WebSearch'],
    });
  });

  it('runs end to end, renewing a token mid-trial', async () => {
    const root = await tempDir();
    const tokensDir = path.join(root, 'tokens');
    const shard = await shardIn(
      root,
      [
        // Long enough for the first token to be renewed while it runs.
        { caseId: 'a', prompt: 'a', delayMs: 2500 },
        { caseId: 'flaky', prompt: 'flaky' },
        { caseId: 'thrown', prompt: 'thrown' },
      ],
      [{ caseId: 'b', prompt: 'b' }],
      [sessionServer()]
    );
    const { events, progress, reasons } = recorder([
      () => ({
        byServer: {
          acme: { accessToken: 'token-1', expiresAt: Date.now() + 2000 },
        },
        env: secretsFile,
      }),
      () => ({
        byServer: {
          acme: { accessToken: 'token-2', expiresAt: Date.now() + 3_600_000 },
        },
        env: secretsFile,
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
      infra: 2,
      cancelled: false,
    });
    expect(reasons).toEqual(['start', 'expiring']);
    const a = await readClientResult(path.join(shard.resultsDir, '0/0.json'));
    expect(a.key).toEqual({ variant: 'baseline', caseId: 'a', trial: 0 });
    // The tokens, reversed: the client read both, the second after renewal.
    expect(a.result.finalText).toBe('a: 1-nekot then 2-nekot; key 1-yek');
    // An error never carries a token, nor does the ending's reason.
    const flaky = await readClientResult(
      path.join(shard.resultsDir, '0/1.json')
    );
    // Nor a secrets file credential; a setting beside it stays.
    const flakyMessage =
      'ECONNRESET while using [REDACTED] for acme-prod with [REDACTED] via [REDACTED]';
    expect(flaky.result).toMatchObject({
      error: flakyMessage,
      ending: {
        kind: 'infrastructure',
        broke: 'network',
        reason: flakyMessage,
      },
    });
    expect(JSON.stringify(flaky)).not.toContain('acme-key-');
    expect(JSON.stringify(flaky)).not.toContain('session-credential-');
    expect(JSON.stringify(flaky)).not.toContain('token-');
    // A client that threw a network error: typed by its code, then redacted.
    const thrown = await readClientResult(
      path.join(shard.resultsDir, '0/2.json')
    );
    expect(thrown.result).toMatchObject({
      error: 'read ECONNRESET while using [REDACTED]',
      ending: {
        kind: 'infrastructure',
        broke: 'network',
        retryable: true,
        reason: 'read ECONNRESET while using [REDACTED]',
      },
    });
    expect(JSON.stringify(thrown)).not.toContain('token-');
    // The batch client's result, reported as it finished.
    const b = await readClientResult(path.join(shard.resultsDir, '1/0.json'));
    expect(b.key).toEqual({ variant: 'candidate', caseId: 'b', trial: 0 });
    expect(b.result.finalText).toBe('b: 2-nekot then 2-nekot; key 1-yek');

    // The worker says which OS it runs on: it decides how a desktop client runs.
    expect(progress[0]).toEqual({
      type: 'hello',
      mst: packageJson.version,
      platform: process.platform,
      client: 'shard-test/client/probe',
    });
    expect(
      progress
        .filter((event) => event.type === 'trial')
        .map((event) => event.type === 'trial' && event.status)
    ).toEqual(['collected', 'infra', 'infra', 'collected']);
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
  work: 'collect',
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
  it('starts mst grade-shard for a grade shard, copies back after each graded result, and reads its counts', async () => {
    const argvs: string[][] = [];
    let copies = 0;
    const { channel } = scriptedChannel([
      JSON.stringify({
        type: 'hello',
        protocol: 'mst.shard/v1',
        mst: packageJson.version,
        client: { name: 'grade' },
      }),
      JSON.stringify({
        type: 'graded',
        key: { kind: 'trial', variant: 'v', caseId: 'c', trial: 0 },
        status: 'graded',
        path: '0.json',
      }),
      JSON.stringify({
        type: 'graded',
        key: { kind: 'pairwise', candidate: 'v', caseId: 'c' },
        status: 'failed',
        path: '1.json',
      }),
      JSON.stringify({
        type: 'done',
        graded: 1,
        failed: 1,
        cancelled: false,
        cleanup: 'ok',
      }),
    ]);
    const exec = channel.exec.bind(channel);
    channel.exec = (argv, io) => {
      argvs.push(argv);
      return exec(argv, io);
    };
    channel.get = async () => {
      copies++;
    };
    const progress: string[] = [];
    const outcome = await runShardOverChannel(
      channel,
      { ...spec, work: 'grade' },
      { ...quiet, progress: (event) => progress.push(event.type) },
      new AbortController().signal,
      { cancelGraceMs: 10 }
    );
    expect(argvs[0]?.slice(0, 2)).toEqual(['mst', 'grade-shard']);
    expect(outcome).toMatchObject({ ok: true, graded: 1, failed: 1 });
    expect(progress).toEqual(['hello', 'graded', 'graded']);
    // After each graded result, and once at the end.
    expect(copies).toBe(3);
  });

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

describe('collectShard', () => {
  it('refuses a server label that would write outside the tokens directory', async () => {
    const root = await tempDir();
    const shard = await shardIn(root, [{ caseId: 'a', prompt: 'a' }]);
    let reply: ((line: string) => void) | undefined;
    const input = (async function* () {
      yield await new Promise<string>((resolve) => (reply = resolve));
    })();
    const run = collectShard({
      bundleDir: shard.bundleDir,
      resultsDir: shard.resultsDir,
      input,
      write: (line) => {
        if (line.includes('"need-tokens"'))
          reply?.(
            JSON.stringify({
              type: 'tokens',
              byServer: { '../escape': { accessToken: 'x' } },
            })
          );
      },
      env: { MST_TOKENS_DIR: path.join(root, 'tokens') },
    });
    await expect(run).rejects.toThrow('"../escape" can\'t name a token file.');
    await expect(fs.stat(path.join(root, 'escape'))).rejects.toThrow();
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

  it("puts what a failed shard's machine knows before the shard's reason", async () => {
    const diagnosed: string[] = [];
    const run = (diagnose: () => Promise<string | undefined>) =>
      machineEnvironment(
        context(),
        async () => ({
          id: 'machine-1',
          channel: scriptedChannel([]).channel,
          async diagnose() {
            diagnosed.push('asked');
            return diagnose();
          },
          async dispose() {
            diagnosed.push('disposed');
          },
        }),
        { silenceMs: 50 }
      ).runShard(spec, quiet, new AbortController().signal);
    const outcome = await run(async () => 'It ran out of memory.');
    expect(outcome.reason).toMatch(
      /^It ran out of memory\. The worker sent nothing for 0 s/
    );
    // Asked while the machine is still there to ask.
    expect(diagnosed).toEqual(['asked', 'disposed']);
    // Nothing known, or no answer: the shard's own reason.
    for (const diagnose of [
      async () => undefined,
      async () => Promise.reject(new Error('gone')),
    ])
      expect((await run(diagnose)).reason).toMatch(/^The worker sent nothing/);
  });

  it('notes what the machine knows about a finished shard with infrastructure failures', async () => {
    let asked = 0;
    const finish = (infra: number) =>
      machineEnvironment(
        context(),
        async () => ({
          id: 'machine-1',
          channel: scriptedChannel([
            JSON.stringify({
              type: 'done',
              collected: 2,
              infra,
              cancelled: false,
              cleanup: 'ok',
            }),
          ]).channel,
          async diagnose() {
            asked++;
            return 'It ran out of memory.';
          },
          async dispose() {},
        }),
        { cancelGraceMs: 10 }
      ).runShard(spec, quiet, new AbortController().signal);
    expect(await finish(1)).toMatchObject({
      ok: true,
      note: 'It ran out of memory.',
    });
    expect(asked).toBe(1);
    // A clean shard isn't asked.
    expect(await finish(0)).not.toHaveProperty('note');
    expect(asked).toBe(1);
  });
});
