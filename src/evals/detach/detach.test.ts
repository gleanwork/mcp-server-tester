import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetPluginsForTests } from '../../plugins/extensions.js';
import { fileRunStore } from '../runStore.js';
import { detach } from './launch.js';
import {
  coordinatorPaths,
  planCommands,
  readLine,
  runPlan,
  type CoordinatorChild,
} from './coordinate.js';
import {
  DetachPlanSchema,
  findDetachId,
  newDetachId,
  readStatus,
  shownState,
  writeStatus,
  type DetachPlan,
  type DetachStatus,
} from './status.js';
import {
  detachTestState,
  type DetachTestState,
} from '../../../tests/mocks/detachPlugin.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  delete (globalThis as { __detachTest?: DetachTestState }).__detachTest;
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-detach-test-'));
  dirs.push(dir);
  return dir;
}

function plan(overrides: Partial<DetachPlan> = {}): DetachPlan {
  return DetachPlanSchema.parse({
    format: 1,
    id: 'd20261020T120000Z-abc123',
    evalName: 'cowork',
    command: 'run',
    config: 'eval.json',
    env: 'acme/env/cloud-vm',
    envOptions: ['shards=20'],
    results: 'gs://bucket/evals',
    store: 'acme/credential-store/secrets',
    runArgs: ['--trials', '1'],
    noGrade: true,
    gradeEnv: true,
    resumes: 1,
    secrets: true,
    finish: ['delete-me'],
    createdAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  });
}

/** A fake `mst` that prints each command's scripted lines. */
function fakeMst(scripts: string[][]) {
  const calls: string[][] = [];
  let interrupted = 0;
  return {
    calls,
    interrupted: () => interrupted,
    mst(args: string[]): CoordinatorChild {
      calls.push(args);
      const lines = scripts.shift() ?? [];
      return {
        lines: (async function* () {
          for (const line of lines) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            yield line;
          }
        })(),
        exit: Promise.resolve(0),
        interrupt: () => (interrupted += 1),
      };
    },
  };
}

describe('detached run status', () => {
  it('names a detached run by time and a random end, and finds it by that end', async () => {
    const id = newDetachId(new Date('2026-10-20T12:34:56.789Z'));
    expect(id).toMatch(/^d20261020T123456Z-[0-9a-f]{6}$/);
    const store = fileRunStore(await tempDir());
    const status: DetachStatus = {
      format: 1,
      id,
      evalName: 'cowork',
      command: 'run',
      state: 'running',
      machine: 'vm',
      env: 'acme/env/cloud-vm',
      createdAt: '2026-10-20T12:34:56.789Z',
      updatedAt: '2026-10-20T12:34:56.789Z',
      collected: 3,
      graded: 0,
      lines: [],
    };
    await writeStatus(store, status);
    expect(await findDetachId(store, 'cowork', id.slice(-6))).toBe(id);
    expect(await readStatus(store, 'cowork', id)).toEqual(status);
    await expect(findDetachId(store, 'cowork', 'ffffff')).rejects.toThrow(
      /No detached run of cowork matches "ffffff"/
    );
  });

  it('shows a running coordinator that stopped reporting as lost', () => {
    const status = {
      state: 'running',
      updatedAt: '2026-10-20T12:00:00.000Z',
    } as DetachStatus;
    expect(shownState(status, Date.parse('2026-10-20T12:04:00.000Z'))).toBe(
      'running'
    );
    expect(shownState(status, Date.parse('2026-10-20T12:06:00.000Z'))).toBe(
      'lost'
    );
    expect(
      shownState(
        { ...status, state: 'done' },
        Date.parse('2026-10-20T13:00:00.000Z')
      )
    ).toBe('done');
  });
});

