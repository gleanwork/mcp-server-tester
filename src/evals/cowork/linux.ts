import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
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
import type { CoworkDesktop } from './desktop.js';
import { installedDebApp } from '../installedApp.js';
import { transportServers } from '../evalConfig.js';
import { credentialHelperScript } from '../coworkSetup/credentialHelper.js';
import {
  resolveCoworkMcpHeaders,
  toCoworkServers,
} from '../coworkSetup/config.js';
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
  COWORK_MANAGED_ONLY,
  coworkHeadlessSettings,
  coworkHeadlessSettingsMatch,
  coworkManagedPluginSettings,
  coworkPluginSettingsMatch,
} from './managedSettings.js';
import {
  CoworkDriverError,
  CoworkHitlBudgetError,
  CoworkHitlError,
  CoworkUserQuestionError,
  type CoworkDriverOptions,
  type CoworkHitlReceipt,
  type CoworkPendingQuestion,
  type SemanticDesktopTelemetry,
} from './interaction.js';

/**
 * How long HITL waits for Cowork's form for one clarifying question to take
 * its first option (from when HITL first sees the question) before the case
 * fails as unanswered.
 */
const QUESTION_ANSWER_TIMEOUT_MS = 60_000;

/** The most one UI submission may take, within the case deadline. */
const SUBMIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Cowork's egress on MST's Linux desktop when neither the eval
 * (`coworkSetup.egressAllowedHosts`) nor the image names hosts: any public
 * host, as a user's Cowork reaches. Claude Desktop blocks private and local
 * addresses whatever the list says.
 */
const DEFAULT_EGRESS_HOSTS: readonly string[] = ['*'];

