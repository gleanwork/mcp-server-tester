import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  chatgptDesktopEnvironment,
  readLaunchEnvironment,
  type ChatgptApplicationController,
} from '../chatgpt/driver.js';
import { LINUX_CHATGPT_RUNTIME_ENVIRONMENT } from '../chatgpt/linuxContract.js';
import {
  appServerHostToolDisabled,
  appServerServerReady,
  probeAppServerStatus,
  type AppServerStatus,
} from '../codexSetup/appServerStatus.js';
import { loginWithApiKey } from '../codexSetup/auth.js';
import {
  disabledHostToolName,
  type CodexConfigInstallOptions,
  type CodexDisabledHostTool,
  type CodexExecutionPolicy,
  type ResolvedCodexSetup,
} from '../codexSetup/config.js';
import {
  CodexSetupError,
  type CodexSetupErrorCode,
} from '../codexSetup/native.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import { checkMcpServers, type McpServerReadiness } from '../mcpReadiness.js';
import { createLinuxChatgptApp } from './linuxApp.js';

/** The Scio -> MST process environment. All paths are absolute and normalized. */
const REQUIRED_PATHS = [
  'HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'GNOME_KEYRING_CONTROL',
  'MST_CHATGPT_APP_PATH',
  'MST_CHATGPT_CODEX_PATH',
  'MST_CHATGPT_API_KEY_FILE',
  'MST_CHATGPT_EVIDENCE_DIR',
] as const;
const REQUIRED_BUSES = [
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
] as const;
const OPTIONAL_PATHS = ['XAUTHORITY', 'MST_CHATGPT_PYTHON'] as const;
const UNDER_HOME = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;
/** Variables forwarded to native Codex/app processes. Never MST_* or secrets. */
const SESSION_KEYS = [
  'HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'GNOME_KEYRING_CONTROL',
] as const;

export const LINUX_CHATGPT_ENVIRONMENT_CONTRACT = {
  required: [...REQUIRED_PATHS, ...REQUIRED_BUSES, 'DISPLAY'],
  optional: [...OPTIONAL_PATHS],
} as const;

export interface LinuxChatgptEnvironment {
  home: string;
  codexHome: string;
  tmpdir: string;
  appPath: string;
  codexPath: string;
  apiKeyFile: string;
  evidenceDir: string;
  python?: string;
  /** Only the allowlisted session variables, with CODEX_HOME. */
  session: Record<string, string>;
}

/** Syntactic contract check. Filesystem checks happen in createLinuxChatgptProfile. */
export function readLinuxChatgptEnvironment(
  env: NodeJS.ProcessEnv
): LinuxChatgptEnvironment {
  const invalid = (key: string) =>
    new CodexSetupError('environment_invalid', key);
  const path = (key: string, required: boolean): string | undefined => {
    const value = env[key];
    if (value === undefined || value === '') {
      if (required) throw invalid(key);
      return undefined;
    }
    if (!isAbsolute(value) || resolve(value) !== value || value === '/')
      throw invalid(key);
    return value;
  };
  for (const key of REQUIRED_PATHS) path(key, true);
  for (const key of OPTIONAL_PATHS) path(key, false);
  for (const key of REQUIRED_BUSES)
    if (!env[key]?.startsWith('unix:') || /[\r\n\0]/.test(env[key]))
      throw invalid(key);
  if (!env.DISPLAY || /[\r\n\0]/.test(env.DISPLAY)) throw invalid('DISPLAY');
  const home = env.HOME!;
  for (const key of UNDER_HOME)
    if (!inside(home, env[key]!)) throw invalid(key);
  const codexHome = join(home, '.codex');
  // Never redirect native state to an inherited or personal profile.
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME !== codexHome)
    throw invalid('CODEX_HOME');
  const session: Record<string, string> = { CODEX_HOME: codexHome };
  for (const key of SESSION_KEYS) if (env[key]) session[key] = env[key]!;
  return {
    home,
    codexHome,
    tmpdir: env.TMPDIR!,
    appPath: env.MST_CHATGPT_APP_PATH!,
    codexPath: env.MST_CHATGPT_CODEX_PATH!,
    apiKeyFile: env.MST_CHATGPT_API_KEY_FILE!,
    evidenceDir: env.MST_CHATGPT_EVIDENCE_DIR!,
    python: env.MST_CHATGPT_PYTHON,
    session,
  };
}