describe('the coordinator', () => {
  const paths = coordinatorPaths(
    '/opt/mst/detached/d20261020T120000Z-abc123',
    plan()
  );

  it('runs from the work directory its environment installed MST in', () => {
    expect(paths).toMatchObject({
      workDir: '/opt/mst',
      config: '/opt/mst/detached/d20261020T120000Z-abc123/eval.json',
      outputDir: '/opt/mst/detached/d20261020T120000Z-abc123/results',
    });
  });

  it('collects without grading, then resumes and grades with the same environment and stores', () => {
    const commands = planCommands(plan(), paths, '/dev/shm/x/secrets.json');
    const shared = [
      '--config',
      paths.config,
      '--output-dir',
      paths.outputDir,
      '--root-dir',
      '/opt/mst',
      '--loaded-datasets',
      '/opt/mst/detached/d20261020T120000Z-abc123/datasets.json',
      '--secrets-file',
      '/dev/shm/x/secrets.json',
      '--results',
      'gs://bucket/evals',
      '--env',
      'acme/env/cloud-vm',
    ];
    expect(commands.run).toEqual([
      'run',
      ...shared,
      '--env-option',
      'shards=20',
      '--store',
      'acme/credential-store/secrets',
      '--trials',
      '1',
      '--no-grade',
    ]);
    expect(commands.resume('/r/run1')).toEqual([
      'run',
      '--resume',
      '/r/run1',
      ...shared,
      '--env-option',
      'shards=20',
      '--store',
      'acme/credential-store/secrets',
    ]);
    // Grading needs no connector sign-ins.
    expect(commands.grade('run1')).toEqual([
      'grade',
      'run1',
      ...shared,
      '--env-option',
      'shards=20',
    ]);
    // `mst grade --detach --resume`: the coordinator's grade resumes too.
    const resumeGrade = planCommands(
      plan({ command: 'grade', run: 'run1.g3', runArgs: ['--resume'] }),
      paths,
      '/dev/shm/x/secrets.json'
    );
    expect(resumeGrade.grade('run1.g3')).toEqual([
      'grade',
      'run1.g3',
      ...shared,
      '--env-option',
      'shards=20',
      '--resume',
    ]);
  });

  it('reads progress and the run from what MST prints', () => {
    expect(readLine('[mst] shard 3/20: glean case-1 #1 collected')).toEqual({
      collected: true,
    });
    expect(
      readLine('[mst] grade shard 2/20: glean vs baseline case-1 graded')
    ).toEqual({ graded: true });
    expect(readLine('[mst] 2 trials are missing: the run is partial.')).toEqual(
      { partial: true }
    );
    expect(readLine('Output: /opt/mst/results/runs/r1')).toEqual({
      output: '/opt/mst/results/runs/r1',
    });
    expect(readLine('Eval complete: cowork')).toEqual({});
  });

  it('resumes a partial run once, grades it in the environment, then finishes its machine', async () => {
    const store = fileRunStore(await tempDir());
    const finished: string[][] = [];
    const log: string[] = [];
    const fake = fakeMst([
      [
        '[mst] shard 1/2: glean a #1 collected',
        '[mst] 1 trials are missing: the run is partial.',
        'Output: /opt/mst/results/runs/20261020T120100Z-aaaaaa',
      ],
      [
        '[mst] shard 1/1: glean b #1 collected',
        'Output: /opt/mst/results/runs/20261020T120100Z-aaaaaa',
      ],
      [
        '[mst] grade shard 1/2: glean vs baseline a graded',
        'Output: /opt/mst/results/runs/20261020T120100Z-aaaaaa.g1',
      ],
    ]);
    const status = await runPlan(plan(), paths, undefined, {
      store,
      machine: 'vm-1',
      mst: fake.mst,
      log: (line) => log.push(line),
      readLog: async () => log.join('\n'),
      finish: async (argv) => void finished.push([...argv]),
      heartbeatMs: 5,
      logUploadMs: 5,
    });
    expect(fake.calls.map((args) => args.slice(0, 2))).toEqual([
      ['run', '--config'],
      ['run', '--resume'],
      ['grade', '20261020T120100Z-aaaaaa'],
    ]);
    expect(status).toMatchObject({
      state: 'done',
      runId: '20261020T120100Z-aaaaaa',
      gradedRunId: '20261020T120100Z-aaaaaa.g1',
      collected: 2,
      graded: 1,
      missing: false,
    });
    expect(await readStatus(store, 'cowork', plan().id)).toMatchObject({
      state: 'done',
    });
    expect(
      String(await store.get(`cowork/detached/${plan().id}/log.txt`))
    ).toContain('glean b #1 collected');
    expect(finished).toEqual([['delete-me']]);
  });

  it('fails when a command writes no run, and still finishes its machine', async () => {
    const store = fileRunStore(await tempDir());
    const finished: string[][] = [];
    const fake = fakeMst([['mst: the eval config is invalid']]);
    const status = await runPlan(plan(), paths, undefined, {
      store,
      machine: 'vm-1',
      mst: fake.mst,
      log: () => {},
      readLog: async () => '',
      finish: async (argv) => void finished.push([...argv]),
    });
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(
      /mst run ended \(exit 0\) without writing a run/
    );
    expect(finished).toEqual([['delete-me']]);
  });

  it('stops the command under way when the run is cancelled', async () => {
    const store = fileRunStore(await tempDir());
    await store.put(`cowork/detached/${plan().id}/cancel`, 'now');
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let interrupted = 0;
    const status = await runPlan(plan(), paths, undefined, {
      store,
      machine: 'vm-1',
      mst: () => ({
        lines: (async function* () {
          await blocked;
          yield 'Output: /opt/mst/results/runs/20261020T120100Z-aaaaaa';
        })(),
        exit: blocked.then(() => 130),
        interrupt: () => {
          interrupted += 1;
          release();
        },
      }),
      log: () => {},
      readLog: async () => '',
      finish: async () => {},
      heartbeatMs: 5,
    });
    expect(interrupted).toBe(1);
    // The run it had collected is kept; nothing more runs.
    expect(status).toMatchObject({
      state: 'cancelled',
      runId: '20261020T120100Z-aaaaaa',
    });
    expect(status.gradedRunId).toBeUndefined();
  });
});