const SESSION_ENV = [
  'PATH',
  'HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
  // Nonsecret launcher context. Never forward credentials to the UI driver.
  'MST_COWORK_ACCOUNT_OWNER',
  'MST_COWORK_ACCOUNT_MARKER',
  'MST_COWORK_ACCOUNT_PROFILE',
  'MST_COWORK_SETTINGS_FILE',
  'MST_COWORK_URL_OPENER',
  'LANG',
  'LC_ALL',
];
interface Receipt {
  status: 'ready' | 'submitted' | 'hitl_checked' | 'diagnosed' | 'failed';
  action_count: number;
  duration_ms: number;
  errorCode?: string;
  /** HITL's scan couldn't finish (too large, or out of time): it saw nothing. */
  scanIncomplete?: boolean;
  /** HITL denied the task's request for a folder of the user's computer. */
  deniedFolderRequest?: boolean;
  /** The answer pass picked a question's first option, or advanced its page. */
  answered?: boolean;
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
    /** Desktop's `otlp*` keys (`telemetry.host`), which replace the image's own. */
    telemetry?: Record<string, unknown>;
    /** `coworkSetup.egressAllowedHosts`, over the image's own list. */
    egressAllowedHosts?: readonly string[];
    /** `coworkSetup.disabledBuiltinTools`, added to the image's own list. */
    disabledBuiltinTools?: readonly string[];
    /** `coworkSetup.toolSearch`. Default: on. */
    toolSearch?: boolean;
    /** `coworkSetup.clarifyingQuestions`. Default: `first-option`. */
    clarifyingQuestions?: 'first-option' | 'disabled';
  }
): Record<string, unknown> {
  const answering =
    (options.clarifyingQuestions ?? 'first-option') === 'first-option';
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
    ...kept
  } = base;
  // An image's own `otlp*` keys are replaced, never merged.
  const rest = options.telemetry
    ? {
        ...Object.fromEntries(
          Object.entries(kept).filter(([key]) => !/^otlp[A-Z]/.test(key))
        ),
        ...options.telemetry,
      }
    : kept;
  // When HITL answers clarifying questions, the image's headless default
  // (AskUserQuestion off) gives way; an eval that lists it keeps it off.
  const disabled = Array.isArray(base.disabledBuiltinTools)
    ? base.disabledBuiltinTools.filter(
        (tool): tool is string =>
          typeof tool === 'string' &&
          !(answering && HEADLESS_DISABLED.includes(tool))
      )
    : [];
  const imageEgress = Array.isArray(base.coworkEgressAllowedHosts)
    ? base.coworkEgressAllowedHosts.filter(
        (host): host is string => typeof host === 'string'
      )
    : undefined;
  return {
    ...rest,
    // Where Cowork's tools (web fetch) and its VM's commands may connect:
    // one list for both, by host, so it can't allow reads only.
    coworkEgressAllowedHosts: [
      ...(options.egressAllowedHosts ?? imageEgress ?? DEFAULT_EGRESS_HOSTS),
    ],
    // HITL answers AskUserQuestion with each question's first option, or,
    // with clarifyingQuestions disabled, the tool is off. The image's own
    // disabled tools stay disabled; the eval's are added.
    disabledBuiltinTools: [
      ...new Set([
        ...disabled,
        ...(answering ? [] : HEADLESS_DISABLED),
        ...(options.disabledBuiltinTools ?? []),
      ]),
    ],
    managedMcpServers: [...http, ...managed.managedMcpServers],
    // Tool search, as Cowork signed in to claude.ai has it: Desktop leaves
    // it off in gateway mode unless the settings turn it on.
    toolSearchEnabled: options.toolSearch ?? true,
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
    // Only what Cowork reads, as on macOS: MST's own settings, such as
    // `requestTimeoutMs` for its readiness check, aren't Claude Desktop's.
    const headers = Object.values(
      resolveCoworkMcpHeaders(
        toCoworkServers([{ ...server, label: name }]),
        env
      )
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
      credentialHelperScript({
        kind: 'headers',
        path: file,
        names: Object.keys(headers),
        bearer: Object.keys(server.auth ?? {}).length > 0,
      }),
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

/**
 * How many times MST runs the restart command before the variant fails. A
 * restart that fails costs the shard every case it has left, and a second one
 * starts Claude and its VM from scratch.
 */
const DESKTOP_RESTART_ATTEMPTS = 2;

/** Runs the image's desktop restart command; it returns once Claude is back. */
async function restartDesktop(
  command: string,
  env: Record<string, string | undefined>
): Promise<void> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= DESKTOP_RESTART_ATTEMPTS; attempt++) {
    const failure = await runRestartCommand(command, env);
    if (failure === undefined) return;
    failures.push(failure);
    if (attempt < DESKTOP_RESTART_ATTEMPTS)
      process.stderr.write(
        `[mst:cowork] desktop restart failed (${failure}); restarting it again\n`
      );
  }
  throw new Error(
    `The desktop restart command (MST_DESKTOP_RESTART) failed after MST wrote the variant settings, ${failures.length} times: ${failures.join('; then ')}`
  );
}

