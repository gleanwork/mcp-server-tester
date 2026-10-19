import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  readdir,
  statfs,
  writeFile,
} from 'node:fs/promises';
import type { MCPConfig } from '../../config/mcpConfig.js';
import { mcpServerLabel } from '../../config/mcpConfig.js';
import type { MarketplacePlugin } from '../clientPlugins.js';
import { createRequire } from 'node:module';
import { freemem, homedir, loadavg, totalmem, uptime } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoworkPlatform } from './platform.js';
import { transportServers } from '../evalConfig.js';
import { headersHelper } from '../coworkSetup/bundle.js';
import { resolveCoworkMcpHeaders } from '../coworkSetup/config.js';
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

/** The most one UI submission may take, within the case deadline. */
export const SUBMIT_TIMEOUT_MS = 10 * 60_000;

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
  status: 'ready' | 'submitted' | 'hitl_checked' | 'diagnosed' | 'failed';
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
 * whatever was there. An HTTP server with credentials gets MST's
 * `headersHelper` (`helpers`, by name), which reads them from a private file;
 * the settings hold no secrets. Another HTTP server keeps the image's
 * `headersHelper` for the same name and URL. Exactly what `prepare` then
 * checks.
 */
function coworkLinuxOwnedSettings(
  base: Record<string, unknown>,
  options: {
    servers: readonly MCPConfig[];
    plugins?: readonly MarketplacePlugin[];
    paths?: ClientStdioPaths;
    approveWriteTools?: boolean;
    model?: string;
    helpers?: ReadonlyMap<string, string>;
  }
): Record<string, unknown> {
  const managed = coworkManagedPluginSettings(options);
  const prior = Array.isArray(base.managedMcpServers)
    ? (base.managedMcpServers as Array<Record<string, unknown> | null>)
    : [];
  const http = options.servers.flatMap((server, index) => {
    if (server.transport !== 'http') return [];
    const name = mcpServerLabel(server, index);
    const helper =
      options.helpers?.get(name) ??
      prior.find(
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

/**
 * How long the restart command may take: `MST_DESKTOP_RESTART_TIMEOUT_S`, or
 * 5 minutes. An image that boots Cowork's VM before it reports back, under
 * nested virtualization, needs longer.
 */
export function desktopRestartTimeoutMs(
  env: Record<string, string | undefined>
): number {
  const raw = env.MST_DESKTOP_RESTART_TIMEOUT_S;
  if (raw === undefined || raw === '') return 300_000;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds < 1 || seconds > 3600)
    throw new CoworkDriverError(
      'MST_DESKTOP_RESTART_TIMEOUT_S must be a whole number of seconds from 1 to 3600.'
    );
  return seconds * 1000;
}

/**
 * The settings each owned desktop was last restarted with, by settings file.
 * Claude Desktop reads them only when it starts, and a restart reboots
 * Cowork's VM (minutes under nested virtualization), so a batch whose
 * settings are the ones the desktop already runs with (another dataset of
 * the same variant) doesn't restart it.
 */
const ownedDesktopSettings = new Map<string, string>();

/**
 * A Debian package's installed version, from dpkg's status file (the
 * `Package:` stanza whose `Status:` says installed). Undefined when it isn't
 * installed.
 */
export function installedDebVersion(
  status: string,
  name: string
): string | undefined {
  for (const stanza of status.split(/\n\s*\n/)) {
    const field = (key: string) =>
      new RegExp(`^${key}: (.+)$`, 'm').exec(stanza)?.[1]?.trim();
    if (field('Package') !== name) continue;
    if (!/\binstalled$/.test(field('Status') ?? '')) continue;
    return field('Version');
  }
  return undefined;
}

/** The Claude Desktop package this machine runs, as each case records it. */
async function installedClaudeDesktop(): Promise<
  { name: string; version: string; source: 'installed' } | undefined
> {
  try {
    const version = installedDebVersion(
      await readFile('/var/lib/dpkg/status', 'utf8'),
      'claude-desktop'
    );
    return version
      ? { name: 'Claude', version, source: 'installed' }
      : undefined;
  } catch {
    // Not a Debian system, or no dpkg: nothing to record.
    return undefined;
  }
}

interface ServerHeaderFiles {
  /** Each server's helper, by server name. */
  helpers: Map<string, string>;
  remove(): Promise<void>;
}

/**
 * For each HTTP server with headers or an access token (a connector server's
 * comes in `env`), a private file of its headers in `directories.headers`,
 * and a `headersHelper` that prints them in `directories.helpers`. Claude
 * Desktop runs the helper when it connects, so the managed settings never
 * hold a credential. The helper holds none either, so it can be on a disk
 * that allows executing it while the headers stay in a tmpfs that doesn't.
 */
async function writeServerHeaders(
  servers: readonly MCPConfig[],
  env: Record<string, string | undefined>,
  directories: { headers: string; helpers: string }
): Promise<ServerHeaderFiles> {
  const helpers = new Map<string, string>();
  const files: string[] = [];
  for (const [index, server] of servers.entries()) {
    if (server.transport !== 'http') continue;
    const name = mcpServerLabel(server, index);
    const headers = Object.values(
      resolveCoworkMcpHeaders([{ ...server, label: name }], env)
    )[0]!;
    if (Object.keys(headers).length === 0) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
      throw new Error(
        `Linux Cowork can't name a credentials file for server "${name}": use a label of letters, digits, ".", "_" and "-".`
      );
    for (const directory of new Set(Object.values(directories)))
      await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directories.headers, `${name}.json`);
    const helper = join(directories.helpers, `${name}-headers`);
    // Replaced whole, so the helper never reads a file being written.
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(headers)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    await writeFile(
      helper,
      headersHelper(
        file,
        Object.keys(headers),
        Object.keys(server.auth ?? {}).length > 0
      ),
      { mode: 0o700 }
    );
    helpers.set(name, helper);
    files.push(file, helper);
  }
  return {
    helpers,
    async remove() {
      await Promise.all(files.map((file) => rm(file, { force: true })));
    },
  };
}

/** Runs the image's desktop restart command; it returns once Claude is back. */
async function restartDesktop(
  command: string,
  env: Record<string, string | undefined>
): Promise<void> {
  const timeout = desktopRestartTimeoutMs(env);
  const failure = await new Promise<string | undefined>((resolve) => {
    const child = execFile(
      command,
      [],
      {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        env: Object.fromEntries(
          SESSION_ENV.flatMap((k) => (env[k] ? [[k, env[k]]] : []))
        ),
      },
      (error, _stdout, stderr) =>
        resolve(
          error === null
            ? undefined
            : error.killed
              ? `it didn't return within ${timeout / 1000} s`
              : String(stderr).trim().split('\n').at(-1)?.slice(0, 300) ||
                `it exited with ${error.code ?? 'an error'}`
        )
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
  if (failure !== undefined)
    throw new Error(
      `The desktop restart command (MST_DESKTOP_RESTART) failed after MST wrote the variant settings: ${failure}`
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
      !['ready', 'submitted', 'hitl_checked', 'diagnosed', 'failed'].includes(
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
  mode: 'probe' | 'reset' | 'submit' | 'hitl' | 'diagnose',
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
  // A hard query's UI submission can take minutes on a cold desktop; the
  // case deadline still bounds it.
  const timeout = Math.min(
    remaining,
    mode === 'submit'
      ? SUBMIT_TIMEOUT_MS
      : mode === 'diagnose'
        ? 20_000
        : 10_000
  );
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
        : mode === 'diagnose'
          ? 'diagnosed'
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

/** How much of the end of each of Cowork's logs a failed case keeps. */
const LOG_TAIL_BYTES = 256 * 1024;

/** The last LOG_TAIL_BYTES of each of Cowork's logs in `from`, into `to`. */
async function copyLogTails(from: string, to: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch {
    return;
  }
  await mkdir(to, { recursive: true });
  for (const name of names) {
    if (!/^[\w.-]+\.(log|jsonl)$/.test(name)) continue;
    let file;
    try {
      file = await open(
        join(from, name),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      const info = await file.stat();
      if (!info.isFile()) continue;
      const length = Math.min(info.size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, info.size - length);
      await writeFile(join(to, name), buffer, { mode: 0o600 });
    } catch {
      // Best effort: the rest still says what happened.
    } finally {
      await file?.close();
    }
  }
}

/** The machine's state when a case failed: memory, load and the data disk. */
async function systemState(dataDir: string): Promise<object> {
  const disk = await statfs(dataDir).catch(() => undefined);
  return {
    memory: { freeBytes: freemem(), totalBytes: totalmem() },
    loadAverage: loadavg(),
    uptimeSeconds: uptime(),
    ...(disk
      ? {
          dataDisk: {
            freeBytes: disk.bavail * disk.bsize,
            totalBytes: disk.blocks * disk.bsize,
          },
        }
      : {}),
  };
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
    let ownedText: string | undefined;
    let headerFiles: ServerHeaderFiles | undefined;
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
      const servers = transportServers(evalConfig.servers, 'Cowork');
      // MST_COWORK_HELPER_DIR: where the helpers can be executed, when the
      // staging file's directory is a noexec tmpfs (as Docker mounts one).
      const headers = join(dirname(settingsFile), 'mcp-headers');
      const helperDir = env.MST_COWORK_HELPER_DIR ?? headers;
      if (!isAbsolute(helperDir))
        throw new Error('MST_COWORK_HELPER_DIR must be an absolute path.');
      headerFiles = await writeServerHeaders(servers, env, {
        headers,
        helpers: helperDir,
      });
      ownedText = `${JSON.stringify(
        coworkLinuxOwnedSettings(base, {
          servers,
          plugins,
          paths: stdioPaths,
          approveWriteTools: evalConfig.coworkSetup?.approveWriteTools === true,
          ...(model ? { model } : {}),
          helpers: headerFiles.helpers,
        }),
        null,
        2
      )}\n`;
      await writeSettingsText(settingsFile, ownedText);
    }
    // In owned mode the settings go back, whether or not the desktop is ready,
    // and the servers' credentials are removed.
    const restore = async () => {
      if (!owned) return;
      await writeSettingsText(settingsFile, original ?? '{}\n');
      await headerFiles?.remove();
    };
    try {
      if (owned && ownedDesktopSettings.get(settingsFile) !== ownedText) {
        ownedDesktopSettings.delete(settingsFile);
        await restartDesktop(env.MST_DESKTOP_RESTART!, {
          ...process.env,
          ...env,
        });
        ownedDesktopSettings.set(settingsFile, ownedText!);
      }
      await checkAndProbe();
    } catch (error) {
      // A desktop that isn't ready gets a restart next time.
      ownedDesktopSettings.delete(settingsFile);
      await restore().catch(() => {});
      throw error;
    }
    const app = await installedClaudeDesktop();
    return { dispose: restore, ...(app ? { app } : {}) };

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
  async diagnose({ dir, dataDir, env }) {
    // Read-only: the screen and the app's accessible controls (the driver's
    // diagnose mode), Cowork's own logs, and the machine's state.
    await execute(
      'diagnose',
      { dir },
      { deadlineAt: Date.now() + 20_000, maxActions: 1, env }
    ).catch(() => {
      // Partial is still useful: the driver records what it couldn't capture.
    });
    // Cowork keeps its logs beside its session data (Claude-3p/logs).
    await copyLogTails(join(dirname(dataDir), 'logs'), join(dir, 'logs'));
    await writeFile(
      join(dir, 'system.json'),
      `${JSON.stringify(await systemState(dataDir), null, 2)}\n`,
      { mode: 0o600 }
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
