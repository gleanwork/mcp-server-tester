import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { transportServers, type EvalConfig } from '../evalConfig.js';
import {
  clientStdioServers,
  resolveClientStdioServer,
  type MarketplacePlugin,
  type ClientStdioPaths,
} from '../clientPlugins.js';
import { getMacCoworkController } from './macController.js';
import { configureMacToolDefaults } from './macToolPermissions.js';
import { resolveCoworkSetupConfig } from './options.js';
import { coworkManagedPluginSettings } from '../cowork/managedSettings.js';
import {
  installMacLocalMcp,
  preflightMacLocalMcp,
  restoreMacLocalMcp,
} from './macLocalMcp.js';
import {
  acquireMacCoworkApp,
  macCoworkAppVersion,
  readMacCoworkAppVersion,
  removeMacCoworkApp,
  verifyMacCoworkAppVersion,
} from './macApp.js';
import {
  installMacCoworkSettings,
  preflightMacCoworkSettings,
  restoreMacCoworkSettings,
} from './macTransaction.js';
import { mcpServerLabel } from '../../config/mcpConfig.js';

const ERROR = 'Unable to prepare the Mac Cowork session safely.';
const INSTALLED_APP = '/Applications/Claude.app';

/** Setup errors that are safe to show and tell the operator what to change. */
function actionable(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith('Unable to acquire Claude Desktop ') ||
      error.message === 'Unable to read the Claude Desktop version.' ||
      error.message.startsWith('MST_COWORK_APP_VERSION was removed') ||
      error.message.startsWith('Invalid clientOptions.appVersion') ||
      error.message.startsWith('Set clientOptions.appVersion'))
  );
}

/** The Claude Desktop a session runs. Recorded with each case result. */
export interface MacCoworkApp {
  name: 'Claude Desktop';
  version: string;
  /** `pinned`: downloaded for `clientOptions.appVersion`; else the installed app. */
  source: 'installed' | 'pinned';
}
const CLEANUP_ERROR =
  'Unable to restore the Mac Cowork session safely. Recovery state retained.';
const LEASE = '.mst-session-lock';
const TRANSACTION = '.mst-setup-lock';
const RECOVERY = '.mst-recovery-lock';

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(ERROR);
  }
}

async function privateBytes(file: string): Promise<Buffer> {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > 1024 * 1024
    )
      throw new Error(ERROR);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await fd.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid
    )
      throw new Error(ERROR);
    return buffer.subarray(0, length);
  } finally {
    await fd.close();
  }
}

/** Prepare only application/configuration lifecycle. App launch does not prove
 * MCP inventory, tool policy adoption, authentication, or query submission.
 * Parent directories must be trusted, as required by the settings transaction.
 * A retained .mst-session-lock/session.json records prior state and staging for
 * explicit recovery; it is never stolen, automatically expired, or force-cleared.
 */