/** One run of the restart command: why it failed, or undefined. */
function runRestartCommand(
  command: string,
  env: Record<string, string | undefined>
): Promise<string | undefined> {
  const timeout = desktopRestartTimeoutMs(env);
  return new Promise<string | undefined>((resolve) => {
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
              : String(stderr ?? '')
                  .trim()
                  .split('\n')
                  .at(-1)
                  ?.slice(0, 300) ||
                `it exited with ${error.code ?? 'an error'}`
        )
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

function telemetry(
  started: number,
  actions: number,
  accounting: 'complete' | 'partial',
  hitl: {
    incompleteScans: number;
    folderRequestsDenied: number;
    questionsAnswered?: number;
  } = {
    incompleteScans: 0,
    folderRequestsDenied: 0,
  }
): SemanticDesktopTelemetry {
  return {
    accounting,
    duration_ms: Math.max(0, Date.now() - started),
    action_count: actions,
    ...(hitl.incompleteScans > 0
      ? { incomplete_scans: hitl.incompleteScans }
      : {}),
    ...(hitl.folderRequestsDenied > 0
      ? { folder_requests_denied: hitl.folderRequestsDenied }
      : {}),
    ...(hitl.questionsAnswered
      ? { questions_answered: hitl.questionsAnswered }
      : {}),
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
      ...(r.scan === 'incomplete' ? { scanIncomplete: true } : {}),
      ...(r.denied === 'folder_request' ? { deniedFolderRequest: true } : {}),
      ...(r.answered === 'option' || r.answered === 'advance'
        ? { answered: true }
        : {}),
    };
  } catch {
    return undefined;
  }
}

type LinuxCoworkMode = 'third-party' | 'first-party';

async function execute(
  mode: 'probe' | 'reset' | 'submit' | 'hitl' | 'answer' | 'diagnose',
  payload: object,
  options: CoworkDriverOptions,
  driverMode: LinuxCoworkMode = 'third-party'
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
  ).resolve(
    driverMode === 'first-party'
      ? '@gleanwork/mcp-server-tester/cowork-linux-first-party-runtime'
      : '@gleanwork/mcp-server-tester/cowork-linux-runtime'
  );
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
      // Both drivers run on the Node that runs MST.
      const child = execFile(
        process.execPath,
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
/**
 * The Claude desktop app the image installs as the `claude-desktop` package
 * (docker/cowork-linux). Not a Debian system, or no dpkg: nothing to record.
 */
export async function installedCoworkApp() {
  return installedDebApp('claude-desktop', 'Claude');
}

const ACCOUNT_ROOT = '/run/mst/cowork-account';
const TMPFS_MAGIC = 0x01021994;

/**
 * Attach to a plugin-staged account profile, not a managed/gateway desktop.
 * The marker is a nonsecret assertion; source cloud control independently
 * verifies its account and organization before changing connector policy.
 * Never read Cookies or import authentication into MST.
 */
async function checkAccountRuntime(
  env: Record<string, string | undefined>
): Promise<void> {
  try {
    const owner = env.MST_COWORK_ACCOUNT_OWNER;
    if (
      !owner ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        owner
      )
    )
      throw new Error('owner');
    const root = join(ACCOUNT_ROOT, owner);
    const profile = join(root, 'config', 'Claude');
    const marker = join(root, 'owner.json');
    if (
      env.MST_COWORK_ACCOUNT_PROFILE !== profile ||
      env.MST_COWORK_ACCOUNT_MARKER !== marker ||
      env.XDG_CONFIG_HOME !== join(root, 'config') ||
      !env.HOME?.startsWith(`${root}/`) ||
      !env.MST_COWORK_URL_OPENER ||
      !isAbsolute(env.MST_COWORK_URL_OPENER) ||
      env.MST_COWORK_WARM_VM !== '0' ||
      Object.entries(env).some(
        ([key, value]) => key.startsWith('MST_INFERENCE_') && value
      ) ||
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'].some(
        (key) => env[key]
      )
    )
      throw new Error('profile');
    const runtimeDirectories = [
      env.HOME,
      env.TMPDIR,
      env.XDG_CACHE_HOME,
      env.XDG_DATA_HOME,
    ];
    for (const path of runtimeDirectories) {
      if (!path?.startsWith(`${root}/`))
        throw new Error('private runtime path');
      await privateDirectory(path);
    }
    if (env.CLAUDE_CONFIG_DIR) {
      if (!env.CLAUDE_CONFIG_DIR.startsWith(`${root}/`))
        throw new Error('private runtime path');
      await privateDirectory(env.CLAUDE_CONFIG_DIR);
    }
    for (const path of [root, join(root, 'config'), profile])
      await privateDirectory(path);
    if ((await statfs(root)).type !== TMPFS_MAGIC) throw new Error('tmpfs');
    const file = await open(
      marker,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size > 16 * 1024
      )
        throw new Error('marker');
      const value = JSON.parse(await file.readFile('utf8')) as Record<
        string,
        unknown
      >;
      const keys = [
        'version',
        'owner',
        'expiresAt',
        'accountId',
        'organizationId',
        'profileDir',
        'schemaVersion',
        'mode',
      ];
      const expires =
        typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
      if (
        Object.keys(value).length !== keys.length ||
        !keys.every((key) => Object.hasOwn(value, key)) ||
        value.version !== 1 ||
        value.owner !== owner ||
        value.mode !== 'first-party' ||
        value.profileDir !== profile ||
        value.schemaVersion !== 24 ||
        !Number.isFinite(expires) ||
        new Date(expires).toISOString() !== value.expiresAt ||
        expires <= Date.now() ||
        expires > Date.now() + 120 * 60_000 ||
        ![value.accountId, value.organizationId].every(
          (id) =>
            typeof id === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)
        )
      )
        throw new Error('marker');
    } finally {
      await file.close();
    }
    const settingsFile =
      env.MST_COWORK_SETTINGS_FILE ??
      '/etc/claude-desktop/managed-settings.json';
    if (!isAbsolute(settingsFile)) throw new Error('settings');
    for (const path of new Set([
      settingsFile,
      '/etc/claude-desktop/managed-settings.json',
      '/run/mst/settings/managed-settings.json',
    ])) {
      const settings = await readSettingsText(path);
      if (settings !== undefined && !coworkJsonEqual(JSON.parse(settings), {}))
        throw new Error('managed settings');
    }
    // Metadata only: never open a gateway token or any account credential.
    try {
      await lstat('/run/mst/inference-token');
      throw new Error('gateway token');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const socket = env.MST_COWORK_CLOUD_CONTROL_SOCKET;
    if (!socket || !isAbsolute(socket)) throw new Error('socket');
    await privateDirectory(dirname(socket));
    const info = await lstat(socket);
    if (
      !info.isSocket() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(socket)) !== socket
    )
      throw new Error('socket');
  } catch {
    // Do not include marker content, raw filesystem errors or environment values.
    throw new Error(
      'First-party Linux Cowork requires a private, unexpired plugin-staged tmpfs account profile, an empty unmanaged settings file, a profile-preserving URL opener and MST_COWORK_CLOUD_CONTROL_SOCKET. Managed/gateway runtimes are unsupported.'
    );
  }
}