/** Linux options and environment checks shared by preflight, lock, and session. */
export function validateLinuxChatgptConfig(
  config: ExternalHostConfig
): LinuxChatgptEnvironment {
  const desktop = chatgptDesktopEnvironment(config);
  const environment = readLinuxChatgptEnvironment(desktop);
  const launch = readLaunchEnvironment(config.options?.environment);
  for (const key of [
    ...LINUX_CHATGPT_RUNTIME_ENVIRONMENT,
    ...LINUX_CHATGPT_ENVIRONMENT_CONTRACT.required,
  ]) {
    if (launch[key] !== undefined && launch[key] !== desktop[key])
      throw new Error(
        'Linux ChatGPT launch environment must not override the prepared desktop session.'
      );
  }
  const configPath = config.codexSetup?.configPath;
  if (
    configPath !== undefined &&
    configPath !== join(environment.codexHome, 'config.toml')
  )
    throw new Error(
      'Linux ChatGPT owns $HOME/.codex/config.toml; remove options.configPath.'
    );
  if (config.options?.chatgptSessionRoot !== undefined)
    throw new Error(
      'Linux ChatGPT reads native sessions only from its MST-owned CODEX_HOME.'
    );
  return environment;
}

/**
 * The headless VM has no usable screen, so the bundled computer-use tool never
 * returns. Linux always disables the plugin that contributes `cua_repl` and
 * records the policy in telemetry. A transport-less `[mcp_servers.cua_repl]`
 * table breaks native login, so the server itself is not written; the
 * app-server probe verifies it is absent instead.
 */
export const LINUX_CHATGPT_DISABLED_HOST_TOOLS: readonly CodexDisabledHostTool[] =
  [{ kind: 'plugin', id: 'computer-use@openai-bundled' }];
/** Host MCP servers that must not be exposed to the model on Linux. */
export const LINUX_CHATGPT_ABSENT_HOST_SERVERS: readonly string[] = [
  'cua_repl',
];

/**
 * bwrap cannot run inside the Scio container, and nobody can answer an
 * approval request in a headless run. Scio runs the whole app in a disposable
 * no-new-privileges container with a fresh tmpfs profile, so that container is
 * the isolation boundary; the native per-command sandbox is turned off.
 */
export const LINUX_CHATGPT_EXECUTION_POLICY: CodexExecutionPolicy = {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
};

/** Sanitized setup receipt. No prompts, URLs, tokens, or native output. */
export interface LinuxChatgptReadiness {
  hostToolPolicy: { disabled: string[]; requiredAbsent: string[] };
  executionPolicy: CodexExecutionPolicy;
  login: 'not-run' | 'verified' | 'failed';
  mcpPreflight: McpServerReadiness[];
  mcpStatus?: AppServerStatus;
  error?: CodexSetupErrorCode;
}

export interface ChatgptPlatformProfile {
  readonly configPath: string;
  readonly install: Pick<
    CodexConfigInstallOptions,
    | 'credentialStore'
    | 'trustedProject'
    | 'disabledHostTools'
    | 'executionPolicy'
  >;
  readonly controller: ChatgptApplicationController;
  readonly evidenceDir?: string;
  readonly readiness: LinuxChatgptReadiness;
  /** After config install and before app start. Fails before any prompt. */
  beforeStart(
    setup: ResolvedCodexSetup,
    environment: Record<string, string>
  ): Promise<void>;
  dispose(): Promise<void>;
}