export async function prepareMacCoworkSession(options: {
  evalConfig: EvalConfig;
  env: Record<string, string | undefined>;
  profileDirectory?: string;
  model?: string;
  plugins?: readonly MarketplacePlugin[];
  /** `clientOptions.appVersion`: download and run exactly this version. */
  appVersion?: string;
}): Promise<{
  setupStatus: 'applied-not-verified';
  serverCount: number;
  /** Paths owned by the session for private stdio files. */
  stdioPaths: ClientStdioPaths;
  /** The installed, caller-owned or downloaded Claude application path. */
  appPath: string;
  /** The Claude Desktop the session runs, as recorded with each result. */
  app: MacCoworkApp;
  /** Quits and relaunches the session's app, with the session's settings. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}> {
  try {
    if (process.platform !== 'darwin') throw new Error(ERROR);
    // Snapshot caller input so later mutation cannot change the preflighted setup.
    const evalConfig = structuredClone(options.evalConfig);
    if (evalConfig.variants !== undefined || !options.env)
      throw new Error(ERROR);
    const env = { ...options.env };
    // Without an explicit pin, run the installed (or caller-owned) app.
    const pinnedVersion = macCoworkAppVersion(options.appVersion, env);
    const pinnedApp = pinnedVersion !== undefined;
    const profileDirectory = resolve(
      join(homedir(), 'Library/Application Support/Claude-3p/configLibrary')
    );
    // The controller launches one fixed app instance without a user-data-dir
    // override. Never lease/configure another directory that it cannot select.
    if (
      options.profileDirectory !== undefined &&
      resolve(options.profileDirectory) !== profileDirectory
    )
      throw new Error(ERROR);
    const lease = join(profileDirectory, LEASE);
    const lock = join(profileDirectory, TRANSACTION);
    if (
      (await exists(lease)) ||
      (await exists(join(profileDirectory, RECOVERY)))
    )
      throw new Error(ERROR);
    const stagingDirectory = join(
      await realpath(tmpdir()),
      `mst-cowork-session-${randomUUID()}`
    );
    const localMcpDirectory = `${stagingDirectory}-mcp`;
    if (!evalConfig.servers) throw new Error(ERROR);
    const plugins = structuredClone(options.plugins ?? []);
    const stdioPaths = { dataRoot: join(stagingDirectory, 'stdio') };
    const labeledServers = transportServers(evalConfig.servers, 'Cowork').map(
      (server, index) => ({
        ...server,
        label: mcpServerLabel(server, index),
      })
    );
    // Check plugin shadowing against the complete set before splitting transports.
    coworkManagedPluginSettings({
      servers: [],
      declaredServers: labeledServers,
      plugins,
    });
    // Managed inference overrides managed stdio. Route every launch through
    // localDeveloperMCP; only the transaction owns private-file materialization.
    const localServers = [
      ...labeledServers.filter((server) => server.transport === 'http'),
      ...clientStdioServers(labeledServers, plugins).map((server) => {
        const launch = resolveClientStdioServer(server, stdioPaths);
        return {
          transport: 'stdio' as const,
          label: server.label,
          command: launch.command,
          args: launch.args,
          env: launch.env,
          inheritEnv: false,
        };
      }),
    ];
    if (localServers.length !== labeledServers.length) throw new Error(ERROR);
    await preflightMacLocalMcp(localServers, env);
    const installOptions = {
      evalConfig: {
        ...evalConfig,
        servers: labeledServers.filter(
          (server) => server.transport === 'stdio'
        ),
      },
      model: options.model,
      plugins,
      env,
      profileDirectory,
      stagingDirectory,
      managedPreferencePaths: [
        '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
        `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudefordesktop.plist`,
      ],
    };
    await preflightMacCoworkSettings(installOptions);
    let controller = await getMacCoworkController('/Applications/Claude.app');
    const { running: wasRunning, runningAppPath } = await controller.state();
    const restoreAppPath = runningAppPath ?? '/Applications/Claude.app';
    const originalController = await getMacCoworkController(restoreAppPath);
    const appDirectory = `${stagingDirectory}-app`;
    // Atomic cross-process ownership precedes ANY stop/start. In particular, a
    // competing invocation must not stop the first invocation's running app.
    await mkdir(lease, { mode: 0o700 });
    const receiptPath = join(lease, 'session.json');
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        nonce: randomUUID(),
        pid: process.pid,
        profileDirectory,
        stagingDirectory,
        wasRunning,
        localMcp: true,
        ...(pinnedApp ? { pinnedApp: true } : {}),
        restoreAppPath,
      }) + '\n'
    );
    let leaseInfo: Stats;
    try {
      leaseInfo = await lstat(lease);
      await writeFile(receiptPath, receipt, { mode: 0o600, flag: 'wx' });
    } catch {
      // Nothing has touched the application yet. Remove only an empty lease;
      // partial/unknown contents remain available for explicit recovery.
      try {
        await rmdir(lease);
      } catch {
        /* fail closed */
      }
      throw new Error(ERROR);
    }
    let transaction:
      | Awaited<ReturnType<typeof installMacCoworkSettings>>
      | undefined;
    let installAttempted = false;

    const ownsLease = async (): Promise<void> => {
      const current = await lstat(lease);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== leaseInfo.dev ||
        current.ino !== leaseInfo.ino ||
        current.uid !== process.getuid?.() ||
        (current.mode & 0o077) !== 0 ||
        !(await privateBytes(receiptPath)).equals(receipt)
      )
        throw new Error(ERROR);
      const names = await readdir(lease);
      if (names.length !== 1 || names[0] !== 'session.json')
        throw new Error(ERROR);
    };

    const ownsTransaction = async (): Promise<boolean> => {
      if (!(await exists(lock))) {
        if (transaction || (await exists(stagingDirectory)))
          throw new Error(ERROR);
        return false;
      }
      const info = await lstat(lock);
      if (
        !installAttempted ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error(ERROR);
      const journal = JSON.parse(
        (await privateBytes(join(lock, 'journal.json'))).toString('utf8')
      ) as Record<string, unknown>;
      if (
        journal.directory !== stagingDirectory ||
        (transaction && journal.id !== transaction.id)
      )
        throw new Error(ERROR);
      return true;
    };

    const stop = async (): Promise<void> => {
      if ((await controller.state()).running) await controller.stop();
      if ((await controller.state()).running) throw new Error(ERROR);
    };

    const cleanup = async (): Promise<void> => {
      try {
        await ownsLease();
        const hasTransaction = await ownsTransaction();
        if (await exists(localMcpDirectory)) {
          await stop();
          await ownsLease();
          await restoreMacLocalMcp(localMcpDirectory);
        }
        if (hasTransaction) {
          await stop();
          await ownsLease();
          await ownsTransaction();
          if (transaction) await transaction.restore();
          else await restoreMacCoworkSettings(profileDirectory);
          transaction = undefined;
        }
        if ((await controller.state()).running !== wasRunning) {
          if (wasRunning) await originalController.start();
          else await stop();
        }
        if ((await controller.state()).running !== wasRunning)
          throw new Error(ERROR);
        if ((await exists(lock)) || (await exists(stagingDirectory)))
          throw new Error(ERROR);
        await ownsLease();
        if (pinnedApp) await removeMacCoworkApp(appDirectory);
        await unlink(receiptPath);
        try {
          await rmdir(lease);
        } catch {
          const after = await lstat(lease);
          if (
            after.isDirectory() &&
            after.dev === leaseInfo.dev &&
            after.ino === leaseInfo.ino
          )
            await writeFile(receiptPath, receipt, { mode: 0o600, flag: 'wx' });
          throw new Error(ERROR);
        }
      } catch {
        throw new Error(CLEANUP_ERROR);
      }
    };

    let appPath: string;
    let version: string;
    try {
      await ownsLease();
      await preflightMacCoworkSettings(installOptions);
      appPath = pinnedApp
        ? await acquireMacCoworkApp(appDirectory, pinnedVersion)
        : (env.MST_COWORK_APP_PATH ?? INSTALLED_APP);
      version = await readMacCoworkAppVersion(appPath);
      controller = await getMacCoworkController(appPath);
      await ownsLease();
      await stop();
      installAttempted = true;
      transaction = await installMacCoworkSettings(installOptions);
      // Even an empty eval must isolate personal developer servers.
      await installMacLocalMcp(localMcpDirectory, localServers, env);
      if (resolveCoworkSetupConfig(evalConfig.coworkSetup).approveWriteTools) {
        await configureMacToolDefaults(
          localMcpDirectory,
          labeledServers.map((server) => server.label)
        );
      }
      await controller.start();
      if (!(await controller.state()).running) throw new Error(ERROR);
    } catch (error) {
      await cleanup();
      if (actionable(error)) throw error;
      throw new Error(ERROR);
    }
    let disposal: Promise<void> | undefined;
    return {
      setupStatus: transaction.status,
      appPath,
      app: {
        name: 'Claude Desktop',
        version,
        source: pinnedApp ? 'pinned' : 'installed',
      },
      serverCount: evalConfig.servers?.length ?? 0,
      stdioPaths,
      async restart() {
        // Quitting stops any task still running; the settings, profile and
        // MCP servers installed for the session stay as they are. Like setup
        // and cleanup, act on the app only while this session owns it.
        if (disposal)
          throw new Error(
            'The Cowork session is being cleaned up; not restarting.'
          );
        await ownsLease();
        await ownsTransaction();
        if ((await controller.state()).running) await controller.stop();
        if ((await controller.state()).running)
          throw new Error('Claude Desktop did not quit; not restarting it.');
        await ownsLease();
        await controller.start();
        const state = await controller.state();
        if (!state.running)
          throw new Error('Claude Desktop did not start again after quitting.');
        if (
          state.runningAppPath &&
          (await realpath(state.runningAppPath)) !== (await realpath(appPath))
        )
          throw new Error(
            'A different Claude Desktop bundle started after the restart; refusing to continue.'
          );
      },
      dispose() {
        // Concurrent/repeated callers share one cleanup, including its failure.
        disposal ??= (async () => {
          try {
            // Pinned or not, the app must not change during the run.
            await verifyMacCoworkAppVersion(appPath, version);
            const state = await controller.state();
            if (
              state.runningAppPath &&
              (await realpath(state.runningAppPath)) !==
                (await realpath(appPath))
            )
              throw new Error(
                'The running Claude Desktop bundle changed during evaluation; refusing results.'
              );
          } finally {
            await cleanup();
          }
        })();
        return disposal;
      },
    };
  } catch (error) {
    throw new Error(
      error instanceof Error &&
        (error.message === CLEANUP_ERROR || actionable(error))
        ? error.message
        : ERROR
    );
  }
}