async function diagnoseLinux(
  { dir, dataDir, env }: Parameters<NonNullable<CoworkDesktop['diagnose']>>[0],
  driverMode: LinuxCoworkMode
): Promise<void> {
  // Read-only: capture the desktop, native logs and machine state.
  await execute(
    'diagnose',
    { dir },
    { deadlineAt: Date.now() + 20_000, maxActions: 1, env },
    driverMode
  ).catch(() => {
    // Partial is still useful: the driver records what it couldn't capture.
  });
  await copyLogTails(join(dirname(dataDir), 'logs'), join(dir, 'logs'));
  await writeFile(
    join(dir, 'system.json'),
    `${JSON.stringify(await systemState(dataDir), null, 2)}\n`,
    { mode: 0o600 }
  );
}

const coworkLinuxThirdParty: CoworkDesktop = {
  dataDirectory: (options) =>
    options.dataDir ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'Claude-3p',
      'local-agent-mode-sessions'
    ),
  async prepare({
    evalConfig,
    env,
    model,
    plugins = [],
    stdioPaths = {},
    otlpSettings,
  }) {
    if (
      env.MST_COWORK_ACCOUNT_OWNER ||
      env.MST_COWORK_ACCOUNT_PROFILE ||
      env.MST_COWORK_ACCOUNT_MARKER
    )
      throw new Error(
        'The managed third-party driver cannot prepare an account runtime. Select first-party mode; no settings were changed.'
      );
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
    if (otlpSettings && !owned)
      throw new Error(
        "telemetry.host on Cowork needs owned-desktop mode (MST_DESKTOP_OWNED=1, MST's Linux image), where MST writes Claude Desktop's settings."
      );
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
          ...(otlpSettings ? { telemetry: otlpSettings } : {}),
          ...(evalConfig.coworkSetup?.egressAllowedHosts
            ? { egressAllowedHosts: evalConfig.coworkSetup.egressAllowedHosts }
            : {}),
          ...(evalConfig.coworkSetup?.disabledBuiltinTools
            ? {
                disabledBuiltinTools:
                  evalConfig.coworkSetup.disabledBuiltinTools,
              }
            : {}),
          ...(evalConfig.coworkSetup?.toolSearch !== undefined
            ? { toolSearch: evalConfig.coworkSetup.toolSearch }
            : {}),
          ...(evalConfig.coworkSetup?.clarifyingQuestions
            ? {
                clarifyingQuestions: evalConfig.coworkSetup.clarifyingQuestions,
              }
            : {}),
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
    const app = await installedCoworkApp();
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
        // Linux Cowork is headless: either HITL answers AskUserQuestion with
        // the first option, or the tool is off.
        if (
          evalConfig.coworkSetup?.clarifyingQuestions === 'disabled' &&
          !coworkHeadlessSettingsMatch(settings)
        )
          throw new Error('headless');
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
  async diagnose(options) {
    await diagnoseLinux(options, 'third-party');
  },
  async reset(options) {
    // Stop the failed case's task if it still runs (its Stop response), then
    // one empty new-task deep link and a read-only wait. Never types or sends.
    await execute('reset', {}, { ...options, maxActions: 2 });
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
    return handleLinuxHitl(options, 'third-party');
  },
};

