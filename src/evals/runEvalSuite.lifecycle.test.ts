import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { registerDatasetSource, registerHost } from './frameworkRegistries.js';
import type { EvalCase } from './datasetTypes.js';
import type { DatasetConfig } from './evalManifest.js';
import type {
  HostDefinition,
  PreparedHostSession,
} from './evalFrameworkTypes.js';

const transport = vi.hoisted(() => ({
  connect: vi.fn(async () => ({})),
  close: vi.fn(async () => {}),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'OK' }] })),
  externalRun: vi.fn(async () => ({ success: true, finalText: 'OK' })),
}));
vi.mock('./externalHost/runtime.js', () => ({
  runExternalHostScenario: transport.externalRun,
}));
vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: transport.connect,
  closeMCPClient: transport.close,
}));
vi.mock('../mcp/fixtures/mcpFixture.js', () => ({
  createMCPFixture: () => ({ callTool: transport.callTool }),
}));

const dirs: string[] = [];
let sequence = 0;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});
function hostCase(id: string, extra: Partial<EvalCase> = {}): EvalCase {
  return { id, mode: 'host', scenario: id, ...extra };
}
function fakeHost(runOnly = false, maxConcurrency?: number) {
  const name = `lifecycle-host-${sequence++}`;
  const run = vi.fn<PreparedHostSession['run']>(async () => ({
    finalText: 'OK',
    events: [],
  }));
  const dispose = vi.fn<PreparedHostSession['dispose']>(async () => {});
  const prepareSession = vi.fn<NonNullable<HostDefinition['prepareSession']>>(
    async () => ({ run, dispose })
  );
  registerHost({
    name,
    schema: z.object({ model: z.string().default('default') }).passthrough(),
    run,
    prepareSession: runOnly ? undefined : prepareSession,
    maxConcurrency,
  });
  return { name, run, dispose, prepareSession };
}
async function fixture(
  host: string,
  datasets: EvalCase[][],
  extra: Record<string, unknown> = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-lifecycle-'));
  dirs.push(dir);
  const source = `lifecycle-source-${sequence++}`;
  const load = vi.fn(async (config: DatasetConfig) => ({
    name: `dataset-${String(config.slot)}`,
    cases: datasets[Number(config.slot)]!,
  }));
  registerDatasetSource({
    name: source,
    schema: z.object({ slot: z.number() }),
    load,
  });
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      name: 'lifecycle',
      host: { type: host },
      servers: [],
      datasets: datasets.map((_, slot) => ({ type: source, slot })),
      ...extra,
    })
  );
  return { load, options: { manifestPath, rootDir: dir } };
}
const server = { transport: 'http', serverUrl: 'https://example.com/eval' };
const direct: EvalCase = { id: 'direct', toolName: 'echo', args: {} };
const legacy = hostCase('legacy', {
  mode: 'external_host',
  externalHost: { driver: 'anthropic.claude.cowork.desktop-app.macos' },
});

it('prepares lazily once per arm and reuses across datasets, cases and iterations', async () => {
  const host = fakeHost();
  host.prepareSession.mockImplementation(async (input, config, context) => {
    const arm = context.arm!.name;
    expect(transport.close).toHaveBeenCalledTimes(
      host.prepareSession.mock.calls.length
    );
    expect(input.servers[0]).toMatchObject({ label: arm });
    expect(input.env).toBe(context.env);
    expect(context).not.toHaveProperty('secretsFile');
    expect(config.model).toBe(arm);
    return { run: host.run, dispose: host.dispose };
  });
  const f = await fixture(
    host.name,
    [
      [direct, hostCase('one', { iterations: 2, mode: 'mcp_host' })],
      [hostCase('two', { iterations: 2, host: { type: host.name } })],
    ],
    {
      arms: ['first', 'second'].map((name) => ({
        name,
        host: { type: host.name, model: name },
        servers: [{ ...server, label: name }],
      })),
    }
  );
  const result = await runEvalSuite(f.options);
  expect(result.summary.results.every((item) => item.pass)).toBe(true);
  expect(host.prepareSession).toHaveBeenCalledTimes(2);
  expect(host.run).toHaveBeenCalledTimes(8);
  expect(host.dispose).toHaveBeenCalledTimes(2);
  expect(host.dispose.mock.invocationCallOrder[0]).toBeLessThan(
    host.prepareSession.mock.invocationCallOrder[1]!
  );
});

it.each([true, false])(
  'does not prepare for dry/direct-only runs (dry: %s)',
  async (dryRun) => {
    const host = fakeHost(false, 1);
    const f = await fixture(host.name, [[dryRun ? hostCase('host') : direct]], {
      concurrency: 2,
      servers: [server],
    });
    await runEvalSuite({ ...f.options, dryRun });
    expect(host.prepareSession).not.toHaveBeenCalled();
    expect(host.dispose).not.toHaveBeenCalled();
    expect(transport.connect).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(f.load).toHaveBeenCalledTimes(dryRun ? 0 : 1);
  }
);

