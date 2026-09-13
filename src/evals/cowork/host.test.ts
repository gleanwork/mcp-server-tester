import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import type {
  HostDefinition,
  HostRunContext,
  HostRunInput,
} from '../evalFrameworkTypes.js';
import { loadEvalDatasetFromObject } from '../datasetLoader.js';
import { runEvalDataset } from '../evalRunner.js';
import { hostTraceToExecution } from '../hostTrace.js';
import { createCoworkHost } from './host.js';
import {
  emitSession,
  temporaryDirectory,
} from './nativeFixtures.testSupport.js';
import type {
  CoworkCheckpoint,
  CoworkControl,
  CoworkCuaTransport,
  CoworkHostOptions,
  CoworkRunDiagnostics,
} from './types.js';
import { CoworkControlError } from './workflow.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  platform: () => 'darwin',
}));

const SERVERS: MCPConfig[] = [
  {
    transport: 'stdio',
    command: 'node',
    args: ['/synthetic/fixture.mjs'],
    label: 'fixture',
  },
];
const INPUT: HostRunInput = {
  scenario: 'Fetch the nonce.\nReturn the exact output.',
  servers: SERVERS,
};
const CONFIG = {
  type: 'cowork',
  timeout: 800,
  pollIntervalMs: 5,
  cleanupTimeoutMs: 2000,
};
const CONTEXT: HostRunContext = {
  manifest: { name: 'synthetic', datasets: [{ type: 'inline' }] },
};

async function fixture(
  options: {
    draft?: string;
    firstLine?: boolean;
    prefixLength?: number;
    unreadable?: boolean;
    route?: string;
    approval?: boolean;
    permissions?: boolean;
    preexisting?: boolean;
    pasteError?: boolean;
    fatalPaste?: boolean;
    pasteDelay?: number;
    launchDelay?: number;
    checkpointError?: boolean;
    lostAck?: boolean;
    noNative?: boolean;
    badNative?: boolean;
    ignoreQuit?: boolean;
  } = {}
) {
  const root = await temporaryDirectory();
  const receiptPath = join(root, 'armed.json');
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ops: string[] = [];
  const checkpoints: CoworkCheckpoint[] = [];
  const records: CoworkRunDiagnostics[] = [];
  let alive = false;
  let text = options.draft;
  let sent = 0;
  const cua: CoworkCuaTransport = {
    async call(name, args) {
      calls.push({ name, args });
      let data: Record<string, unknown>;
      switch (name) {
        case 'check_permissions':
          data = {
            accessibility: options.permissions !== false,
            screen_recording: true,
          };
          break;
        case 'list_apps':
          data = {
            apps: options.preexisting
              ? [{ name: 'Claude', pid: 99, running: true }]
              : [],
          };
          break;
        case 'launch_app':
          alive = true;
          if (options.launchDelay) await delay(options.launchDelay);
          data = { pid: 42 };
          break;
        case 'list_windows':
          data = {
            windows: [
              {
                pid: 42,
                window_id: 7,
                is_on_screen: true,
                bounds: { width: 1000, height: 700 },
              },
            ],
          };
          break;
        case 'press_key':
          expect(args).toMatchObject({
            pid: 42,
            window_id: 7,
            key: 'q',
            modifiers: ['cmd'],
          });
          if (!options.ignoreQuit) alive = false;
          data = {};
          break;
        case 'kill_app':
          expect(args).toEqual({ pid: 42 });
          alive = false;
          return { content: [{ type: 'text', text: 'terminated' }] };
        default:
          throw new Error(`unexpected lifecycle command ${name}`);
      }
      return { content: [], structuredContent: data } satisfies CallToolResult;
    },
  };
  const control: CoworkControl = {
    async openUrl(url) {
      ops.push('open');
      expect(url).toBe('claude://cowork/new');
    },
    async observe() {
      const value = options.unreadable
        ? undefined
        : options.prefixLength && text
          ? `${text.slice(0, options.prefixLength)}…`
          : options.firstLine
            ? text?.split('\n')[0]
            : text;
      return {
        pageUrl: options.route ?? 'https://claude.ai/new',
        composer: { value },
        automaticallyApprove: options.approval !== false,
      };
    },
    async paste(value) {
      ops.push('paste');
      if (options.pasteError)
        throw new CoworkControlError('paste refused', {
          fatal: options.fatalPaste === true,
        });
      text = value;
      if (options.pasteDelay) await delay(options.pasteDelay);
    },
    async setValue(value) {
      ops.push('setValue');
      text = value;
    },
    async pressReturn() {
      ops.push('return');
      await submit();
    },
    async clickSend() {
      ops.push('send');
      await submit();
    },
  };
  async function submit(): Promise<void> {
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({
      status: 'armed',
      pid: 42,
      windowId: 7,
    });
    sent++;
    if (!options.noNative)
      await emitSession(
        root,
        options.badNative ? text!.replace('exact', 'wrong') : text!
      );
    if (options.lostAck) throw new Error('acknowledgement lost');
  }
  const host = createCoworkHost({
    cua,
    dataDir: root,
    expectedServers: SERVERS,
    mcpServerPrefixes: { mcp__fixture__: 'fixture' },
    isProcessAlive: (pid) => {
      expect(pid).toBe(42);
      return alive;
    },
    createControl: () => control,
    async checkpoint(receipt) {
      if (options.checkpointError) throw new Error('disk unavailable');
      await writeFile(receiptPath, JSON.stringify(receipt), {
        flag: 'wx',
        mode: 0o600,
      });
      checkpoints.push(receipt);
    },
    record(record) {
      records.push(record);
    },
  });
  return {
    host,
    calls,
    ops,
    checkpoints,
    records,
    get alive() {
      return alive;
    },
    get sent() {
      return sent;
    },
    get text() {
      return text;
    },
  };
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  config = CONFIG,
  input = INPUT,
  context = CONTEXT
) {
  return f.host.run!(input, config, context);
}

