import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoworkPlatform } from './platform.js';
import {
  CoworkDriverError,
  CoworkHitlBudgetError,
  type CoworkDriverOptions,
  type SemanticDesktopTelemetry,
} from './driver.js';

const SESSION_ENV = [
  'PATH',
  'HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'LANG',
  'LC_ALL',
];
interface Receipt {
  status: 'ready' | 'submitted' | 'hitl_checked' | 'failed';
  action_count: number;
  duration_ms: number;
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error('Invalid prepared settings file.');
    return JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

function telemetry(
  started: number,
  actions: number,
  accounting: 'complete' | 'partial'
): SemanticDesktopTelemetry {
  return {
    driver: 'linux-desktop',
    accounting,
    duration_ms: Math.max(0, Date.now() - started),
    action_count: actions,
    planner: { status: 'not-applicable' },
    cost: { status: 'not-applicable' },
  };
}

function receipt(stdout: string): Receipt | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const r = parsed as Record<string, unknown>;
    if (
      !['ready', 'submitted', 'hitl_checked', 'failed'].includes(
        String(r.status)
      ) ||
      typeof r.action_count !== 'number' ||
      !Number.isSafeInteger(r.action_count) ||
      r.action_count < 0 ||
      typeof r.duration_ms !== 'number' ||
      !Number.isFinite(r.duration_ms) ||
      r.duration_ms < 0
    )
      return undefined;
    return {
      status: r.status as Receipt['status'],
      action_count: r.action_count,
      duration_ms: r.duration_ms,
    };
  } catch {
    return undefined;
  }
}

async function execute(
  mode: 'probe' | 'submit' | 'hitl',
  payload: object,
  options: CoworkDriverOptions
): Promise<Receipt> {
  const started = Date.now();
  const remaining = options.deadlineAt - started;
  if (remaining <= 0)
    throw new CoworkDriverError(
      'Linux desktop deadline exceeded; no action attempted.'
    );
  const env = { ...process.env, ...options.env };
  if (!env.DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS)
    throw new CoworkDriverError(
      'Linux Cowork requires a prepared DISPLAY and D-Bus desktop session.'
    );
  const script = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  ).resolve('@gleanwork/mcp-server-tester/cowork-linux-runtime');
  const timeout = Math.min(remaining, mode === 'submit' ? remaining : 10_000);
  const result = await new Promise<{ failed: boolean; stdout: string }>(
    (resolve) => {
      const child = execFile(
        env.MST_COWORK_PYTHON ?? 'python3',
        [
          script,
          '--mode',
          mode,
          '--timeout-ms',
          String(Math.max(1, Math.floor(timeout))),
          '--max-actions',
          String(options.maxActions ?? 24),
        ],
        {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          env: {
            ...Object.fromEntries(
              SESSION_ENV.flatMap((k) => (env[k] ? [[k, env[k]]] : []))
            ),
            NO_AT_BRIDGE: '0',
          },
        },
        (error, stdout) =>
          resolve({ failed: error !== null, stdout: String(stdout) })
      );
      child.stdin?.on('error', () => {
        /* execFile reports child failure; never retry a write. */
      });
      child.stdin?.end(JSON.stringify(payload));
    }
  );
  const record = receipt(result.stdout);
  const expected =
    mode === 'probe'
      ? 'ready'
      : mode === 'submit'
        ? 'submitted'
        : 'hitl_checked';
  if (
    result.failed ||
    record?.status !== expected ||
    record.action_count > (options.maxActions ?? 24)
  )
    throw new CoworkDriverError(
      `Linux desktop ${mode} failed or its receipt was uncertain; no retry attempted.`,
      record ? telemetry(started, record.action_count, 'partial') : undefined
    );
  return record;
}

/** Attach to caller-owned resources. Never create, authenticate, or stop a desktop. */
export const linuxCoworkPlatform: CoworkPlatform = {
  dataDirectory: (options) =>
    options.dataDir ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'Claude-3p',
      'local-agent-mode-sessions'
    ),
  async prepare({ manifest, env, model }) {
    const settingsFile =
      env.MST_COWORK_SETTINGS_FILE ??
      '/etc/claude-desktop/managed-settings.json';
    if (!isAbsolute(settingsFile))
      throw new Error('Linux Cowork settings path must be absolute.');
    try {
      const settings = await readSettings(settingsFile);
      const models = settings.inferenceModels as
        | Array<{ name?: string }>
        | undefined;
      if (model && !models?.some((m) => m.name === model))
        throw new Error('model');
      const expected = manifest.servers ?? [];
      const actual = settings.managedMcpServers as
        | Array<{
            name?: string;
            transport?: string;
            url?: string;
            toolPolicy?: Record<string, string>;
          }>
        | undefined;
      if (
        !Array.isArray(actual) ||
        actual.length !== expected.length ||
        settings.allowManagedMcpServersOnly !== true
      )
        throw new Error('servers');
      for (const [index, server] of expected.entries()) {
        if (server.transport !== 'http') throw new Error('transport');
        const observed = actual.find(
          (s) => s.name === (server.label ?? `server-${index + 1}`)
        );
        if (
          !observed ||
          observed.transport !== 'http' ||
          observed.url !== server.serverUrl
        )
          throw new Error('server');
        if (
          observed.toolPolicy?.['*'] === 'allow' &&
          manifest.coworkSetup?.approveWriteTools !== true
        )
          throw new Error('policy');
      }
    } catch {
      throw new Error(
        'Prepared Linux desktop settings do not match the eval model, MCP servers, or approval policy.'
      );
    }
    await execute(
      'probe',
      {},
      { deadlineAt: Date.now() + 15_000, maxActions: 1, env }
    );
    return {
      async dispose() {
        /* Caller owns desktop/profile/container lifecycle. */
      },
    };
  },
  async recover() {
    throw new Error(
      'Linux desktop recovery belongs to the runtime owner, not the MST driver.'
    );
  },
  async submit(query, options) {
    const started = Date.now();
    const result = await execute('submit', { prompt: query }, options);
    return {
      status: 'submitted',
      action_count: result.action_count,
      telemetry: telemetry(started, result.action_count, 'complete'),
    };
  },
  async handleHitl(options) {
    if (!options.isComplete)
      throw new Error('Linux HITL requires a bound native completion check.');
    const started = Date.now();
    let actions = 0;
    const budget = options.maxActions ?? 12;
    try {
      while (Date.now() < options.deadlineAt) {
        if (await options.isComplete())
          return {
            status: 'hitl_checked',
            action_count: actions,
            telemetry: telemetry(started, actions, 'complete'),
          };
        if (actions >= budget)
          throw new CoworkHitlBudgetError(
            'Linux HITL action budget exhausted.',
            telemetry(started, actions, 'partial')
          );
        const result = await execute(
          'hitl',
          { approveWriteTools: options.approveWriteTools === true },
          { ...options, maxActions: budget - actions }
        );
        actions += result.action_count;
        await delay(
          Math.min(500, Math.max(0, options.deadlineAt - Date.now()))
        );
      }
    } catch (error) {
      if (error instanceof CoworkHitlBudgetError) throw error;
      const partialActions =
        error instanceof CoworkDriverError
          ? (error.telemetry?.action_count ?? 0)
          : 0;
      throw new CoworkDriverError(
        'Linux HITL failed for the bound native session.',
        telemetry(started, actions + partialActions, 'partial')
      );
    }
    throw new CoworkDriverError(
      'Linux HITL deadline exceeded.',
      telemetry(started, actions, 'partial')
    );
  },
};