/** Compatibility name: always the managed third-party adapter. */
export const coworkLinux = coworkLinuxThirdParty;

async function handleLinuxHitl(
  options: CoworkDriverOptions,
  driverMode: LinuxCoworkMode
): Promise<CoworkHitlReceipt> {
  if (!options.isComplete)
    throw new Error('Linux HITL requires a bound native completion check.');
  const started = Date.now();
  let actions = 0;
  // Passes whose scan couldn't finish (they saw no prompt, and HITL went
  // on), and folder requests HITL denied.
  const counts = {
    incompleteScans: 0,
    folderRequestsDenied: 0,
    questionsAnswered: 0,
  };
  // Set while the driver runs: a failure then may have acted on the app.
  let driving = false;
  const budget = options.maxActions ?? 12;
  // Each question HITL has seen (by tool call), and since when.
  const questionsSeen = new Map<string, number>();
  try {
    while (Date.now() < options.deadlineAt) {
      if (await options.isComplete())
        return {
          status: 'hitl_checked',
          action_count: actions,
          telemetry: telemetry(started, actions, 'complete', counts),
        };
      const question = options.pendingQuestion
        ? await options.pendingQuestion()
        : (await options.awaitingUser?.())
          ? ({ questions: [] } satisfies CoworkPendingQuestion)
          : undefined;
      if (question) {
        if (!question.questions.length)
          throw new CoworkUserQuestionError(
            options.pendingQuestion
              ? 'Cowork is waiting for an answer to a question (AskUserQuestion) that offers no usable options. No resubmission attempted.'
              : 'Cowork is waiting for an answer to a question (AskUserQuestion); a headless run cannot answer it. No resubmission attempted.',
            telemetry(started, actions, 'partial', counts)
          );
        const key = question.id ?? JSON.stringify(question.questions);
        const since = questionsSeen.get(key) ?? Date.now();
        questionsSeen.set(key, since);
        if (Date.now() - since > QUESTION_ANSWER_TIMEOUT_MS)
          throw new CoworkUserQuestionError(
            `Cowork's question (AskUserQuestion) didn't take its first option within ${QUESTION_ANSWER_TIMEOUT_MS / 1000} s. No resubmission attempted.`,
            telemetry(started, actions, 'partial', counts)
          );
        if (actions >= budget)
          throw new CoworkHitlBudgetError(
            'Linux HITL action budget exhausted.',
            telemetry(started, actions, 'partial', counts)
          );
        // One page per pass: the first option, or the page's Submit/Next
        // once a multi-select option is checked. A pass that finds no
        // unambiguous control acts on nothing and the next looks again.
        driving = true;
        const result = await execute(
          'answer',
          { questions: question.questions },
          { ...options, maxActions: Math.min(1, budget - actions) },
          driverMode
        );
        driving = false;
        actions += result.action_count;
        if (result.answered) counts.questionsAnswered += 1;
        if (result.scanIncomplete) counts.incompleteScans += 1;
        await delay(
          Math.min(1_000, Math.max(0, options.deadlineAt - Date.now()))
        );
        continue;
      }
      if (actions >= budget)
        throw new CoworkHitlBudgetError(
          'Linux HITL action budget exhausted.',
          telemetry(started, actions, 'partial', counts)
        );
      driving = true;
      const result = await execute(
        'hitl',
        {
          approveWriteTools: options.approveWriteTools === true,
        },
        { ...options, maxActions: budget - actions },
        driverMode
      );
      driving = false;
      actions += result.action_count;
      if (result.scanIncomplete) counts.incompleteScans += 1;
      if (result.deniedFolderRequest) counts.folderRequestsDenied += 1;
      await delay(Math.min(500, Math.max(0, options.deadlineAt - Date.now())));
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
    // A driver call that failed without a receipt may have acted.
    const unknown =
      driving &&
      !(error instanceof CoworkDriverError && error.telemetry !== undefined);
    throw new CoworkHitlError(
      `Linux HITL failed for the bound native session: ${error instanceof Error ? error.message : String(error)}`,
      telemetry(started, actions + partialActions, 'partial', counts),
      actions + partialActions > 0 || unknown
    );
  }
  throw new CoworkDriverError(
    'Linux HITL deadline exceeded.',
    telemetry(started, actions, 'partial', counts)
  );
}

/** Account mode attaches only. Managed 3P preparation must never run here. */
export const coworkLinuxFirstParty: CoworkDesktop = {
  async recover() {
    throw new Error(
      'First-party Linux Cowork recovery requires its account source runtime; managed desktop recovery is unsupported.'
    );
  },
  async diagnose(options) {
    await diagnoseLinux(options, 'first-party');
  },
  dataDirectory: () => {
    const profile = process.env.MST_COWORK_ACCOUNT_PROFILE;
    if (!profile)
      throw new Error(
        'First-party Linux Cowork needs a staged account profile.'
      );
    return join(profile, 'local-agent-mode-sessions');
  },
  async prepare({ env, plugins = [], otlpSettings, appVersion }) {
    if (plugins.length || otlpSettings || appVersion)
      throw new Error(
        'First-party Linux Cowork cannot install managed plugins or telemetry settings, or pin appVersion.'
      );
    await checkAccountRuntime(env);
    // Read-only readiness. In particular, no managed restart or warmup task.
    await execute(
      'probe',
      {},
      { deadlineAt: Date.now() + 15_000, maxActions: 1, env },
      'first-party'
    );
    const app = await installedCoworkApp();
    return {
      ...(app ? { app } : {}),
      async dispose() {
        // The plugin owns the profile and its cleanup; source control owns policy.
      },
    };
  },
  async handleHitl(options) {
    await checkAccountRuntime(options.env ?? process.env);
    // Account `ask` must not become a persistent account permission in the UI.
    return handleLinuxHitl(options, 'first-party');
  },
  async reset(options) {
    await checkAccountRuntime(options.env ?? process.env);
    await execute('reset', {}, { ...options, maxActions: 2 }, 'first-party');
  },
  async submit(query, options) {
    await checkAccountRuntime(options.env ?? process.env);
    const started = Date.now();
    const result = await execute(
      'submit',
      {
        prompt: query,
        ...(options.targetModel ? { targetModel: options.targetModel } : {}),
      },
      options,
      'first-party'
    );
    return {
      status: 'submitted',
      action_count: result.action_count,
      telemetry: telemetry(started, result.action_count, 'complete'),
    };
  },
};
