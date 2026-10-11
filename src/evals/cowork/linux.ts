import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { mcpServerLabel } from '../../config/mcpConfig.js';
import type { MarketplacePlugin } from '../clientPlugins.js';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoworkPlatform } from './platform.js';
import { transportServers } from '../evalConfig.js';
import {
  clientStdioFileContents,
  clientStdioServers,
  resolveClientStdioCredentials,
  resolveClientStdioServer,
  type ClientStdioPaths,
  type ClientStdioServer,
} from '../clientPlugins.js';
import {
  COWORK_HEADLESS_DISABLED_BUILTIN_TOOLS as HEADLESS_DISABLED,
  COWORK_MANAGED_ONLY,
  coworkHeadlessSettingsMatch,
  coworkJsonEqual,
  coworkManagedPluginSettings,
  coworkMcpSettingsMatch,
  coworkPluginSettingsMatch,
} from './managedSettings.js';

export {
  COWORK_HEADLESS_DISABLED_BUILTIN_TOOLS,
  COWORK_MANAGED_ONLY,
  coworkHeadlessSettings,
  coworkHeadlessSettingsMatch,
  coworkManagedPluginSettings,
  coworkMcpSettingsMatch,
  coworkPluginSettingsMatch,
} from './managedSettings.js';
import {
  CoworkDriverError,
  CoworkHitlBudgetError,
  CoworkUserQuestionError,
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
  'MST_COWORK_URL_OPENER',
  'LANG',
  'LC_ALL',
];
interface Receipt {
  status: 'ready' | 'submitted' | 'hitl_checked' | 'failed';
  action_count: number;
  duration_ms: number;
  errorCode?: string;
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

/** The settings file as it is, or undefined when there is none. */
async function readSettingsText(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error('Invalid prepared settings file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Replaces the settings file's content in place (its directory may be read-only). */
async function writeSettingsText(file: string, text: string): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o644
  );
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

/**
 * Managed settings for owned-desktop mode (ADR 0004): the image's own
 * settings, with the variant's servers, plugins and model in place of
 * whatever was there. An HTTP server keeps the image's `headersHelper` for
 * the same name and URL, since MST writes no secrets here. Exactly what
 * `prepare` then checks.
 */
function coworkLinuxOwnedSettings(
  base: Record<string, unknown>,
  options: {
    servers: readonly MCPConfig[];
    plugins?: readonly MarketplacePlugin[];
    paths?: ClientStdioPaths;
    approveWriteTools?: boolean;
    model?: string;
  }
): Record<string, unknown> {
  const managed = coworkManagedPluginSettings(options);
  const prior = Array.isArray(base.managedMcpServers)
    ? (base.managedMcpServers as Array<Record<string, unknown> | null>)
    : [];
  const http = options.servers.flatMap((server, index) => {
    if (server.transport !== 'http') return [];
    const name = mcpServerLabel(server, index);
    const helper = prior.find(
      (entry) =>
        entry?.name === name &&
        entry.transport === 'http' &&
        entry.url === server.serverUrl
    )?.headersHelper;
    return [
      {
        name,
        transport: 'http',
        url: server.serverUrl,
        ...(typeof helper === 'string' ? { headersHelper: helper } : {}),
        ...(options.approveWriteTools
          ? { toolPolicy: { '*': 'allow' as const } }
          : {}),
      },
    ];
  });
  const models = Array.isArray(base.inferenceModels)
    ? (base.inferenceModels as Array<{ name?: unknown } | null>)
    : [];
  // Keys MST used to write that Claude Desktop doesn't know (it would
  // ignore the whole file) are dropped from an older image's settings too.
  const {
    allowedPluginMarketplaces: _previous,
    allowedMcpServers: _allowed,
    allowManagedMcpServersOnly: _only,
    ...rest
  } = base;
  const disabled = Array.isArray(base.disabledBuiltinTools)
    ? base.disabledBuiltinTools.filter(
        (tool): tool is string => typeof tool === 'string'
      )
    : [];
  return {
    ...rest,
    // Headless: nobody can answer AskUserQuestion. The image's own
    // disabled tools stay disabled.
    disabledBuiltinTools: [...new Set([...disabled, ...HEADLESS_DISABLED])],
    managedMcpServers: [...http, ...managed.managedMcpServers],
    ...COWORK_MANAGED_ONLY,
    ...(managed.allowedPluginMarketplaces
      ? { allowedPluginMarketplaces: managed.allowedPluginMarketplaces }
      : {}),
    ...(options.model
      ? {
          inferenceModels: [
            models.find((entry) => entry?.name === options.model) ?? {
              name: options.model,
            },
          ],
        }
      : {}),
  };
}

/** Runs the image's desktop restart command; it returns once Claude is back. */
async function restartDesktop(
  command: string,
  env: Record<string, string | undefined>
): Promise<void> {
  const failed = await new Promise<boolean>((resolve) => {
    const child = execFile(
      command,
      [],
      {
        // Room for an image to boot Cowork's VM before it reports back.
        timeout: 300_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        env: Object.fromEntries(
          SESSION_ENV.flatMap((k) => (env[k] ? [[k, env[k]]] : []))
        ),
      },
      (error) => resolve(error !== null)
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
  if (failed)
    throw new Error(
      'The desktop restart command (MST_DESKTOP_RESTART) failed after MST wrote the variant settings.'
    );
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
      errorCode:
        typeof r.error === 'string' && /^[a-z_]{1,64}$/.test(r.error)
          ? r.error
          : undefined,
    };
  } catch {
    return undefined;
  }
}

async function execute(
  mode: 'probe' | 'reset' | 'submit' | 'hitl',
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
  if (
    env.MST_COWORK_URL_OPENER !== undefined &&
    !isAbsolute(env.MST_COWORK_URL_OPENER)
  )
    throw new CoworkDriverError(
      'MST_COWORK_URL_OPENER must be an absolute executable path.'
    );
  const script = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  ).resolve('@gleanwork/mcp-server-tester/cowork-linux-runtime');
  const timeout = Math.min(remaining, mode === 'submit' ? 60_000 : 10_000);
  // Reserve time for the bounded driver to return its final receipt.
  const driverTimeout = Math.max(
    1,
    Math.floor(timeout - Math.min(1000, timeout / 10))
  );
  const result = await new Promise<{ failed: boolean; stdout: string }>(
    (resolve) => {
      const child = execFile(
        env.MST_COWORK_PYTHON ?? 'python3',
        [
          script,
          '--mode',
          mode,
          '--timeout-ms',
          String(driverTimeout),
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
    mode === 'probe' || mode === 'reset'
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
      `Linux desktop ${mode} failed or its receipt was uncertain (${record?.errorCode ?? 'missing_or_invalid_receipt'}); no retry attempted.`,
      record ? telemetry(started, record.action_count, 'partial') : undefined
    );
  return record;
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error('data');
}

/**
 * Verify the caller-prepared paths for each stdio eval server: every referenced
 * plugin root is a real, non-world-writable directory, and `${dataDir}` is
 * `<mcpDataRoot>/<label>` (both 0700, ours) holding each declared file (a
 * regular 0600 file, ours) with exactly the substituted JSON content.
 */
async function verifyStdioPaths(
  servers: readonly ClientStdioServer[],
  paths: ClientStdioPaths,
  env: Record<string, string | undefined>
): Promise<void> {
  const tokens = resolveClientStdioCredentials(servers, env);
  for (const server of servers) {
    for (const plugin of server.pluginRoots) {
      const root = paths.pluginRoots?.[plugin];
      const info = root ? await lstat(root) : undefined;
      if (
        !root ||
        !info?.isDirectory() ||
        (info.mode & 0o002) !== 0 ||
        (await realpath(root)) !== root
      )
        throw new Error('plugin root');
    }
    const launch = resolveClientStdioServer(server, paths);
    if (!launch.dataDir) continue;
    await privateDirectory(paths.dataRoot!);
    await privateDirectory(launch.dataDir);
    const files = clientStdioFileContents(server, paths, tokens[server.label]);
    for (const [name, content] of Object.entries(files)) {
      const handle = await open(
        join(launch.dataDir, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0 ||
          info.size > 64 * 1024
        )
          throw new Error('file');
        if (
          !coworkJsonEqual(JSON.parse(await handle.readFile('utf8')), content)
        )
          throw new Error('file');
      } finally {
        await handle.close();
      }
    }
  }
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
  async prepare({ evalConfig, env, model, plugins = [], stdioPaths = {} }) {
    const settingsFile =
      env.MST_COWORK_SETTINGS_FILE ??
      '/etc/claude-desktop/managed-settings.json';
    if (!isAbsolute(settingsFile))
      throw new Error('Linux Cowork settings path must be absolute.');
    // Owned-desktop mode (ADR 0004): a worker image lets MST write each
    // variant's settings, restart the desktop, and restore the file after.
    const owned = env.MST_DESKTOP_OWNED === '1';
    let original: string | undefined;
    if (owned) {
      const restart = env.MST_DESKTOP_RESTART;
      if (!restart || !isAbsolute(restart))
        throw new Error(
          'Owned-desktop mode (MST_DESKTOP_OWNED=1) needs MST_DESKTOP_RESTART: an absolute path to the command that restarts Claude Desktop.'
        );
      original = await readSettingsText(settingsFile);
      const base = original
        ? (JSON.parse(original) as Record<string, unknown>)
        : {};
      await writeSettingsText(
        settingsFile,
        `${JSON.stringify(
          coworkLinuxOwnedSettings(base, {
            servers: transportServers(evalConfig.servers, 'Cowork'),
            plugins,
            paths: stdioPaths,
            approveWriteTools:
              evalConfig.coworkSetup?.approveWriteTools === true,
            ...(model ? { model } : {}),
          }),
          null,
          2
        )}\n`
      );
    }
    // In owned mode the settings go back, whether or not the desktop is ready.
    const restore = async () => {
      if (owned) await writeSettingsText(settingsFile, original ?? '{}\n');
    };
    try {
      if (owned)
        await restartDesktop(env.MST_DESKTOP_RESTART!, {
          ...process.env,
          ...env,
        });
      await checkAndProbe();
    } catch (error) {
      await restore().catch(() => {});
      throw error;
    }
    return { dispose: restore };

    async function checkAndProbe(): Promise<void> {
      try {
        const settings = await readSettings(settingsFile);
        const models = settings.inferenceModels as
          | Array<{ name?: string }>
          | undefined;
        if (model && !models?.some((m) => m.name === model))
          throw new Error('model');
        if (!coworkPluginSettingsMatch(settings, plugins))
          throw new Error('plugins');
        // Linux Cowork is always headless: nobody can answer AskUserQuestion.
        if (!coworkHeadlessSettingsMatch(settings)) throw new Error('headless');
        const servers = transportServers(evalConfig.servers, 'Cowork');
        if (
          !coworkMcpSettingsMatch(settings, {
            servers,
            plugins,
            paths: stdioPaths,
            approveWriteTools:
              evalConfig.coworkSetup?.approveWriteTools === true,
          })
        )
          throw new Error('servers');
        await verifyStdioPaths(
          clientStdioServers(servers, plugins),
          stdioPaths,
          env
        );
      } catch {
        throw new Error(
          'Prepared Linux desktop settings do not match the eval model, MCP servers, plugins, plugin/data paths, approval policy, or headless built-in tools.'
        );
      }
      await execute(
        'probe',
        {},
        { deadlineAt: Date.now() + 15_000, maxActions: 1, env }
      );
    }
  },
  async recover() {
    throw new Error(
      'Linux desktop recovery belongs to the runtime owner, not the MST driver.'
    );
  },
  async reset(options) {
    // One empty new-task deep link, then a read-only wait. Never types or sends.
    await execute('reset', {}, { ...options, maxActions: 1 });
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
        if (await options.awaitingUser?.())
          throw new CoworkUserQuestionError(
            'Cowork is waiting for an answer to a question (AskUserQuestion); a headless run cannot answer it. No resubmission attempted.',
            telemetry(started, actions, 'partial')
          );
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
      if (
        error instanceof CoworkHitlBudgetError ||
        error instanceof CoworkUserQuestionError
      )
        throw error;
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
