import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { linuxCoworkPlatform } from './linux.js';
import { CoworkDriverError, CoworkHitlBudgetError } from './driver.js';
import type { EvalManifest } from '../evalManifest.js';

const child = vi.hoisted(() => ({
  exec: vi.fn(),
  payloads: [] as string[],
  responses: [] as Array<{ failed?: boolean; value?: unknown }>,
}));
vi.mock('node:child_process', () => ({ execFile: child.exec }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
let directory: string;
const session = {
  DISPLAY: ':1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake/session',
  ANTHROPIC_API_KEY: 'do-not-forward-secret',
};
const options = () => ({ deadlineAt: Date.now() + 10000, env: session });
const manifest: EvalManifest = {
  name: 'linux-contract',
  datasets: [],
  host: { type: 'cowork', options: { computerUseProvider: 'linux-desktop' } },
  servers: [
    {
      transport: 'http',
      label: 'glean',
      serverUrl: 'https://example.com/eval',
    },
  ],
};
const settings = {
  inferenceModels: [{ name: 'test-model' }],
  managedMcpServers: [
    { name: 'glean', transport: 'http', url: 'https://example.com/eval' },
  ],
  allowManagedMcpServersOnly: true,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'linux-driver-test-'));
  child.exec.mockReset();
  child.payloads.length = 0;
  child.responses.length = 0;
  child.exec.mockImplementation((_python, args, _options, callback) => ({
    stdin: {
      on: vi.fn(),
      end: (payload: string) => {
        child.payloads.push(payload);
        const response = child.responses.shift();
        const mode = args[args.indexOf('--mode') + 1];
        callback(
          response?.failed ? new Error('secret child diagnostic') : null,
          JSON.stringify(
            response?.value ?? {
              status:
                mode === 'probe'
                  ? 'ready'
                  : mode === 'submit'
                    ? 'submitted'
                    : 'hitl_checked',
              action_count: 1,
              duration_ms: 1,
            }
          )
        );
      },
    },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function prepare(value: unknown = settings) {
  const file = join(directory, 'settings.json');
  await writeFile(file, JSON.stringify(value));
  return linuxCoworkPlatform.prepare({
    manifest,
    model: 'test-model',
    env: { ...session, MST_COWORK_SETTINGS_FILE: file },
  });
}

describe('caller-owned Linux Cowork desktop', () => {
  it('only probes prepared settings and never changes or tears down the runtime', async () => {
    const lifecycle = await prepare();
    await lifecycle.dispose();
    expect(
      JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    ).toEqual(settings);
    expect(child.exec).toHaveBeenCalledOnce();
    expect(child.exec.mock.calls[0]![1]).toContain('probe');
  });
  it.each([
    { ...settings, inferenceModels: [{ name: 'wrong-model' }] },
    { ...settings, managedMcpServers: [] },
    {
      ...settings,
      managedMcpServers: [
        { name: 'glean', transport: 'http', url: 'https://wrong.example/eval' },
      ],
    },
    {
      ...settings,
      managedMcpServers: [
        { ...settings.managedMcpServers[0], toolPolicy: { '*': 'allow' } },
      ],
    },
  ])(
    'fails before UI when prepared settings do not match the manifest',
    async (value) => {
      await expect(prepare(value)).rejects.toThrow('settings do not match');
      expect(child.exec).not.toHaveBeenCalled();
    }
  );
  it('does not perform caller-owned recovery', async () => {
    await expect(linuxCoworkPlatform.recover()).rejects.toThrow(
      'runtime owner'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('passes the exact prompt over stdin and reports no imaginary planner usage', async () => {
    const prompt = '  Unicode 中文\nsecond line  ';
    const result = await linuxCoworkPlatform.submit(prompt, options());
    expect(child.payloads).toEqual([JSON.stringify({ prompt })]);
    expect(child.exec.mock.calls[0]![1]).not.toContain(prompt);
    expect(child.exec.mock.calls[0]![2].env).not.toHaveProperty(
      'ANTHROPIC_API_KEY'
    );
    expect(result).toMatchObject({
      status: 'submitted',
      telemetry: {
        driver: 'linux-desktop',
        planner: { status: 'not-applicable' },
        cost: { status: 'not-applicable' },
      },
    });
    expect(result.telemetry).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('model');
  });
  it('does not retry an uncertain submission or expose raw errors', async () => {
    child.responses.push({
      failed: true,
      value: {
        status: 'failed',
        action_count: 1,
        duration_ms: 2,
        secret: 'do-not-forward-secret',
      },
    });
    await expect(
      linuxCoworkPlatform.submit('query', options())
    ).rejects.toThrow('no retry');
    expect(child.exec).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 'submitted', action_count: -1, duration_ms: 1 },
    { status: 'submitted', action_count: 1, duration_ms: 'bad' },
  ])('rejects malformed receipts', async (value) => {
    child.responses.push({ value });
    await expect(
      linuxCoworkPlatform.submit('query', options())
    ).rejects.toBeInstanceOf(CoworkDriverError);
    expect(child.exec).toHaveBeenCalledOnce();
  });
  it('does not launch a process after its deadline', async () => {
    await expect(
      linuxCoworkPlatform.submit('query', { ...options(), deadlineAt: 0 })
    ).rejects.toThrow('deadline');
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('skips approvals once the bound native session completes', async () => {
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete: async () => true,
    });
    expect(result.action_count).toBe(0);
    expect(child.exec).not.toHaveBeenCalled();
  });
  it('checks only approvals until native completion and respects the action budget', async () => {
    const isComplete = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const result = await linuxCoworkPlatform.handleHitl({
      ...options(),
      isComplete,
      approveWriteTools: true,
    });
    expect(result.action_count).toBe(1);
    expect(child.payloads).toEqual([
      JSON.stringify({ approveWriteTools: true }),
    ]);
    expect(child.exec.mock.calls[0]![1]).toContain('hitl');
    await expect(
      linuxCoworkPlatform.handleHitl({
        ...options(),
        maxActions: 1,
        isComplete: async () => false,
      })
    ).rejects.toBeInstanceOf(CoworkHitlBudgetError);
  });
  it('refuses unbound HITL', async () => {
    await expect(linuxCoworkPlatform.handleHitl(options())).rejects.toThrow(
      'bound native'
    );
    expect(child.exec).not.toHaveBeenCalled();
  });
});