describe('createCoworkHost: canonical run seam', () => {
  it('replaces retained draft, checkpoints once, emits only native events, and cleans exact PID', async () => {
    const f = await fixture({ draft: 'retained draft' });
    const trace = await run(f);
    expect(trace.error).toBeUndefined();
    expect(trace.finalText).toBe('NATIVE_NONCE');
    expect(trace.events).toEqual([
      {
        kind: 'tool_call',
        source: 'mcp',
        server: 'fixture',
        name: 'mcp__fixture__get_eval_nonce',
        id: 'call-one',
        arguments: {},
      },
    ]);
    expect(f.sent).toBe(1);
    expect(f.text).toContain(`${INPUT.scenario}\n\nMCP_SERVER_TESTER_COWORK_`);
    expect(f.checkpoints[0]).toMatchObject({
      inputMode: 'keyboard',
      verification: 'normalized-full',
    });
    expect(f.alive).toBe(false);
    expect('pass' in trace).toBe(false);
    expect(f.records[0]?.diagnostics?.fullPromptConfirmed).toBe(true);
  });

  it('leaves scoring to runEvalDataset using the canonical trace adapter', async () => {
    const f = await fixture();
    const result = await runEvalDataset(
      {
        dataset: loadEvalDatasetFromObject({
          name: 'synthetic',
          cases: [
            {
              id: 'scoring',
              mode: 'host',
              scenario: INPUT.scenario,
              expect: { containsText: ['DIFFERENT_NONCE'] },
            },
          ],
        }),
        async executeCase() {
          return hostTraceToExecution(await run(f), f.host.evidence!, SERVERS);
        },
      },
      {}
    );
    expect(result.failed).toBe(1);
    expect(result.caseResults[0]?.pass).toBe(false);
    expect(f.records[0]?.diagnostics?.complete).toBe(true);
  });

  it.each([undefined, 'retained'])(
    'does not require Home or an empty draft (%s)',
    async (draft) => {
      const f = await fixture({ draft });
      expect((await run(f)).error).toBeUndefined();
      expect(f.sent).toBe(1);
    }
  );

  it('supports first-line verification but requires the complete native prompt', async () => {
    const good = await fixture({ firstLine: true });
    expect((await run(good)).error).toBeUndefined();
    expect(good.checkpoints[0]?.verification).toBe('first-line');
    const wrong = await fixture({ firstLine: true, badNative: true });
    expect((await run(wrong)).error).toContain('metadata_prompt_mismatch');
    expect(wrong.sent).toBe(1);
  });

  it('accepts only sufficiently long AX prefixes', async () => {
    for (const prefixLength of [10, 160]) {
      const f = await fixture({ prefixLength });
      const trace = await run(f, CONFIG, {
        ...INPUT,
        scenario: 'Read the fixture nonce and return it. '.repeat(7),
      });
      expect(f.sent).toBe(prefixLength === 160 ? 1 : 0);
      if (prefixLength === 160) expect(trace.error).toBeUndefined();
      else expect(trace.error).toContain('composer did not contain');
    }
  });

  it('falls back only on a nonfatal paste failure', async () => {
    const safe = await fixture({ pasteError: true });
    expect((await run(safe)).error).toBeUndefined();
    expect(safe.ops).toContain('setValue');
    expect(safe.checkpoints[0]?.inputMode).toBe('accessibility');
    const denied = await fixture({ pasteError: true, fatalPaste: true });
    expect((await run(denied)).error).toContain('paste refused');
    expect(denied.ops).not.toContain('setValue');
    expect(denied.sent).toBe(0);
  });

  it.each([{ approval: false }, { route: 'https://claude.ai/cowork/old' }])(
    'refuses route/approval prerequisites without modifying draft',
    async (options) => {
      const f = await fixture({ ...options, draft: 'keep' });
      expect((await run(f, { ...CONFIG, timeout: 80 })).error).toContain(
        'pre_submit'
      );
      expect(f.text).toBe('keep');
      expect(f.sent).toBe(0);
      expect(f.alive).toBe(false);
    }
  );

  it.each([{ unreadable: true }, { checkpointError: true }])(
    'never submits after readback/checkpoint failure',
    async (options) => {
      const f = await fixture(options);
      expect((await run(f)).error).toContain('pre_submit');
      expect(f.sent).toBe(0);
      expect(f.alive).toBe(false);
    }
  );

  it('reconciles lost Return acknowledgement without a second Send', async () => {
    const f = await fixture({ lostAck: true });
    expect((await run(f)).error).toBeUndefined();
    expect(f.sent).toBe(1);
    expect(f.ops).not.toContain('send');
    expect(f.records[0]?.submitAcknowledgementError).toContain('lost');
  });

  it('does not grant a fresh execution budget after uncertain submission', async () => {
    const f = await fixture({ lostAck: true, noNative: true });
    expect((await run(f, { ...CONFIG, timeout: 60 })).error).toContain(
      'evidence'
    );
    expect(f.sent).toBe(1);
    expect(f.alive).toBe(false);
    expect(f.records[0]?.quarantined).toBe(false);
  });

  it.each([{ preexisting: true }, { permissions: false }])(
    'does not launch or touch preexisting/unpermitted apps',
    async (options) => {
      const f = await fixture(options);
      expect((await run(f)).error).toMatch(/preexisting_app|permissions/);
      expect(
        f.calls.some((c) =>
          ['launch_app', 'press_key', 'kill_app'].includes(c.name)
        )
      ).toBe(false);
      expect(f.ops).toEqual([]);
    }
  );

  it('rejects changed servers and per-run environment/auth/tool overrides before any control', async () => {
    const f = await fixture();
    const contexts: HostRunContext[] = [
      { ...CONTEXT, env: {} },
      {
        ...CONTEXT,
        manifest: { ...CONTEXT.manifest, auth: { token: 'secret' } },
      },
      {
        ...CONTEXT,
        manifest: {
          ...CONTEXT.manifest,
          toolOverrides: { id: 'x', tools: {} },
        },
      },
      { ...CONTEXT, mcpHostConfig: { provider: 'anthropic' } },
    ];
    for (const context of contexts)
      expect((await run(f, CONFIG, INPUT, context)).error).toMatch(
        /unsupported/
      );
    expect(
      (await run(f, CONFIG, { ...INPUT, env: { TOKEN: 'secret' } })).error
    ).toContain('environment');
    expect(
      (
        await run(f, CONFIG, {
          ...INPUT,
          servers: [{ ...SERVERS[0]!, env: { TOKEN: 'secret' } } as MCPConfig],
        })
      ).error
    ).toContain('unsupported servers');
    expect(f.calls).toEqual([]);
  });

  it('drains late launch acquisition and late workflow before releasing ownership', async () => {
    for (const options of [{ launchDelay: 75 }, { pasteDelay: 75 }]) {
      const f = await fixture(options);
      const result = await run(f, { ...CONFIG, timeout: 30 });
      expect(result.error).toContain('deadline');
      expect(f.alive).toBe(false);
      expect(f.sent).toBe(0);
      expect(f.records[0]?.quarantined).toBe(false);
    }
  });

  it('rejects another host definition while the same-runtime lease is held', async () => {
    const first = await fixture({ pasteDelay: 75 });
    const second = await fixture();
    const pending = run(first);
    expect((await run(second)).error).toContain('lease');
    expect(second.calls).toEqual([]);
    expect((await pending).error).toBeUndefined();
  });

  it('uses same-runtime exact-PID kill after cooperative quit does not exit', async () => {
    const f = await fixture({ ignoreQuit: true });
    expect(
      (await run(f, { ...CONFIG, cleanupTimeoutMs: 60 })).error
    ).toBeUndefined();
    expect(f.calls.find((c) => c.name === 'kill_app')?.args).toEqual({
      pid: 42,
    });
    expect(f.alive).toBe(false);
  });
});