/** Fresh MST-owned profile inside the Scio-provided HOME. Fails closed. */
export async function createLinuxChatgptProfile(
  environment: LinuxChatgptEnvironment,
  platform: NodeJS.Platform = process.platform
): Promise<ChatgptPlatformProfile> {
  if (platform !== 'linux') throw new CodexSetupError('linux_required');
  await privateDirectory(environment.home, 'home_unsafe', 'HOME');
  await privateDirectory(environment.tmpdir, 'home_unsafe', 'TMPDIR');
  await privateDirectory(
    environment.session.XDG_RUNTIME_DIR!,
    'home_unsafe',
    'XDG_RUNTIME_DIR'
  );
  await privateDirectory(environment.evidenceDir, 'evidence_dir_unsafe');
  if ((await readdir(environment.evidenceDir)).length)
    throw new CodexSetupError('evidence_dir_unsafe');
  await executable(environment.appPath, 'app_path_invalid');
  await executable(environment.codexPath, 'codex_path_invalid');
  // Exclusive, non-recursive create proves the native profile is fresh.
  try {
    await mkdir(environment.codexHome, { mode: 0o700 });
  } catch {
    throw new CodexSetupError('home_not_fresh');
  }
  await chmod(environment.codexHome, 0o700);
  const workspace = await mkdtemp(
    join(environment.tmpdir, 'mst-chatgpt-workspace-')
  );
  await privateDirectory(workspace, 'workspace_unsafe');
  const readiness: LinuxChatgptReadiness = {
    hostToolPolicy: {
      disabled: LINUX_CHATGPT_DISABLED_HOST_TOOLS.map(disabledHostToolName),
      requiredAbsent: [...LINUX_CHATGPT_ABSENT_HOST_SERVERS],
    },
    executionPolicy: { ...LINUX_CHATGPT_EXECUTION_POLICY },
    login: 'not-run',
    mcpPreflight: [],
  };
  const fail = (code: CodexSetupErrorCode) => {
    readiness.error = code;
    return new CodexSetupError(code);
  };
  return {
    configPath: join(environment.codexHome, 'config.toml'),
    install: {
      credentialStore: 'keyring',
      trustedProject: workspace,
      disabledHostTools: LINUX_CHATGPT_DISABLED_HOST_TOOLS,
      executionPolicy: LINUX_CHATGPT_EXECUTION_POLICY,
    },
    controller: createLinuxChatgptApp({
      appPath: environment.appPath,
      environment: environment.session,
      workspace,
    }),
    evidenceDir: environment.evidenceDir,
    readiness,
    async beforeStart(setup, launch) {
      const native = {
        ...environment.session,
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
      };
      try {
        await loginWithApiKey(
          environment.codexPath,
          native,
          environment.apiKeyFile
        );
        readiness.login = 'verified';
      } catch (error) {
        readiness.login = 'failed';
        readiness.error =
          error instanceof CodexSetupError ? error.code : 'login_failed';
        throw error;
      }
      const tokens: Record<string, string> = {};
      const servers = setup.servers.map((server): MCPConfig => {
        if (server.transport === 'stdio') return server;
        const token = server.bearerTokenEnvVar
          ? launch[server.bearerTokenEnvVar]
          : undefined;
        if (server.bearerTokenEnvVar) {
          if (!token) throw fail('mcp_preflight_failed');
          tokens[server.bearerTokenEnvVar] = token;
        }
        return {
          transport: 'http',
          label: server.label,
          serverUrl: server.url,
          ...(token ? { auth: { accessToken: token } } : {}),
        };
      });
      readiness.mcpPreflight = await checkMcpServers(servers);
      if (
        readiness.mcpPreflight.some(
          (server) => server.status !== 'connected' || !server.toolCount
        )
      )
        throw fail('mcp_preflight_failed');
      // Probe even without configured servers: the host tool policy must hold.
      readiness.mcpStatus = await probeAppServerStatus(
        environment.codexPath,
        { ...native, ...tokens },
        setup.servers.map((server) => server.label),
        LINUX_CHATGPT_ABSENT_HOST_SERVERS
      );
      if (readiness.mcpStatus.status !== 'available')
        throw fail('mcp_status_unavailable');
      for (const [index, server] of readiness.mcpStatus.servers.entries()) {
        const configured = setup.servers[index]!;
        const auth =
          configured.transport === 'http' && configured.bearerTokenEnvVar
            ? 'bearerToken'
            : 'unsupported';
        if (!appServerServerReady(server, auth))
          throw fail('mcp_server_not_ready');
      }
      if (
        !readiness.mcpStatus.hostTools.disabled.every(appServerHostToolDisabled)
      )
        throw fail('host_tool_policy_unenforced');
    },
    async dispose() {
      // Owner-checked: remove only the workspace MST created. Scio owns HOME.
      const info = await lstat(workspace).catch(() => undefined);
      if (info?.isDirectory() && info.uid === process.getuid?.())
        await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function privateDirectory(
  path: string,
  code: CodexSetupErrorCode,
  detail?: string
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
    if ((await realpath(path)) !== path) throw new Error();
  } catch {
    throw new CodexSetupError(code, detail);
  }
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new CodexSetupError(code, detail);
}

async function executable(
  path: string,
  code: CodexSetupErrorCode
): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error();
    await access(path, constants.X_OK);
  } catch {
    throw new CodexSetupError(code);
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}