describe('--detach', () => {
  async function evalConfig(extra: Record<string, unknown> = {}) {
    const dir = await tempDir();
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({ name: 'cases', cases: [{ id: 'a', input: 'a' }] })
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'detached',
        plugins: [mock('detachPlugin.ts')],
        client: 'mst',
        datasets: ['./cases.json'],
        servers: {},
        ...extra,
      })
    );
    const secrets = path.join(dir, 'secrets.env');
    await fs.writeFile(secrets, 'JUDGE_KEY=k1\n');
    return { dir, configPath, secrets };
  }

  const base = {
    command: 'run' as const,
    env: 'detach/env/remote',
    envOptions: ['zone=us-central1-a'],
    results: 'detach/result-store/memory',
    runArgs: ['--trials', '1'],
    noGrade: false,
    gradeEnv: true,
    log: () => {},
  };

  it('sends the coordinator machine its plan and eval config, and its secrets over the channel', async () => {
    const f = await evalConfig();
    const result = await detach({
      ...base,
      configPath: f.configPath,
      rootDir: f.dir,
      secretsFile: f.secrets,
    });
    const state = detachTestState();
    expect(result.machine).toBe(`coordinator-${result.id}`);
    expect(state.coordinatorOptions).toEqual({ zone: 'us-central1-a' });
    expect(state.remoteDir).toBe(`/opt/mst/detached/${result.id}`);
    expect(state.argv).toEqual([
      'node',
      '/opt/mst/node_modules/.bin/mst',
      'coordinate',
      '--bundle',
      `/opt/mst/detached/${result.id}`,
    ]);
    // Secrets go over stdin only: never in the bundle.
    expect(state.stdin).toEqual([
      `${JSON.stringify({ secrets: { JUDGE_KEY: 'k1' } })}\n`,
    ]);
    expect([...state.sent.keys()].sort()).toEqual([
      'datasets.json',
      'detach.json',
      'eval.json',
    ]);
    // Loaded here: the coordinator machine needs no dataset credentials.
    const datasets = JSON.parse(state.sent.get('datasets.json')!) as Array<{
      cases: Array<{ id: string }>;
    }>;
    expect(datasets.map((d) => d.cases.map((c) => c.id))).toEqual([['a']]);
    expect(state.sent.get('detach.json')).not.toContain('k1');
    const sentPlan = DetachPlanSchema.parse(
      JSON.parse(state.sent.get('detach.json')!)
    );
    expect(sentPlan).toMatchObject({
      evalName: 'detached',
      env: 'detach/env/remote',
      noGrade: true,
      gradeEnv: true,
      resumes: 1,
      secrets: true,
      finish: ['delete-me'],
    });
    const status = JSON.parse(
      String(state.objects.get(`detached/detached/${result.id}/status.json`))
    ) as DetachStatus;
    expect(status).toMatchObject({
      state: 'starting',
      machine: result.machine,
    });
  });

  it('deletes the coordinator machine when the coordinator never starts', async () => {
    const f = await evalConfig();
    detachTestState().reply = 'mst: unknown command coordinate\n';
    await expect(
      detach({ ...base, configPath: f.configPath, rootDir: f.dir })
    ).rejects.toThrow(/The coordinator didn't start on coordinator-/);
    expect(detachTestState().disposed).toBe(1);
  });

  it('refuses a run that would still depend on this machine', async () => {
    const f = await evalConfig();
    const run = (overrides: Record<string, unknown>) =>
      detach({
        ...base,
        configPath: f.configPath,
        rootDir: f.dir,
        ...overrides,
      });
    await expect(run({ env: undefined })).rejects.toThrow(
      /--detach needs --env/
    );
    await expect(run({ results: 'file:/tmp/x' })).rejects.toThrow(
      /a result store other machines reach, not file:\/tmp\/x/
    );
    await expect(run({ results: undefined })).rejects.toThrow(
      /--detach needs a result store/
    );
    await expect(run({ plugins: ['./local.js'] })).rejects.toThrow(
      /can't take --plugins/
    );
  });

  it('needs a shared credential store for connector servers', async () => {
    const f = await evalConfig({
      servers: {
        slack: { connector: 'detach/connector/slack' },
      },
    });
    const run = (store?: string) =>
      detach({
        ...base,
        configPath: f.configPath,
        rootDir: f.dir,
        ...(store ? { store } : {}),
      });
    await expect(run()).rejects.toThrow(
      /a credential store the coordinator machine reaches/
    );
    await expect(run('detach/credential-store/local')).rejects.toThrow(
      /detach\/credential-store\/local isn't one/
    );
  });
});