describe('Cowork quarantine across timed-out operations', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function isolatedRuntime() {
    // Quarantine has no production reset. Give each test a fresh runtime lease
    // and module instance, without changing the lease captured by other tests.
    vi.stubGlobal(Symbol.for('mcp-server-tester.cowork-lease'), undefined);
    vi.resetModules();
    const { createCoworkHost: createHost } = await import('./host.js');
    const calls: string[] = [];
    const records: CoworkRunDiagnostics[] = [];
    let alive = false;
    const dependencies: CoworkHostOptions = {
      dataDir: '/synthetic/cowork',
      expectedServers: SERVERS,
      mcpServerPrefixes: { mcp__fixture__: 'fixture' },
      async checkpoint() {
        throw new Error('must not submit');
      },
      record(record) {
        records.push(record);
      },
      isProcessAlive: () => alive,
      evidence: {
        async snapshot() {
          return new Map();
        },
        async collect() {
          throw new Error('must not collect evidence');
        },
      },
      cua: {
        async call(name, args) {
          calls.push(name);
          let data: Record<string, unknown>;
          switch (name) {
            case 'check_permissions':
              data = { accessibility: true, screen_recording: true };
              break;
            case 'list_apps':
              data = { apps: [] };
              break;
            case 'launch_app':
              alive = true;
              data = { pid: 42 };
              break;
            case 'list_windows':
              data = {
                windows: [
                  {
                    pid: 42,
                    window_id: 7,
                    is_on_screen: true,
                    bounds: { width: 1000, height: 700 },
                  },
                ],
              };
              break;
            case 'get_window_state':
              data = {
                elements: [
                  { role: 'AXWebArea', url: 'https://claude.ai/new' },
                  { role: 'AXTextArea', value: 'retained draft' },
                  { role: 'AXPopUpButton', label: 'Automatically approve' },
                ],
              };
              break;
            case 'bring_to_front':
              data = {
                activated: true,
                pid: 42,
                window_id: 7,
                exact_window_effect: { verified: true },
              };
              break;
            case 'paste_text':
              await new Promise<void>((resolve) => setTimeout(resolve, 90));
              data = { effect: 'unverifiable', clipboard_restored: false };
              break;
            case 'press_key':
              expect(args).toMatchObject({ pid: 42, window_id: 7, key: 'q' });
              alive = false;
              data = {};
              break;
            default:
              throw new Error(`unexpected lifecycle command ${name}`);
          }
          return { content: [], structuredContent: data };
        },
      },
    };
    return {
      dependencies,
      createHost,
      calls,
      records,
      get alive() {
        return alive;
      },
    };
  }

  async function execute(host: HostDefinition) {
    return host.run!(INPUT, { ...CONFIG, timeout: 40 }, CONTEXT);
  }

  it('quarantines unknown launch ownership; neither this nor another definition may retry', async () => {
    const runtime = await isolatedRuntime();
    const call = runtime.dependencies.cua.call;
    runtime.dependencies.cua.call = async (name, args, timeoutMs) => {
      if (name === 'launch_app') {
        runtime.calls.push(name);
        return new Promise<CallToolResult>(() => {});
      }
      return call(name, args, timeoutMs);
    };
    const host = runtime.createHost(runtime.dependencies);
    vi.useFakeTimers();
    const pending = host.run!(
      INPUT,
      { ...CONFIG, timeout: 25, cleanupTimeoutMs: 40 },
      CONTEXT
    );
    await vi.advanceTimersByTimeAsync(66);
    expect((await pending).error).toContain('quarantine');
    expect(runtime.records[0]?.quarantined).toBe(true);
    const count = runtime.calls.length;
    expect((await execute(host)).error).toContain('lease');
    const other = runtime.createHost(runtime.dependencies);
    expect((await execute(other)).error).toContain('quarantined');
    expect(runtime.calls).toHaveLength(count);
  });

  it('retains quarantine when native paste fails after the execution deadline, cleans the app, and refuses retry', async () => {
    const runtime = await isolatedRuntime();
    const host = runtime.createHost(runtime.dependencies);
    vi.useFakeTimers();
    const pending = execute(host);
    await vi.advanceTimersByTimeAsync(41);
    expect(runtime.calls).toContain('paste_text');
    expect(runtime.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.error).toContain('deadline');
    expect(runtime.alive).toBe(false);
    const count = runtime.calls.length;
    const retry = execute(host);
    await vi.advanceTimersByTimeAsync(91);
    expect((await retry).error).toContain('quarantined');
    const other = execute(runtime.createHost(runtime.dependencies));
    await vi.advanceTimersByTimeAsync(91);
    expect((await other).error).toContain('quarantined');
    expect(runtime.calls).toHaveLength(count);
    expect(runtime.records[0]?.quarantined).toBe(true);
  });

  it.each([
    { source: 'caller', delayMs: 0 },
    { source: 'caller', delayMs: 90 },
    { source: 'another package copy', delayMs: 0 },
    { source: 'another package copy', delayMs: 90 },
  ])(
    'honors $source quarantine errors after $delayMs ms without a paste fallback',
    async ({ source, delayMs }) => {
      const runtime = await isolatedRuntime();
      const fallback = vi.fn(async () => {});
      runtime.dependencies.createControl = () => ({
        async openUrl() {},
        async observe() {
          return {
            pageUrl: 'https://claude.ai/new',
            composer: { value: 'retained draft' },
            automaticallyApprove: true,
          };
        },
        async paste() {
          if (delayMs)
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          // The static import belongs to a different module instance than this
          // runtime, as with separately loaded ESM/CJS package copies.
          throw source === 'caller'
            ? Object.assign(new Error('unsafe caller paste'), {
                fatal: false,
                quarantine: true,
              })
            : new CoworkControlError('unsafe cross-copy paste', {
                quarantine: true,
              });
        },
        setValue: fallback,
        async pressReturn() {
          throw new Error('must not submit');
        },
        async clickSend() {
          throw new Error('must not submit');
        },
      });
      const host = runtime.createHost(runtime.dependencies);
      vi.useFakeTimers();
      const pending = execute(host);
      await vi.advanceTimersByTimeAsync(91);
      const result = await pending;
      expect(result.error).toBeDefined();
      expect(runtime.alive).toBe(false);
      expect(runtime.records[0]?.quarantined).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
      const count = runtime.calls.length;
      expect((await execute(host)).error).toContain('quarantined');
      expect(
        (await execute(runtime.createHost(runtime.dependencies))).error
      ).toContain('quarantined');
      expect(runtime.calls).toHaveLength(count);
    }
  );

  it('refuses fatal paste errors from another package copy without quarantining safe cleanup', async () => {
    const runtime = await isolatedRuntime();
    let value = 'retained draft';
    const fallback = vi.fn(async (text: string) => {
      value = text;
    });
    const submit = vi.fn(async () => {});
    runtime.dependencies.checkpoint = vi.fn(async () => {});
    runtime.dependencies.evidence!.collect = async () => ({
      trace: { finalText: 'native result', events: [] },
      diagnostics: {
        evidence: 'structured',
        complete: true,
        fullPromptConfirmed: true,
      },
    });
    runtime.dependencies.createControl = () => ({
      async openUrl() {},
      async observe() {
        return {
          pageUrl: 'https://claude.ai/new',
          composer: { value },
          automaticallyApprove: true,
        };
      },
      async paste() {
        throw new CoworkControlError('fatal cross-copy refusal');
      },
      setValue: fallback,
      pressReturn: submit,
      clickSend: submit,
    });
    const host = runtime.createHost(runtime.dependencies);
    const result = await execute(host);
    expect(result.error).toBeDefined();
    expect(fallback).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(runtime.dependencies.checkpoint).not.toHaveBeenCalled();
    expect(runtime.records[0]?.quarantined).toBe(false);
    expect(runtime.alive).toBe(false);
    const callCount = runtime.calls.length;
    expect((await execute(host)).error).not.toContain('lease');
    expect(runtime.calls.length).toBeGreaterThan(callCount);
  });

  it.each(['setValue', 'pressReturn', 'clickSend'] as const)(
    'retains quarantine when the workflow handles a %s error',
    async (failedOperation) => {
      const runtime = await isolatedRuntime();
      let value = 'retained draft';
      const failure = Object.assign(new Error('uncertain control result'), {
        quarantine: true,
      });
      runtime.dependencies.checkpoint = async () => {};
      runtime.dependencies.evidence!.collect = async () => ({
        trace: { finalText: 'native result', events: [] },
        diagnostics: {
          evidence: 'structured',
          complete: true,
          fullPromptConfirmed: true,
        },
      });
      runtime.dependencies.createControl = () => ({
        async openUrl() {},
        async observe() {
          return {
            pageUrl: 'https://claude.ai/new',
            composer: { value },
            automaticallyApprove: true,
          };
        },
        async paste(text) {
          if (failedOperation !== 'pressReturn')
            throw new Error('safe paste failure');
          value = text;
        },
        async setValue(text) {
          if (failedOperation === 'setValue') throw failure;
          value = text;
        },
        async pressReturn() {
          throw failure;
        },
        async clickSend() {
          throw failure;
        },
      });
      const host = runtime.createHost(runtime.dependencies);
      vi.useFakeTimers();
      const pending = execute(host);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.error).toContain('quarantine');
      expect(runtime.alive).toBe(false);
      expect(runtime.records[0]?.quarantined).toBe(true);
      const count = runtime.calls.length;
      expect((await execute(host)).error).toContain('quarantined');
      expect(runtime.calls).toHaveLength(count);
    }
  );
});