it.each([
  'concurrency',
  'config',
  'mcpHostConfig',
  'host',
  'prepared-override',
  'legacy',
  'legacy-override',
  'later-arm',
  'run-only-limit',
])(
  'preflights %s across all selected datasets/arms before execution',
  async (kind) => {
    const runOnly = [
      'prepared-override',
      'legacy-override',
      'later-arm',
      'run-only-limit',
    ].includes(kind);
    const base = fakeHost(runOnly, kind === 'run-only-limit' ? 1 : undefined);
    const other = fakeHost(kind === 'host');
    const cases = [[direct, hostCase('first')], [hostCase('second')]];
    const extra: Record<string, unknown> = { servers: [server] };
    let error = 'identical effective host configuration';
    if (kind === 'config')
      cases[1] = [
        hostCase('second', { host: { type: base.name, model: 'different' } }),
      ];
    if (kind === 'mcpHostConfig')
      cases[1] = [
        hostCase('second', { mcpHostConfig: { provider: 'anthropic' } }),
      ];
    if (['host', 'prepared-override', 'legacy-override'].includes(kind))
      cases[1] = [hostCase('second', { host: { type: other.name } })];
    if (kind.startsWith('legacy')) {
      cases[0] = [direct, legacy];
      error = 'Legacy external_host';
    }
    if (['concurrency', 'later-arm', 'run-only-limit'].includes(kind)) {
      extra.concurrency = 2;
      error = kind === 'run-only-limit' ? 'maxConcurrency 1' : 'concurrency: 1';
    }
    if (kind === 'later-arm')
      extra.arms = [
        { name: 'first' },
        { name: 'second', host: { type: other.name } },
      ];
    const f = await fixture(base.name, cases, extra);
    await expect(runEvalSuite(f.options)).rejects.toThrow(error);
    for (const host of [base, other]) {
      expect(host.prepareSession).not.toHaveBeenCalled();
      expect(host.run).not.toHaveBeenCalled();
    }
    expect(transport.connect).not.toHaveBeenCalled();
    expect(transport.externalRun).not.toHaveBeenCalled();
  }
);

it.each(['prepare', 'run', 'assertion', 'cleanup', 'run-and-cleanup'])(
  'handles %s failure without retrying preparation or suppressing cleanup errors',
  async (failure) => {
    const host = fakeHost();
    const error = new Error('execution failed');
    if (failure === 'prepare') host.prepareSession.mockRejectedValue(error);
    if (failure.startsWith('run')) host.run.mockRejectedValue(error);
    if (failure.includes('cleanup'))
      host.dispose.mockRejectedValue(new Error('cleanup failed'));
    const first = hostCase('one');
    if (failure !== 'assertion') first.iterations = 2;
    if (failure === 'assertion') first.expect = { matchesPattern: '[' };
    const f = await fixture(host.name, [[first], [hostCase('two')]]);
    const outcome = runEvalSuite(f.options);
    if (failure.includes('cleanup'))
      await expect(outcome).rejects.toThrow('cleanup failed');
    else if (failure === 'assertion')
      await expect(outcome).rejects.toBeInstanceOf(SyntaxError);
    else {
      const results = (await outcome).summary.results;
      expect(results.every((item) => !item.pass)).toBe(true);
      expect(results[0]?.error).toBe(error.message);
    }
    expect(host.prepareSession).toHaveBeenCalledTimes(1);
    // Preparation owns partial cleanup on rejection; only returned sessions dispose.
    expect(host.dispose).toHaveBeenCalledTimes(failure === 'prepare' ? 0 : 1);
    if (failure === 'prepare') expect(host.run).not.toHaveBeenCalled();
  }
);

it('preserves concurrent run-only overrides and legacy dispatch', async () => {
  const host = fakeHost(true);
  const other = fakeHost(true);
  const f = await fixture(
    host.name,
    [
      [legacy],
      [
        hostCase('one'),
        hostCase('two', {
          host: { type: other.name, model: 'override' },
        }),
      ],
    ],
    { concurrency: 2 }
  );
  await runEvalSuite(f.options);
  expect(host.run).toHaveBeenCalledTimes(1);
  expect(other.run.mock.calls[0]?.[1]).toMatchObject({ model: 'override' });
  expect(transport.externalRun).toHaveBeenCalledTimes(1);
  expect(host.prepareSession).not.toHaveBeenCalled();
  expect(other.prepareSession).not.toHaveBeenCalled();
});
